# `Host` 桥参考

> 摘自 `docs/插件开发指南.md` §7。**与原文冲突时以原文为准。**

沙箱里 `Host` 是你**唯一**的原生能力入口。你拿不到 `@ohos.*` 的任何 Kit，
也没有 `fetch` / `XHR`（被 CORS 挡住）、没有 `document`、没有 Node 风格的 `net` / `dgram` / `tls`。

所有方法**返回 Promise，都要 `await`**。
桥调用**失败会抛异常**（不是返回 `{ok:false}`），所以直接 `try/catch` 或让它冒泡到
`Plugin.register` 的各个钩子里即可。**最常见的失败原因是权限没声明。**

---

## 1. 能力总表

```ts
// ── 网络（需 network）
Host.http(method, url, headers, body)    → Promise<{ status, body, headers, cookies }>
Host.httpForm(url, headers, fields)      → Promise<{ status, body, headers, cookies }>

// ── 私有存储（需 secureStore，按 pluginId 隔离）
Host.secureStore.get(key) / set(key, value) / delete(key)

// ── 加密（需 crypto）
Host.crypto.sha1Hex(s) / sha256Hex(s) / sha256Base64(s)
Host.crypto.sha1BytesBase64(b64) / sha256BytesBase64(b64)   // 字节级，见 §4
Host.crypto.base64ToHex(b64) / hexToBase64(hex)
Host.crypto.hmacSha1(key, s)
Host.crypto.randomBytes(n)      → base64

// ── 日志（需 log）
Host.log.info(tag, msg) / Host.log.error(tag, msg)

// ── 宿主缓存的设备对象，不需要额外权限
Host.getDevice(did) → Device | null

// ── 原始 socket
Host.udp.*   // 需 lan
Host.tcp.*   // 需 lan
Host.tls.*   // 需 mqtt
```

`http` / `httpForm` 的返回值四个字段：

| 字段 | 说明 |
| --- | --- |
| `status` | HTTP 状态码 |
| `body` | 响应体**字符串** |
| `headers` | 响应头，**键名已统一小写** |
| `cookies` | 系统解析好的 Cookie 串 |

宿主**不**替你做 HTTP 状态判断 —— 不同平台的错误语义差别很大
（有的平台把业务错误藏在 `200` 的 body 里）。

---

## 2. `Host.http` / `Host.httpForm`

### `Host.http`

这是你发网络请求的**唯一**方式。好处是它顺带统一了 UA、超时和日志，
排查问题时宿主能把完整请求链导出给你。

> 沙箱里的 `fetch` / `XHR` 会被 CORS 挡住 —— 这也是为什么二维码图片要由宿主去下载。

### `Host.httpForm` —— 🔴 `fields` 必须是**键值对象**

```js
await Host.httpForm(url, headers, { dat: token, sid: 'xxx' });   // ✅ 键值对象，桥负责编码
```

```js
await Host.httpForm(url, headers, 'dat=' + token + '&sid=xxx');  // ❌ 危险
```

不要传编好的表单字符串 —— **字符串会被桥按「字符下标」拆成 `0=d&1=a&2=t...` 乱码**
（v1.0.7 之前米家插件的 401 血案根源）。

（桥也兼容字符串：原样作为请求体，不再编码，但请勿依赖。）

### 🔴 `cookies` 和 `headers` 不是可有可无的

很多平台的登录流程靠 **Cookie 串联** —— 先请求 A 拿到 Cookie，请求 B 必须带上它。
米家就是典型：

```
GET /pass/serviceLogin    → 响应带 Set-Cookie: serviceToken=...
GET /longPolling/loginUrl → 必须带上 serviceToken，否则服务端返回**空响应**
```

少了这一步，服务端**不会报错**，只是给一个不含 `loginUrl` / `qr` / `lp` 的响应，
表现成「二维码出不来」—— **完全看不出是 Cookie 的问题**。

取 Cookie **优先用 `res.cookies`**（SDK 直接解析好的结果），`headers['set-cookie']` 只作兜底：
`set-cookie` 可能是数组、可能被系统合并、老版本宿主还可能不返回 `headers`。

```js
function absorbCookies(res) {
  let raw = res.cookies ? String(res.cookies) : '';
  if (!raw && res.headers) raw = String(res.headers['set-cookie'] || '');
  if (!raw) return;
  // 一个响应可能带多个 Set-Cookie，用「逗号后紧跟 name=」切分
  const parts = raw.split(/,(?=\s*[^=;]+=)/);
  for (const part of parts) {
    const pair = part.split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    // 同名覆盖，保留其余……
  }
}
```

---

## 3. `Host.secureStore`

按 pluginId **隔离**：别的插件读不到你的 key，你也读不到别人的。
隔离靠的是「每个插件一份独立存储实例」，不是 key 前缀 —— 前缀能被猜到，独立实例不能。

### 🔴 读写形状陷阱（真机踩过）

`set(key, value)` 的 value **必须是字符串**；但 `get(key)` 读回来时，
如果当初存的字符串以 `{` 或 `[` 开头，**桥的拆包层会把它 parse 成对象**返回。

```js
await Host.secureStore.set('auth', JSON.stringify(auth));   // 存：字符串

const stored = await Host.secureStore.get('auth');
const data = (typeof stored === 'string') ? JSON.parse(stored) : stored;   // ✅ 两种形状都接
// const data = JSON.parse(stored);                                        // ❌
```

只写 `JSON.parse(stored)` 的后果：对象被 `String()` 成 `"[object Object]"` 再抛语法错误 ——
`init` 静默 `return false`，**登录后家庭 / 设备全空**。

---

## 4. `Host.crypto`

### ⚠️ 没有 `Host.crypto.rc4`

早期草案里写过 `Host.crypto.rc4(keyBase64, dataBase64)`，**这个能力不存在，不要用**。

原因：鸿蒙的系统加密库（`@ohos.security.cryptoFramework`）只提供 AES / 3DES / SM4 / ChaCha20
这类标准算法，**不含 RC4**。宿主没法凭空多出一个系统不支持的算法。

需要 RC4（比如米家的签名流程）就在插件自己的 JS 里实现 —— 标准实现只有十来行：

```js
function rc4(keyBytes, dataBytes) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + keyBytes[i % keyBytes.length]) & 0xff;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }
  const out = new Uint8Array(dataBytes.length);
  let i = 0; j = 0;
  for (let k = 0; k < dataBytes.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    const t = S[i]; S[i] = S[j]; S[j] = t;
    out[k] = dataBytes[k] ^ S[(S[i] + S[j]) & 0xff];
  }
  return out;
}
```

放在插件里其实**更合适**：米家等平台的 RC4 常有变体（丢弃前 N 字节、密钥派生方式不同），
放在宿主反而没法按各家需求定制。

### 字节级摘要与编解码（`BytesBase64` / `base64ToHex`）

RC4 那个例子暴露了一个通用陷阱：米家的签名链路里，**输入往往已经是解码好的原始字节**，
而不是 UTF-8 文本。`ssecurity`、`nonce` 都是 Base64 串，要先把它们解码，拼接**字节**，再摘要。

如果用 `sha256Base64(s)` 直接拼字符串，你算出来的是「Base64 文本的摘要」，
和协议要求完全不同 —— 服务端只会回一个语焉不详的 `401`，很难排查。

| 方法 | 输入 | 输出 | 说明 |
| --- | --- | --- | --- |
| `sha1BytesBase64(b64)` | Base64 二进制 | Base64 二进制 | 字节级 SHA-1 |
| `sha256BytesBase64(b64)` | Base64 二进制 | Base64 二进制 | 字节级 SHA-256 |
| `base64ToHex(b64)` | Base64 | hex 小写 | 纯编码转换，**不需要 crypto 权限** |
| `hexToBase64(hex)` | hex | Base64 | 同上 |

对照米家的 `signedNonce`：

```js
// ❌ 错：把 Base64 文本当字节摘要，结果对不上
const signed = await Host.crypto.sha256Base64(ssecurity + nonce);

// ✅ 对：先各自解码成字节，拼接后再摘要
const a = await Host.crypto.base64ToHex(ssecurity);
const b = await Host.crypto.base64ToHex(nonce);
const signed = await Host.crypto.sha256BytesBase64(
  await Host.crypto.hexToBase64(a + b)
);
```

最后那句看着绕，但它是「把两段字节拼起来」最省事的写法 ——
`hexToBase64` 把拼接后的 hex 重新变成二进制喂给摘要方法。
也可以自己在 JS 里用 `Uint8Array` 拼接，效果一样。

---

## 5. 原始 socket：为什么必须由宿主提供

沙箱里**没有任何原始 socket API**：

- `fetch` / `XHR` 只能走 HTTP，还被 CORS 挡着（所以另开了 `Host.http`）；
- 没有 `dgram` / `net` / `tls` 这类 Node 风格模块；
- WebSocket 是唯一的长连接手段，但**说不了 MQTT、miio 这些私有协议**。

所以凡是「发原始字节 / 收原始字节」的需求，都得由宿主代发。

### UDP（局域网发现与明文控制，如 miio 的 54321）—— 需 `lan`

```ts
const h = await Host.udp.open({ localAddress: '0.0.0.0', localPort: 0 });

// 注册回调：收到报文时被调用，参数是 [dataBase64, host, port]
// ⚠️ 注册必须在 send 之前，否则第一包回得快就会丢
await Host.udp.onMessage(h, (dataB64, host, port) => { /* ... */ });

await Host.udp.send(h, '192.168.1.23', 54321, someBase64);
await Host.udp.close(h);
```

### TCP（局域网内需要连接语义的设备）—— 需 `lan`

```ts
const h = await Host.tcp.open({ host: '192.168.1.23', port: 9999, timeout: 10000 });
await Host.tcp.onMessage(h, (dataB64) => { /* ... */ });
await Host.tcp.onClose(h, () => { /* 断线了，在这里做重连 */ });
await Host.tcp.send(h, someBase64);
await Host.tcp.close(h);
```

### TLS（到公网 broker 的加密长连接，如 MIPS 的 MQTT over TLS）—— 需 `mqtt`

```ts
const h = await Host.tls.open({
  host: 'cn-ha.mqtt.io.mi.com',
  port: 8883,
  clientCert: pemCert,     // 双向认证的客户端证书（PEM）
  clientKey: pemKey,       // 对应私钥（PEM，PKCS#8）
  ca: '',                  // 留空 = 不校验服务端证书链
  timeout: 15000
});
await Host.tls.onMessage(h, (dataB64) => { /* MQTT 报文 */ });
await Host.tls.onClose(h, () => { /* 重连 —— 注意 MQTT 重连后必须重新订阅 */ });
```

### 载荷一律 Base64

跨 JS 边界只能传字符串，而报文是任意二进制。用 Base64 而不是十六进制，
因为二进制协议里 hex 会让数据量白白翻倍：

```js
// 发：Uint8Array → base64
function toB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
// 收：base64 → Uint8Array
function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
```

⚠️ **别用 `TextEncoder` / `TextDecoder` 处理收发到的字节**：报文是**任意二进制**，
走 UTF-8 编解码会在非 ASCII 字节上直接损坏数据。只用 `atob` / `btoa`。

### 回调是怎么被调起来的

桥上的「回调」是**方向相反**的调用：宿主收到报文后，通过 `webController.runJavaScript`
往沙箱里推。因为函数没法穿过 JSON 序列化的边界，宿主记的是**回调名**，
沙箱侧由 bootstrap 维护注册表（`cb_1` / `cb_2` …）。

对你是透明的，但有一个必须知道的：**回调注册表在页面重建后会清空**。
宿主在 Web 重建时会重新注入 bootstrap，届时旧的注册名就失效了 ——
所以**插件在 `init()` 里重新注册一遍回调是必要的**（别只在模块顶层注册一次）。

### 三个必须知道的边界

1. **TCP 是流，不是消息**。`onMessage` 的每一次回调**不代表一个完整报文** ——
   TCP 会任意切包、也会粘包。协议解析必须自己攒缓冲区。
   UDP 相反，一次回调就是完整一包。
2. **连接归插件所有，但要显式关**。插件被停用/卸载时宿主会替你收掉全部 socket，
   但正常使用中请自己 `close` —— socket 是稀缺资源，开着不放会占端口。
3. **`tls` 的 `ca` 留空意味着不校验服务端身份**。这对使用私有 CA 的 broker 是必需的，
   但确实是安全折衷。需要严格校验时把 CA 的 PEM 传进来。

---

## 6. 桥的形态说明（可以跳过）

你看到的 `Host.secureStore.get(...)` 是**嵌套对象**，但底层注入到 ArkWeb 的是
扁平方法（`Host.secureStore_get`）。这层缝合由宿主在 bootstrap 脚本里完成，对你无感。

`runJavaScript` 的返回值在部分内核上会被**再包一层引号**，宿主用
`normalizeJsResult()` 统一剥壳。如果你在真机日志里看到
`插件 xxx 未成功注册: "yes"`（**值带引号**），**那是宿主侧的解析容错问题，不是插件的问题**。
