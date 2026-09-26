# miha 插件协议参考（协议 v1）

> 摘自 `docs/插件开发指南.md`。**与原文冲突时以原文为准** —— 这一份是速查，可能落后于宿主实现。

---

## 1. `plugin.json` 全字段

```jsonc
{
  "schemaVersion": 1,
  "id": "com.example.myplatform",     // 全局唯一，建议反向域名
  "name": "我的平台",                  // 显示在插件卡片上
  "version": "1.0.0",                 // semver
  "runtime": "js",                    // "js"（有代码）| "declarative"（纯 JSON，见 §7）
  "entry": "main.js",
  "hostMinVersion": "2.0.0",          // 要求的**宿主协议**版本（semver 文本），见 §6
  "minAppVersionCode": 0,             // 要求的**应用构建号**（JSON number）；0 / 不写 = 不校验，见 §6
  "description": "一句话说明",
  "author": "you",
  "homepage": "https://github.com/you/repo",
  "license": "MIT",

  "permissions": ["network", "secureStore", "crypto"],   // 见 §2
  "login": { "type": "qr" },                              // qr | web | form，见 §4；不写 = 不需要登录
  "settings": {                                           // items 非空才有「设置」按钮，见 §9
    "title": "我的插件设置",
    "items": [
      { "key": "server", "type": "text", "label": "服务器地址", "default": "" }
    ]
  },
  "capabilities": {                                       // 宿主据此显示/隐藏入口
    "homes": true,
    "devices": true,
    "scenes": false,
    "spec": false,
    "statistics": false,
    "messages": false,
    "consumables": false,
    "lanControl": false,
    "gatewayControl": false,
    "stream": false,                                      // 摄像头实时取流
    "gatewayAdmin": false                                 // 网关局域网管理面
  },
  "update": {
    "source": "github",                 // github | url | none
    "repo": "you/repo",                 // source=github 时
    "assetPattern": ".*\\.zip$"
  }
}
```

### 宿主实现状态（写文档时的快照）

| 能力 | 状态 |
| --- | --- |
| 插件安装（直链 / GitHub Release / 本地 zip / 内置示例） | ✅ |
| JS 沙箱 + Host 桥（network / secureStore / crypto / log） | ✅，待真机验证 |
| 插件卡片、启用/停用、卸载、权限确认 | ✅ |
| `Host.getDevice` | ✅ |
| 登录视图渲染（`qr` / `web` / `form`） | ✅，待真机验证 |
| `lan` / `mqtt` 桥（`Host.udp` / `tcp` / `tls`） | ✅，待真机验证 |
| 摄像头取流（`stream`）+ 网关局域网管理（`gatewayAdmin`） | ✅，真机已跑通 |
| L0 声明式引擎（`runtime: "declarative"`） | ⏳ **未实现** |

---

## 2. 权限（`permissions`）

安装时宿主逐条展示给用户，用户确认后插件才被注册。

| 权限 | 你能做什么 | 不给会怎样 |
| --- | --- | --- |
| `network` | `Host.http()` 发任意 HTTP(S) | 一切云 API 都不可用 |
| `secureStore` | 读写**本插件私有**的凭据区 | 无法保存 token，每次启动都要重新登录 |
| `crypto` | 原生 SHA1/SHA256/HMAC/随机数 | 只能 JS 自实现（慢且容易写错） |
| `lan` | `Host.udp` / `Host.tcp` 直连局域网设备 | 无法做局域网发现/控制 |
| `mqtt` | `Host.tls` 长连接（含客户端证书） | 无法连公网 broker |
| `log` | 写入宿主的反馈日志 | 出问题时无法排查 |

- `secureStore` 按 **pluginId 隔离**：别的插件读不到你的 key，反之亦然。
  隔离靠「每插件一份独立存储实例」，不是 key 前缀（前缀能被猜到）。
- ⚠️ **桥上的权限判定发生在每一次调用**，不是安装时一次性放行。
  声明了没授权就等于没有；`plugin.permissions` 是清单投影。

---

## 3. 生命周期钩子

宿主加载 `main.js` 后，约定全局对象 `Plugin`：

```js
Plugin.register({
  async init(ctx) { /* 返回 true = 已连接可用；false = 需要登录 */ },

  async loginBegin()                    { /* → { sessionId, view } */ },
  async loginPoll(sessionId)            { /* → { state, ... } */ },
  async loginSubmit(sessionId, fields)  { /* → { state, ... } */ },
  async loginCancel(sessionId)          { /* → { state: 'cancelled' } */ },

  async getHomes() { /* ... */ },
  async getDevices(homeIds) { /* ... */ },

  async dispose() { /* 断开长连接、停掉定时器 */ }
});
```

`ctx` 里带：`pluginId`、`dataDir`（本插件私有沙箱目录）、`hostVersion`、`locale`。

### 必须知道的执行环境事实

**① `init()` 可能比你以为的晚得多才被调用，而且页面切换时会重来。**

插件跑在 ArkWeb 沙箱里，沙箱的宿主是页面里一个**零尺寸、不可见的 `Web` 组件**。
只有挂着那个组件的页面活着，插件才可能被加载。宿主为此抽了 `PluginSandboxHost` 组件，
挂在需要用到插件的页面上（「数据源与插件」页和首页）。

> 真机自锁 bug 的成因：冷启动路由发现「有已启用的插件」→ 直接进首页（跳过插件页）
> → 插件页从未加载 → 沙箱从未 attach → `connect()` 一律失败 → 插件永远显示「未连接」。

对插件作者的影响：**`init()` 要幂等**，别把状态放在模块级变量里指望它跨页面存活。

**② 宿主桥要跨两轮页面加载才可用。**

```
第 1 轮 onPageEnd   装配 controller / bridge → registerJavaScriptProxy → 主动重载页面
                    ✗ 此时 window.Host 还不存在，不能 bootstrap
第 2 轮 onPageEnd   代理才真正出现在 JS 上下文 → bootstrap 缝合命名空间
                    → 成功后 autoConnectAll()（才开始加载插件）
```

所以：从「页面开始加载」到「`init()` 能被调用」中间隔了**两次页面加载**。
如果 `init()` 里第一次调 `Host.http` 就报 `undefined`，先怀疑桥还没到第 2 轮，而不是插件写错了。
日志里搜 **`[PluginSandbox] 宿主桥就绪`** —— 出现它才代表能用。

**③ 沙箱会被 ArkUI 重建 —— 弹窗也会触发。**

打开登录半模态面板就会导致重建。如果一次插件调用横跨了重建，那次调用就会失败
（宿主会回一句「插件运行环境正在重建，请重试」，重试即可，通常几百毫秒内恢复）。

**④ 回调注册表在页面重建后会清空。**

socket 回调必须写在 `init()` 里，不能只在模块顶层注册一次。

---

## 4. 登录协议

登录是**有状态会话**，不是纯函数。原因：很多二维码流程里「生成二维码」和「轮询结果」
必须共用同一组随机参数（设备 ID、cookie、UA），拆成两个无状态请求直接失败。

```
宿主 → 插件                                    插件 → 宿主
{ op: "login.begin" }                        → { sessionId, view }
{ op: "login.poll",   sessionId }            → { state, ... }
{ op: "login.submit", sessionId, fields }    → { state, ... }
{ op: "login.cancel", sessionId }            → { state: "cancelled" }
```

`state` 取值：`pending` / `success` / `expired` / `error` / `cancelled`。

### 分工

| 谁 | 负责什么 |
| --- | --- |
| **你（插件）** | `loginBegin` 返回**视图数据**，并实现 `loginPoll` / `loginSubmit` / `loginCancel` |
| **宿主** | 画界面、起轮询定时器、跑倒计时、开 Web 视图、拦回调 URL、收表单值 |
| **你自己** | 凭据存取（`Host.secureStore`），宿主不碰也看不见 |

登录成功后宿主只知道 `state === 'success'`，然后把卡片状态翻成「已连接」。
**刷新令牌也由你自己管**：宿主在每次调用数据面方法前会调 `init()`，你可以在里面判断过期并静默刷新。

### `qr` 视图

```js
async loginBegin() {
  const s = newSession();
  const ticket = await buildQrTicket(s);
  sessions.set(s.id, s);                      // ⚠️ 会话必须自己存
  return {
    sessionId: s.id,
    view: {
      type: 'qr',
      imageUrl: ticket.qrUrl,     // 或 imageDataUri（base64 png / data: URI）
      hint: '请用平台 App 扫码',
      expiresIn: 180,             // 秒，宿主倒计时并在归零时判 expired
      pollInterval: 1000          // 毫秒
    }
  };
}

async loginPoll(sessionId) {
  const s = sessions.get(sessionId);          // ⚠️ 只能从这里拿会话
  const r = await pollOnce(s);
  if (r.pending) return { state: 'pending' }; // ⚠️ 排队态不要抛错
  await Host.secureStore.set('auth', JSON.stringify(r.credential));
  return { state: 'success' };
}
```

**三个会静默出错的细节**：

1. `pollInterval` 必须 **> 0**。宿主只在 `pollInterval > 0` 时才起轮询。
   省略或写 0 = 完全不轮询，二维码挂着永远不被处理，用户扫了也没反应，**且没有报错**。
2. `loginPoll` **只收到 `sessionId`**，没有第二个参数。轮询地址、会话对象必须存在插件自己的状态里。
3. 「还没扫」返回 `state: 'pending'`，**不要抛错**。宿主连续 3 次失败就判登录失败并关弹窗
   （`consecutiveErrors >= 3`）。长轮询超时、网络抖动一律按 `pending` 返回。
   真正该报错的是「二维码过期」→ `expired`，或凭据不合法 → `error`。

### `web` 视图（OAuth）

```js
async loginBegin() {
  return {
    sessionId: s.id,
    view: {
      type: 'web',
      url: 'https://.../oauth/authorize?client_id=...&redirect_uri=...',
      stopPrefixes: ['myapp://oauth/callback']   // 宿主拦到这个前缀就交回给你
    }
  };
}

async loginSubmit(sessionId, fields) {
  const code = new URL(fields.callbackUrl).searchParams.get('code');
  const token = await exchangeToken(code);
  await Host.secureStore.set('auth', JSON.stringify(token));
  return { state: 'success' };
}
```

`stopPrefixes` 是**前缀匹配**不是全等（授权回调通常带一长串 query）。

### `form` 视图

```js
view: {
  type: 'form',
  fields: [
    { key: 'host',     label: '服务器地址', type: 'text', placeholder: 'http://192.168.1.10:8123' },
    { key: 'token',    label: '长期访问令牌', type: 'password' },
    { key: 'remember', label: '记住', type: 'switch', default: true }
  ],
  submitLabel: '连接'
}
```

宿主按 `fields` 渲染**原生**输入框（不是网页），用户提交后调 `loginSubmit(sessionId, {...})`。

- 字段类型只有 `text` / `password` / `switch`；未知类型当 `text`，不报错。
- **所有表单值都是字符串**：`switch` 传 `'true'` / `'false'`。
- **不要写 `login` 字段** = 本插件不需要凭据。写了但没实现，卡片上会出现一个点开是空表单的「登录」按钮。

---

## 5. 数据面

一律**异步**。返回值必须是 **JSON 可序列化**的普通对象/数组（跨 JS 边界只能是 JSON）。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `getHomes()` | `() → Home[]` | 家庭/房间分组的顶层容器 |
| `getDevices(homeIds?)` | `(string[]?) → Record<did, Device>` | **key 必须是 did** |
| `getScenes(homeId)` | `(string) → Scene[]` | 云端场景/自动化 |
| `runScene(sceneId, homeId)` | `(string, string) → Result` | 触发场景 |
| `getSpecForDevice(device)` | `(Device) → MIoTSpec \| null` | 设备能力描述 |
| `createTransports(device)` | `(Device) → TransportHandle[]` | 控制通道 |
| `getStatistics(did, key, type, limit, from, to)` | → `Object[]` | 历史数据 |
| `checkMessages(beginAt?)` / `getMessageList(homeId)` | → `MessageItem[]` | 通知消息 |
| `getConsumableItems(homeId)` | → `ConsumableItem[]` | 耗材（滤芯、电量等） |
| `getStreamUrl(device)` | → `{url, kind, expiresIn, source}` | 摄像头取流，需 `stream` |
| `saveStreamUrl(device, url)` / `clearStreamUrl(device)` | | 手动直播地址的存/清，需 `stream` |
| `gatewayInfo / gatewayLogin / gatewayForget / gatewayClients / gatewaySetBlocked / gatewayReboot` | | 网关局域网管理，需 `gatewayAdmin` |

### 5.1 `Device` 形状（必须与宿主一致）

> ⚠️ **字段名用的是「米家原始命名」，不是驼峰。** 宿主直接跑 `HomeModels.parseDevice`，
> 逐字段读的就是下面这些键。写成 `homeId` / `online` / `localIp` 这类驼峰名**不会报错**，
> 只会静默变成空字符串 —— 界面上表现为「设备没有房间、显示离线、图标不对」，极难定位。

```ts
{
  did: string,          // 平台内唯一 ID（必需）
  name: string,         // 显示名
  model: string,        // 型号，宿主据此猜图标
  spec_type: string,    // → urn：能力描述标识
  room_id: string,      // → roomId
  room_name: string,    // → roomName
  home_id: string,      // → homeId
  home_name: string,    // → homeName
  isOnline: boolean,    // → online（注意是这个拼法，不是 online）
  token: string,        // 局域网控制密钥
  local_ip: string,     // → localIp
  parent_id: string,    // → parentId（子设备填网关 did）
  uid: string, pid: string, icon: string,
  group_id: string, ssid: string, bssid: string,
  orderTime: number, rssi: number,
  extra: { fw_version: string }        // → fwVersion
}
```

**这不是巧合，是刻意的**：宿主把 `parseDevice` 设计成接米家原字段，就是为了让插件能把
**云端返回的设备对象原样透传**，两边不用各维护一套映射（映射表是 bug 温床）。
米家体系直接递云端对象即可；非米家平台自己往这个形状上凑 —— 缺字段不要紧（只是空值），
**名字写错就是静默失效**。

### 5.2 `Home` / `Room` 形状

```ts
Home: { id, name, uid, dids: string[], roomlist: Room[],
        city_id, longitude, latitude, address }
Room: { id, name, dids: string[] }
```

> ⚠️ 早期样例里写过 `roomIds` / `deviceIds`（看起来更语义化），结果宿主解析出来是个空家庭。
> **协议字段名不是随便起的，宿主不会猜。**

### 5.3 设备能力（`getSpecForDevice`）

宿主内置 **MIoT 规范**解析器（`siid` / `piid` 属性与动作模型）。
是 MIoT 体系就直接返回 spec，宿主的详情页、控制面板全部自动可用。

不是 MIoT（比如 HA 的 entity 模型），两条路：

1. **翻译成 MIoT**（推荐）：把 entity 映射成 `siid=1` 下的若干 `piid`，宿主 UI 直接复用。
2. **返回 `null`**：宿主降级为「开关 + 详情」的简化卡片，你把开关读写接到 `createTransports()` 上。
   功能少，但一天能做完。

⚠️ 返回 `null` 的前提是 `capabilities.spec` 是 `false`。声明 `true` 却返回 `null`，
宿主按「拿到空 spec」处理并报错。

### 5.4 控制通道（`createTransports`）

```js
async createTransports(device) {
  return [
    { id: 'cloud', kind: 'cloud', priority: 100 },   // priority 小的先试
    { id: 'lan',   kind: 'lan',   priority: 10  }
  ];
}

// 宿主随后按顺序调用：
//   getProperties(device, [{siid, piid}]) → [{siid, piid, value}]
//   setProperty(device, siid, piid, value)
//   callAction(device, siid, aiid, inList)
```

通道项形状是 `{id, kind, priority}`：

- `id`：宿主之后用它回调 `getProperty` / `setProperty`，插件据此知道走哪条路
- `kind`：只用于日志与排查，宿主不解释它
- `priority`：**小的先试**

⚠️ **宿主对写操作的规则**：写操作**只在第一条可用通道上执行一次，失败不重试**。
因为局域网超时往往只是回包丢了、设备其实已经执行了 —— 再往云端重发一次就是重复开灯。
**所以 `priority` 的顺序是你的责任**：把最快、最可靠的那条通道放最前。

⚠️ 写失败必须 **throw**。返回 `false` / `undefined` 会被宿主当成「写成功」，
界面显示「已打开」而设备没动。

**可选钩子 `isTransportAvailable(transportId, device?)`**：每条通道发起调用前宿主会问一次。
不实现就按「可用」处理，让真正的调用去失败 —— 反过来（默认不可用）会让没实现它的插件
彻底点不动设备，而那类失败在日志里只剩一句「跳过传输通道 xxx」，极难归因。
想省一次注定失败的外呼（比如局域网通道发现设备不在线）再实现它。

### 5.5 摄像头取流（`stream` 能力）

声明 `"capabilities": { "stream": true }` 后，摄像头设备的详情页会显示直播入口。
三条钩子，只有第一条必需：

```js
async getStreamUrl(device) {
  return {
    url: 'https://.../index.m3u8',   // 必需；空串宿主会当错误处理
    kind: 'hls',                     // hls | rtsp | unknown（缺省按 hls）
    expiresIn: 600,                  // 地址预计有效期（秒）；0 = 未知
    source: 'cloud'                  // cloud = 云端短时效地址；manual = 用户手填
  };
},

async saveStreamUrl(device, url) {
  this.manualUrl[device.did] = url;
  delete this.streamCache[device.did];   // 🔴 必须作废云端地址缓存，否则改了也不生效
},

async clearStreamUrl(device) {
  delete this.manualUrl[device.did];
}
```

设计理由：

- **`expiresIn` 别瞎编**。播放页靠它决定「还有多久该主动刷新地址」。
  短时效流地址普遍几分钟到半小时失效，从设备属性读得到 `expiration-time` 之类就透传，
  读不到才给 `0`（页面按固定节拍保守刷新）。硬编码一个大数字必然在某个机型上黑屏。
- **`source` 是给话术用的**。手动地址播不动该提示「检查地址和设备」，云端地址过期才提示「正在重取」。
  缺省按 `cloud` 算（老版本插件不回这个字段）。
- **取不到流是常态，不是 bug**。实测量产摄像头里只有少数机型暴露可直连的 HLS 流，
  大量机型只有私有 P2P 协议或干脆没有云播服务。**对没能力的机型抛错就是正确行为**，
  宿主会向用户分档解释；**千万不要返回一个凑数的地址**，那只会换来播不动后的无限转圈。

### 5.6 网关局域网管理面（`gatewayAdmin` 能力）

`gatewayControl` 管的是「网关下的子设备怎么控制」；`gatewayAdmin` 管的是
「网关（路由器）本身」—— 状态看板、终端列表、拉黑、重启。声明后路由器类设备的详情页出现管理入口。

宿主把六个钩子包成一个**无状态**的管理面对象，会话（stok 之类）由你在插件内部持有，
页面每次进来重建管理面也不会丢登录态：

```js
async gatewayInfo(device) {
  // → { model, firmware, routerDid, bound, loggedIn, onlineClients,
  //     uptimeSeconds, cpuPercent, memoryPercent, temperature,
  //     downloadSpeed, uploadSpeed }      读不到的数值给 -1，不要给 null
},
async gatewayLogin(device, password) { /* 拿会话凭据，存插件私有区 */ },
async gatewayForget(device) { /* 清掉保存的网关密码 */ },
async gatewayClients(device) {
  // → [{ mac, ip, name, online, blocked, downloadSpeed, uploadSpeed, onlineSeconds }]
  // 🔴 blocked 在各家固件里原始字段不一致，必须归一化成布尔再返回
},
async gatewaySetBlocked(device, mac, blocked) { /* 拉黑 / 解除拉黑 */ },
async gatewayReboot(device) { /* 重启网关 */ }
```

形状错误的代价是**静默空白**：数值字段必须是数字（读不到给 `-1`），`blocked` 必须是布尔。
宿主用 `routerDid` 把管理面和设备列表里的路由器对齐，拿不到给空串的话，用户就看不出「正在管哪一台」。

---

## 6. 版本协商（两条独立的线）

宿主在**展示卡片**和**连接插件**时各校一遍，任一不满足就把卡片标成「不兼容」并给出可读提示，
**不会**让应用崩溃 —— 用户的设备列表仍然从缓存里读，不会白屏。

| 字段 | 比的是什么 | 缺省 | 什么时候用它 |
| --- | --- | --- | --- |
| `hostMinVersion` | **宿主协议版本**（semver 文本，比前三位数字） | `1.0.0` | 你用了某个只有新版宿主才有的**桥 / 钩子 / 能力**时 |
| `minAppVersionCode` | **应用构建号**（`AppScope/app.json5` 的 `versionCode`，纯整数） | `0` = **不校验** | 你依赖某个只有特定构建才有的**原生行为**时 |

```jsonc
{
  "hostMinVersion": "2.0.0",       // 要求宿主协议 ≥ 2.0.0
  "minAppVersionCode": 1000160     // 要求应用构建号 ≥ 1000160；不写 = 不校验
}
```

关于 `minAppVersionCode` 有**三点**必须记住：

1. **不写、写 `0`、或写成非数字，一律等于不校验。** 宿主只接受真正的 JSON number ——
   `"1000000"`（带引号）会被当成「没写」，而不是「要校验 1000000」。
   这么设计是因为失败模式：一个手滑写成字符串的值若被硬转成 0，插件作者会以为自己在卡版本、
   实际什么都没卡，而且**永远不会有人发现**。
2. **应用版本号读不出来时（系统调用失败），宿主不会卡任何插件** —— 拿不到就退回「不知道」，
   而不是「版本极低」。否则一次偶发失败会把所有插件一次性判成不兼容，用户什么都没法用
   还看不出原因。
3. `hostMinVersion` 在**解析清单时**就会抛错（清单非法，插件根本装不进）；
   `minAppVersionCode` 只影响**卡片状态**（装得进去、看得见、连不上），
   因为「应用版本偏低」可以靠升级应用解决，不该阻止插件被安装。

> 两者都只是**声明**：写高了老用户装不上，写低了插件会在运行时莫名失败。
> 经验做法 —— `hostMinVersion` 跟着你实际用到的桥的能力走；`minAppVersionCode` 几乎都写 `0`，
> 只在确有必要时（例如依赖某个后加的原生桥）才填宿主发布时告诉你的构建号。

---

## 7. L0：声明式插件（无代码）

> ⏳ **宿主尚未实现此引擎。** 下面只是规划形态，别真的交付这类插件。

如果平台就是「REST + 固定签名算法 + JSON」，可以不写一行 JS：
`runtime: "declarative"`，把端点写进 `plugin.json` 的 `flows` 里，宿主用内置引擎解释执行。

```jsonc
{
  "runtime": "declarative",
  "auth": { "type": "bearer", "tokenFrom": "secureStore:token" },
  "signer": "hmac-sha256",          // 宿主内置：none | hmac-sha1 | hmac-sha256 | md5-sorted
  "flows": {
    "getHomes":  { "method": "GET",  "url": "{base}/v1/homes", "resultPath": "data.homes" },
    "getDevices":{ "method": "GET",  "url": "{base}/v1/devices",
                   "mapping": { "did": "id", "name": "nickname", "model": "product_id" } }
  }
}
```

**限制**：做不到有状态登录（只能 `bearer` / `basic` / 静态 header）、做不到二进制协议、
做不到 MQTT。遇到这些就升级到 `runtime: "js"`。

---

## 8. 发布

### GitHub Release（推荐）

1. 打 tag `v1.0.0`（必须与 `plugin.json` 的 `version` 一致，**不带 `v` 也行，宿主会自动去掉**）
2. 把 `my-platform-1.0.0.zip` 作为 release asset 上传
3. 可选：同名 `.sha256` 文件，宿主会校验

用户在应用里粘贴 `https://github.com/you/repo` 即可安装，宿主读 `releases/latest` 并按
`assetPattern` 匹配。

⚠️ GitHub 未认证 API 限流 **60 次/小时/IP**。用户装不上时，让他改用直链。

### 直链

直接给 zip 的 HTTPS 直链也行（自建服务器、对象存储）。同样的 zip 格式。

### 签名（⏳ 尚未实现）

规划中：zip 里放 `plugin.sig`（对 `plugin.json` + `main.js` 的 Ed25519 签名），
manifest 里填 `publicKey`；宿主默认只自动信任内置白名单仓库的插件，其余弹「未签名插件」警告。

**现实情况**：现在**任何**来源的插件装上后都走同一套「展示权限 → 用户确认 → 启用」流程，
没有额外的签名门槛。因此**只装你信得过的来源**。别在插件里填 `publicKey` —— 
宿主目前会忽略它，填了不会报错，也不会更安全。

---

## 9. 插件设置（`settings`）

在 `plugin.json` 里**声明**一个设置界面，宿主用**原生控件**把它画出来。
你不写任何 UI 代码 —— 给的是**数据**（标题 / 默认值 / 选项），和登录视图（§4）同一套思路。
想要完全自由的界面请走数据面，不属于设置。

**判据是 `items` 非空**：空数组、整段缺失都等价于「没有设置界面」，
卡片上**不会**出现「设置」按钮。（和 `login` 一样是加法，不是承诺。）

```jsonc
{
  "settings": {
    "title": "HA 看板设置",           // 缺省时宿主用「插件设置」
    "items": [
      { "key": "server",       "type": "text",     "label": "服务器地址",
        "default": "", "placeholder": "http://homeassistant.local:8123" },
      { "key": "token",        "type": "password", "label": "长期令牌" },
      { "key": "maxEntities",  "type": "number",   "label": "最多显示实体数",
        "default": "100", "description": "实体太多时可在这里限制数量" },
      { "key": "autoRefresh",  "type": "switch",   "label": "自动刷新", "default": "false" },
      { "key": "entityFilter", "type": "select",   "label": "显示范围", "default": "all",
        "options": [ { "value": "all", "label": "全部" }, { "value": "light", "label": "仅灯" } ] },
      { "key": "testConn",     "type": "button",   "label": "测试连接", "action": "test" }
    ]
  }
}
```

### 9.1 六种控件

| `type` | 渲染成 | 存储形态 | 备注 |
| --- | --- | --- | --- |
| `text` | 单行输入框 | 任意字符串 | **未知 `type` 一律退化成它** |
| `password` | 遮蔽输入框 | 任意字符串 | 只是遮蔽，**不加密存储**；敏感凭据请走 `secureStore` |
| `number` | 数字软键盘输入框 | 十进制文本 | 不做数值校验 |
| `switch` | 开关 | `'true'` / `'false'` | 判断写 `v === 'true'` |
| `select` | 下拉选择 | 选中项的 `value` | `options` 缺失/为空时**退化成 `text`** |
| `button` | 按钮 | **不占存储** | 点击回调 `onSettingsAction`，见 §9.3 |

条目字段：

| 字段 | 适用 | 说明 |
| --- | --- | --- |
| `key` | 全部（**必填**） | 存值用的键；`button` 时也作动作标识。**没有 `key` 的条目会被丢掉** |
| `type` | 全部 | 见上表；协议外的值退化成 `text` |
| `label` | 全部 | 显示标题；缺省时用 `key` |
| `placeholder` | text / password / number | 输入框占位提示 |
| `description` | 全部 | 控件下方的说明文字 |
| `default` | 除 `button` 外 | 初值（**字符串形态**） |
| `options` | select | `[{ value, label }]`；**没有 `value` 的选项会被丢掉** |
| `action` | button | 回调时带的动作标识；缺省时用 `key` |

> **所有值都是字符串。** 开关是 `'true'` / `'false'`，数字是十进制文本 ——
> 跨 ArkWeb 边界只能传字符串，「你在输入框里看到的」和「插件读到的」是同一个东西。
>
> **容错方向**：设置是「有更好、没有也能用」的附加能力，所以认不出来的东西
> **不报错、不渲染**。绝不因为一段设置写错就拒绝加载整个插件。

### 9.2 插件侧读取（**只读**）

```js
const server = await Host.settings.get('server');   // 键不存在给空串，不抛错
const all    = await Host.settings.all();           // 键值**对象**，不是 JSON 串
const max    = Number(all.maxEntities || '100');
const auto   = all.autoRefresh === 'true';
```

宿主设置面板是**唯一的写入方**。插件改了不生效 —— 需要「改完立刻响应」用下面的钩子。

> ⚠️ `Host.settings.all()` 的结果以 `{` 开头，会被桥的拆包层 parse 成**对象**返回。
> **别再套一层 `JSON.parse`** —— 对象会被 `String()` 成 `[object Object]` 再抛语法错误，
> 而 `init` 惯于吞异常，表现成「插件莫名没连上」。铁律 8 说的就是这个坑。

> 与 `secureStore` 的分工：这里存的是**用户配置**（插件只读、宿主 UI 写）；
> `secureStore` 存的是**插件凭据**（插件自己读写、用户看不到）。分开存，
> 「用户可以删的」和「用户不应该碰到」的两类数据才各自安全。

### 9.3 两个可选钩子

| 时机 | 宿主调什么 | 参数 |
| --- | --- | --- |
| 点「保存」 | `onSettingsChanged(values)` | **全量**键值对象 |
| 点「恢复默认」 | `onSettingsChanged({})` | **空对象**（存储已清空） |
| 点某个动作按钮 | `onSettingsAction(action, values)` | 动作标识 + 全量键值对象 |

```js
Plugin.register({
  // ……其余钩子……

  // 保存 / 重置之后调用；values 是「声明 default ⊕ 用户已存值」的全量结果。
  // 宿主**不会**因为你改了设置就重连插件（重连会断掉正在跑的会话），
  // 需要立刻生效就在这里自己重读。
  async onSettingsChanged(values) {
    this.server = values.server || '';
    await Host.log.info('myplugin', '设置已更新');
  },

  // 动作按钮。返回 { message } 会显示在面板底部给用户看 ——
  // 这是插件对用户说话的通道（插件没有自己的界面）。抛错同样会把错误文本显示出来。
  async onSettingsAction(action, values) {
    if (action !== 'test') return { message: '未知操作：' + action };
    const res = await Host.http('GET', values.server + '/api/', { ... });
    return { message: res.status === 200 ? '连接成功' : ('失败：HTTP ' + res.status) };
  }
});
```

两个钩子都**可以不实现**（宿主会静默跳过）。但**声明了 `button` 就必须实现
`onSettingsAction`**，否则用户点了只会看到报错。

> `onSettingsChanged` 给的是**全量**而不是 diff：用户可能一次改多项，
> 而插件往往需要读到完整配置才能安全地重新初始化。重置时传空对象，
> 是为了让插件能区分「用户清空了」和「用户把某项改回了默认值」。
