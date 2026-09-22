/*
 * 米家云插件（JS 实现）
 *
 * 这是宿主 `cloud/MijiaApiClient.ets` + `oauth/MijiaQrLoginService.ets` +
 * `utils/MijiaCrypto.ets` 的 JS 对照实现，用来验证 P4「把米家搬进插件」
 * 这条路线可行。
 *
 * ## ⚠️ 这个文件必须自包含 —— 不能拆成多个 .js
 *
 * 宿主只读取 `plugin.json` 的 `entry` **一个文件**，把它的内容原样
 * 塞进一个 IIFE 里用 `runJavaScript` 执行（见 `PluginSandbox.wrapSource`）。
 * 所以：
 *   - `import` / `export` 会直接抛语法错误 —— 那不是 ES Module 环境
 *   - 拆出去的 `crypto.js` 孤儿文件**不会被加载**
 *   - 所有辅助函数都留在这个文件的闭包里
 *
 * ## 三处最容易写错的地方（都踩过或推演过）
 *
 * 1. **签名输入是字节不是文本**：`signedNonce = sha256(ssecurity字节 ++ nonce字节)`。
 *    写成 `sha256Base64(ssecurity + nonce)` 算的是 Base64 文本的摘要，
 *    服务端回 401 且不说原因。
 *
 * 2. **参数拼接顺序**：`rc4_hash__` 必须排在原始参数**之后**、
 *    加密前；`signature` 是明文追加的（不参与加密）。
 *
 * 3. **RC4 丢弃前 1024 字节**（不是 256、不是 0）。
 *
 * ## 待真机验证
 *
 * 本插件**没有经过真机联调**（开发环境无米家设备）。
 * 出问题时按这个顺序查：签名算法 → 请求头 Cookie → 接口路径 → 响应解密。
 * 见 `docs/MIPS控制通道.md` 的「待真机验证」表。
 */

/* ================================================================ 配置 */

const ACCOUNT_HOST = 'https://account.xiaomi.com';
const API_HOST = 'https://api.mijia.tech/app';

/**
 * 摄像头业务专用网关。抓包实测存在，米家 App 把摄像头业务单开了一个域名，
 * 请求还会带 `miot-request-model: <设备 model>` 头指向具体机型。
 *
 * 目前只用在**诊断**路径上（探测 P2P 取流链路），没有接进任何功能路径 ——
 * 换句话说，它不通也不会影响现有功能。
 */
const CAMERA_GATEWAY = 'https://app.business.smartcamera.api.mijia.tech';

const LOCALE = 'zh_CN';

/** 米家 App 的 User-Agent 形态。服务端会看它决定返回哪套接口，别乱改 */
const UA_PREFIX = 'Android-15-11.0.701-Xiaomi-23046RP50C-OS2.0.212.0.VMYCNXM';

/* ================================================================ 运行态 */

let auth = null;          // 凭据，从 secureStore 载入
let deviceId = '';        // 设备指纹，登录时生成、之后固定
let passO = '';           // UA 里要用的一个随机段，同样固定
let userAgent = '';
let cookieJar = '';       // 登录期的 cookie（登录完就没用了）
let pendingLp = '';       // 当前登录会话的长轮询地址

/**
 * 轮询间隔。宿主只在 `pollInterval > 0` 时才起轮询
 * （见 `PluginManager.beginLogin`），写 0 或省略 = 永远不轮询、
 * 二维码挂在那儿没人扫，是很容易踩的坑。
 *
 * 3000ms 是折中：米家的 `lp` 是**长轮询**（服务端挂住直到有结果或超时），
 * 所以这个值主要决定「超时后多久重试」，不需要太密。
 */
const POLL_INTERVAL_MS = 3000;

/** 二维码有效期，宿主拿它起倒计时。米家的 ticket 通常是几分钟 */
const QR_EXPIRES_SECONDS = 300;

/* ================================================================ 编解码 */

function hexToBytes(hex) {
  const clean = String(hex || '').trim();
  if (clean.length === 0) return new Uint8Array(0);
  const padded = clean.length % 2 === 1 ? '0' + clean : clean;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16) & 0xff;
  }
  return out;
}

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    out += h.length === 1 ? '0' + h : h;
  }
  return out;
}

function utf8Bytes(s) {
  const str = String(s == null ? '' : s);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const escaped = unescape(encodeURIComponent(str));
  const out = new Uint8Array(escaped.length);
  for (let i = 0; i < escaped.length; i++) out[i] = escaped.charCodeAt(i) & 0xff;
  return out;
}

function bytesToUtf8(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return decodeURIComponent(escape(s));
}

/** Base64 → 字节。经宿主 `base64ToHex` 转一手，避免各插件各写一遍解码 */
async function b64ToBytes(b64) {
  return hexToBytes(await Host.crypto.base64ToHex(b64));
}

/** 字节 → Base64 */
async function bytesToB64(bytes) {
  return await Host.crypto.hexToBase64(bytesToHex(bytes));
}

/** 随机十六进制串（生成 deviceId / passO 用） */
async function randomHex(length) {
  const byteLength = Math.ceil(length / 2);
  const b64 = await Host.crypto.randomBytes(byteLength);
  return bytesToHex(await b64ToBytes(b64)).slice(0, length);
}

function concatBytes(parts) {
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i].length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], offset);
    offset += parts[i].length;
  }
  return out;
}

/* ================================================================ X25519 */

/*
 * Curve25519 密钥协商（RFC 7748）—— 米家 MISS 协议用它换共享密钥。
 *
 * 为什么在插件里手写，而不是用系统加密库：
 *   · 鸿蒙 cryptoFramework **原生支持 X25519**（`X25519_SK_BN = 601`，
 *     密钥协商的 algName 可传 'X25519'）—— 但那是 ArkTS 侧的 API；
 *   · 插件跑在 ArkWeb 的 JS 沙箱里，只能靠 `Host.crypto` 那几个转发方法
 *     （sha256 / sha1 / randomBytes / base64ToHex…）够到系统能力，里面没有
 *     这一项；为它单独加一条桥要动宿主三处（桥清单 / 异步名单 / bootstrap 缝合），
 *     代价远大于这 40 行算法；
 *   · 而 MISS 协议每次连接**只算两次**（生成公钥一次、派生共享密钥一次），
 *     用 BigInt 跑的 Montgomery 阶梯完全够用 —— 它不是热路径。
 *
 * ⚠️ 变量名 A / AA / B / BB / E / C / D / DA / CB 直接沿用 RFC 7748 的记法，
 *    换成别的名字反而对不上原文，以后照论文核代码会更容易出错。
 */

const X25519_P = (1n << 255n) - 19n;
/** (486662 - 2) / 4 —— RFC 7748 里的 A24 */
const X25519_A24 = 121665n;
/** Curve25519 基点 u = 9：公钥就是「私钥 × 9」 */
const X25519_BASE_U = 9n;

function bytesToBigIntLE(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i] & 0xff);
  return n;
}

function bigIntToBytesLE(n, length) {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * X25519 标量乘。privBytes 必须是**已 clamp** 的 32 字节私钥；
 * uBytes 是对方的 u 坐标（32 字节，小端）。
 *
 * 返回值就是共享密钥本身 —— 与 Go 的 `box.Precompute` 等价，
 * 它内部只做 `curve25519.ScalarMult`，**不带任何 KDF**，
 * 所以这个 32 字节可以直接拿去当 ChaCha20 的 key。
 */
function x25519ScalarMult(privBytes, uBytes) {
  const P = X25519_P;
  const k = bytesToBigIntLE(privBytes);
  // 只取低 255 位：u 坐标的最高位在 RFC 7748 里必须忽略
  const x1 = bytesToBigIntLE(uBytes) & ((1n << 255n) - 1n);

  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;

  for (let t = 254; t >= 0; t--) {
    const kt = (k >> BigInt(t)) & 1n;
    swap ^= kt;
    if (swap === 1n) {
      let tmp = x2; x2 = x3; x3 = tmp;
      tmp = z2; z2 = z3; z3 = tmp;
    }
    swap = kt;

    const A = (x2 + z2) % P;
    const AA = (A * A) % P;
    const B = (x2 - z2 + P) % P;
    const BB = (B * B) % P;
    const E = (AA - BB + P) % P;
    const C = (x3 + z3) % P;
    const D = (x3 - z3 + P) % P;
    const DA = (D * A) % P;
    const CB = (C * B) % P;

    const daPlusCb = (DA + CB) % P;
    const daMinusCb = (DA - CB + P) % P;

    x3 = (daPlusCb * daPlusCb) % P;
    z3 = (x1 * ((daMinusCb * daMinusCb) % P)) % P;
    x2 = (AA * BB) % P;
    z2 = (E * ((AA + X25519_A24 * E) % P)) % P;
  }

  if (swap === 1n) {
    let tmp = x2; x2 = x3; x3 = tmp;
    tmp = z2; z2 = z3; z3 = tmp;
  }

  // 仿射化：x = x2 / z2 = x2 · z2^(p−2)（费马小定理）
  const inv = modPow(z2, P - 2n, P);
  return bigIntToBytesLE((x2 * inv) % P, 32);
}

/**
 * 生成一对 X25519 密钥。私钥按 RFC 7748 做 clamp：
 * 最低 3 位清零、最高位清零、次高位置 1。
 * 漏了 clamp，公钥就是错的，云端派生出的共享密钥也就对不上。
 */
async function x25519GenerateKeyPair() {
  const priv = await b64ToBytes(await Host.crypto.randomBytes(32));
  priv[0] &= 248;
  priv[31] &= 127;
  priv[31] |= 64;
  const pub = x25519ScalarMult(priv, bigIntToBytesLE(X25519_BASE_U, 32));
  return { privateKey: priv, publicKey: pub };
}

/* ================================================================ RC4 */

/**
 * RC4 变体：标准 KSA + PRGA，但丢弃密钥流开头的 `dropBytes` 字节。
 * 米家用 `dropBytes = 1024`（避开 RC4 开头那段统计偏置）。
 *
 * ⚠️ 宿主**没有** `Host.crypto.rc4` —— 鸿蒙系统加密库不含 RC4（文档 §7.1）。
 * 这里手写 25 行，加密解密是同一个函数（RC4 是对合运算）。
 */
function rc4(keyBytes, dataBytes, dropBytes) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + keyBytes[i % keyBytes.length]) & 0xff;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }

  let i = 0;
  j = 0;
  const drop = dropBytes || 0;
  for (let n = 0; n < drop; n++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    const t = S[i]; S[i] = S[j]; S[j] = t;
  }

  const out = new Uint8Array(dataBytes.length);
  for (let n = 0; n < dataBytes.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    const t = S[i]; S[i] = S[j]; S[j] = t;
    out[n] = dataBytes[n] ^ S[(S[i] + S[j]) & 0xff];
  }
  return out;
}

/** 整数 → 大端字节。注意 0 要特判成单字节 0（与宿主一致） */
function bigEndian(value) {
  if (value === 0) return new Uint8Array([0]);
  const bytes = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.push(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  bytes.reverse();
  return new Uint8Array(bytes);
}

/* ================================================================ 签名 */

/** nonce = base64( 8 字节随机 ++ 4 字节大端当前分钟数 ) */
async function genNonce() {
  const randomBytes = await b64ToBytes(await Host.crypto.randomBytes(8));
  const minutes = Math.floor(Date.now() / 60000);
  return await bytesToB64(concatBytes([randomBytes, bigEndian(minutes)]));
}

/**
 * signedNonce = base64( sha256( ssecurityBytes ++ nonceBytes ) )
 * 字节拼接，不是字符串拼接 —— 这是整个协议最容易错的一处。
 */
async function getSignedNonce(ssecurity, nonce) {
  const combined = concatBytes([await b64ToBytes(ssecurity), await b64ToBytes(nonce)]);
  return await Host.crypto.sha256BytesBase64(await bytesToB64(combined));
}

/** base64( sha1( "METHOD&uri&k=v&...&signedNonce" ) ) */
async function genEncSignature(uri, method, signedNonce, params) {
  const parts = [String(method).toUpperCase(), uri];
  for (let i = 0; i < params.length; i++) parts.push(params[i].key + '=' + params[i].value);
  parts.push(signedNonce);
  return await Host.crypto.sha1BytesBase64(await bytesToB64(utf8Bytes(parts.join('&'))));
}

/** RC4 加密，key = signedNonce，丢弃 1024 字节 */
async function encryptRc4(keyBase64, plainText) {
  return await bytesToB64(rc4(await b64ToBytes(keyBase64), utf8Bytes(plainText), 1024));
}

/** RC4 解密，key = signedNonce，丢弃 1024 字节。返回字节数组 */
async function decryptRc4Bytes(keyBase64, cipherBase64) {
  return rc4(await b64ToBytes(keyBase64), await b64ToBytes(cipherBase64), 1024);
}

/**
 * 从抓包的表单体里取出 `data` 与 `_nonce`。
 *
 * 米家 App 的请求体长这样：
 *   data=<RC4密文>&rc4_hash__=...&signature=...&ssecurity=...&_nonce=...
 * 各字段都可能被 URL 编码（`%3D` 之类）。用户从抓包工具里复制整段粘进来，
 * 这里负责挑出解密真正需要的两个字段。
 *
 * 也容忍用户只给 `data=...&_nonce=...` 两段，或者干脆只贴裸密文 ——
 * 后者缺 nonce 推不出 signedNonce，解不开，但要把"缺哪一半"说清楚。
 */
function parseCaptureBlob(text) {
  const out = { data: '', nonce: '', ssecurity: '' };
  const raw = String(text || '').trim();
  if (!raw) return out;

  const fields = raw.split('&');
  for (let i = 0; i < fields.length; i++) {
    const eq = fields[i].indexOf('=');
    if (eq < 0) continue;
    const key = fields[i].slice(0, eq).trim();
    let value = fields[i].slice(eq + 1).trim();
    if (value.indexOf('%') >= 0) {
      try { value = decodeURIComponent(value); } catch (e) { /* 保持原样 */ }
    }
    if (key === 'data') out.data = value;
    else if (key === '_nonce') out.nonce = value;
    /*
     * 🔴 `ssecurity` 必须一起收 —— 它是这段密文**真正的钥匙**。
     *
     * 米家的 ssecurity 与登录会话**成对签发**（本插件续期时就必须连着换，
     * 见 refreshServiceToken 的注释），所以米家 App 的会话与本站会话
     * 是两套密钥：拿本机登录的 ssecurity 去解米家 App 抓的密文，
     * 必然解出乱码。而米家把 ssecurity **明文放在请求体里**发出去
     * （插件自己的 buildEncParams 也这么带），所以抓包里通常就有这一份 ——
     * 有它就能解，不必属于同一个会话。
     */
    else if (key === 'ssecurity') out.ssecurity = value;
  }

  if (!out.data && !out.nonce) out.data = raw;
  return out;
}

/**
 * 把解密出来的文本排得好看一点：能当 JSON 解析就缩进，否则原样返回。
 * 报告是给人看的，一段没有换行的 400 字节 JSON 很难读。
 */
/** 字节数组 → 空格分隔的十六进制（诊断用：乱码长什么样，比多问三句话有用） */
function toHex(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i++) {
    const h = Number(bytes[i]).toString(16);
    parts.push(h.length === 1 ? '0' + h : h);
  }
  return parts.join(' ');
}

/** 字节数组 → 可打印 ASCII 预览，不可打印的用 `.` 占位 */
function toAsciiPreview(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = Number(bytes[i]);
    s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
  }
  return s;
}

function prettyPlain(text) {
  const t = String(text || '');
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch (e) {
    return t;
  }
}

/**
 * 组装成套的加密参数。
 * ① 明文参数 → rc4_hash__  ② 全部加密  ③ 密文再签一次 → signature（明文追加）
 */
async function buildEncParams(uri, method, signedNonce, nonce, params, ssecurity) {
  const rc4Hash = await genEncSignature(uri, method, signedNonce, params);

  const withHash = params.concat([{ key: 'rc4_hash__', value: rc4Hash }]);

  const encrypted = [];
  for (let i = 0; i < withHash.length; i++) {
    encrypted.push({
      key: withHash[i].key,
      value: await encryptRc4(signedNonce, withHash[i].value)
    });
  }

  encrypted.push({
    key: 'signature',
    value: await genEncSignature(uri, method, signedNonce, encrypted)
  });
  encrypted.push({ key: 'ssecurity', value: ssecurity });
  encrypted.push({ key: '_nonce', value: nonce });
  return encrypted;
}

function paramsToForm(params) {
  const parts = [];
  for (let i = 0; i < params.length; i++) {
    parts.push(encodeURIComponent(params[i].key) + '=' + encodeURIComponent(params[i].value));
  }
  return parts.join('&');
}

/**
 * 🔴 httpForm 的 `fields` 参数必须是**键值对象**，不是编好的表单字符串！
 *
 * 曾经传的是 `paramsToForm(params)`（字符串）。桥的 encodeForm 拿到字符串后
 * `Object.keys()` 得到的是字符下标（'0','1','2'...），发出去的 POST 体成了
 * `0=d&1=a&2=t...` 的乱码 —— 服务端解不开签名，所有签名 POST 全部
 * 401 auth error，而 GET（登录链路）走 `http` 不受影响完全正常。
 * 这就是「登录成功但数据面永远 401」的真根因（v1.0.7 修）。
 */
function paramsToObj(params) {
  const out = {};
  for (let i = 0; i < params.length; i++) {
    out[params[i].key] = params[i].value;
  }
  return out;
}

/* ================================================================ HTTP */

function apiHeaders() {
  const countryCode = LOCALE.indexOf('_') >= 0 ? LOCALE.split('_')[1] : 'CN';
  return {
    'User-Agent': auth.userAgent,
    'accept-encoding': 'identity',
    'Content-Type': 'application/x-www-form-urlencoded',
    'miot-accept-encoding': 'identity',
    'miot-encrypt-algorithm': 'ENCRYPT-RC4',
    'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
    'Cookie': [
      'cUserId=' + auth.cUserId,
      'yetAnotherServiceToken=' + auth.serviceToken,
      'serviceToken=' + auth.serviceToken,
      'channel=MI_APP_STORE',
      'countryCode=' + countryCode,
      'PassportDeviceId=' + auth.deviceId,
      'locale=' + auth.locale
    ].join(';')
  };
}

/**
 * 发一个签名请求，返回已解密的 `result` 字段。
 *
 * 响应处理有两种形态：明文 JSON，或 RC4 密文。宿主也是两路都试
 * （`MijiaApiClient.parseResponse`），这里保持一致 —— 服务端的选择
 * 取决于 `miot-encrypt-algorithm` 和具体接口，不能假设。
 */
/**
 * 发一次签名请求，返回 { res, nonce, signedNonce }（解密响应要用当次的 signedNonce）。
 *
 * `host` / `extraHeaders` 是给**非通用网关**留的口子（见 CAMERA_GATEWAY）。
 * 换域名不影响签名 —— 参与签名的只有**路径**，不含 host；
 * 但摄像头业务网关会额外校验 `miot-request-model` 这类头，必须能带上。
 */
async function requestOnce(uri, data, host, extraHeaders) {
  const nonce = await genNonce();
  const signedNonce = await getSignedNonce(auth.ssecurity, nonce);
  const params = await buildEncParams(
    uri, 'POST', signedNonce, nonce,
    [{ key: 'data', value: JSON.stringify(data) }],
    auth.ssecurity
  );
  const headers = apiHeaders();
  if (extraHeaders) {
    const keys = Object.keys(extraHeaders);
    for (let i = 0; i < keys.length; i++) headers[keys[i]] = extraHeaders[keys[i]];
  }
  const res = await Host.httpForm((host || API_HOST) + uri, headers, paramsToObj(params));
  return { res: res, nonce: nonce, signedNonce: signedNonce };
}

/** 静默续期的去重：并发调用撞上 401 时只发一次续期，大家共用结果 */
let refreshInFlight = null;

/**
 * 用 passToken 静默换新的 serviceToken —— 真机 App 的同款续期方式，不用扫码。
 *
 * 流程对齐 MiService（miservice/miaccount.py，社区里最可靠的参照实现）：
 * serviceLogin 带 passToken → 响应 code=0 且必含 location/nonce/ssecurity →
 * 跳 location（追加 clientSign 签名）→ serviceToken 种进 Cookie。
 * 🔴 ssecurity 必须一并更新：它与 serviceToken 同会话成对签发，只换 token 不换
 * ssecurity，签名就对不上 —— 续期「成功」但请求照样 401（v1.0.5 真机实证）。
 *
 * 成功：更新内存 auth + 写回 secureStore（这样冷启动恢复的就是新凭据）。
 * 失败：还原现场返回 false，不影响现有会话。
 */
async function refreshServiceToken() {
  if (!auth || !auth.passToken) return false;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async function () {
    const savedJar = cookieJar;
    // 干净的会话只带身份 Cookie —— 设备指纹沿用登录时的，服务端认这台「设备」
    cookieJar = 'userId=' + auth.userId + ';passToken=' + auth.passToken
      + ';deviceId=' + auth.deviceId + ';sdkVersion=3.9';
    try {
      const serviceUrl = ACCOUNT_HOST + '/pass/serviceLogin?_json=true&sid=mijia&_locale=' + LOCALE;
      const res = await Host.http('GET', serviceUrl, loginHeaders(), undefined, 30000);
      absorbCookies(res);
      const data = parseLoginJson(res.body);
      await Host.log.info('mijia', 'serviceLogin 响应: code=' + data.code
        + ', ssecurity=' + (data.ssecurity ? '有' : '无')
        + ', nonce=' + (data.nonce ? '有' : '无')
        + ', location=' + (data.location ? '有' : '无')).catch(function () {});

      /*
       * 对齐 MiService 的续期流程（miservice/miaccount.py）：
       *   1. serviceLogin 带上 passToken → 响应 code=0，必含 userId/passToken/location/nonce/ssecurity；
       *   2. 跳 location 换 serviceToken，跳转时追加 `clientSign=base64(sha1("nonce="+nonce+"&"+ssecurity))`；
       *   3. ssecurity/serviceToken 同会话成对 —— 不更新 ssecurity，签名必然对不上新 token。
       * v1.0.5 就是死在第 2/3 步：没带 clientSign 也没确认 ssecurity，续期「成功」
       * 但签名还用旧 ssecurity，重试请求照样 401 auth error（真机 log1.txt 实证）。
       */
      if (String(data.code) !== '0') {
        throw new Error('passToken 已失效（serviceLogin code=' + data.code
          + (data.description ? ' ' + data.description : '') + '），需要重新扫码');
      }
      if (!data.ssecurity) {
        throw new Error('serviceLogin 响应缺 ssecurity，无法签名（需要重新扫码）');
      }

      let serviceToken = '';
      if (data.serviceToken) {
        // 极少见：新凭据直接在响应体里
        serviceToken = String(data.serviceToken);
      } else if (data.location) {
        let locUrl = String(data.location);
        if (data.nonce) {
          const clientSign = await Host.crypto.sha1BytesBase64(
            await bytesToB64(utf8Bytes('nonce=' + data.nonce + '&' + data.ssecurity)));
          locUrl += '&clientSign=' + encodeURIComponent(clientSign);
        }
        const locRes = await Host.http('GET', locUrl, loginHeaders(), undefined, 30000);
        absorbCookies(locRes);
        serviceToken = extractServiceToken();
      }
      if (!serviceToken) throw new Error('location 跳后 jar 里没有 serviceToken');

      auth.serviceToken = serviceToken;
      auth.ssecurity = String(data.ssecurity);
      if (data.passToken) auth.passToken = String(data.passToken);
      if (data.userId) auth.userId = String(data.userId);
      if (data.cUserId) auth.cUserId = String(data.cUserId);

      await Host.secureStore.set('auth', JSON.stringify(auth));
      await Host.log.info('mijia', 'serviceToken 已静默续期（uid=' + auth.userId
        + '，ssecurity 已更新: 是）').catch(function () {});
      return true;
    } catch (e) {
      cookieJar = savedJar;
      await Host.log.error('mijia', 'serviceToken 静默续期失败: ' + e).catch(function () {});
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function request(uri, data, host, extraHeaders) {
  if (!auth) throw new Error('未登录');

  let out = await requestOnce(uri, data, host, extraHeaders);

  /*
   * 401 不再直接判「登录失效」。serviceToken 是会过期的（passToken 通常活得更久），
   * 真机 App 的做法是拿 passToken 静默换一个新的 serviceToken，全程不用扫码。
   * 这里对齐它：续期成功就重发本次请求；续期失败才真正报「请重新登录」。
   */
  if (out.res.status === 401) {
    const preview = String(out.res.body || '').trim().slice(0, 150);
    await Host.log.error('mijia', '接口 401（' + uri + '）: ' + preview).catch(function () {});
    if (await refreshServiceToken()) {
      out = await requestOnce(uri, data, host, extraHeaders);
    }
  }

  const res = out.res;
  const nonce = out.nonce;
  const signedNonce = out.signedNonce;
  if (res.status === 401) throw new Error('登录已失效，请重新扫码登录（passToken 续期也没成功）');
  if (res.status !== 200) throw new Error('米家接口 HTTP ' + res.status);

  const body = String(res.body || '');
  if (body.trim().toLowerCase().indexOf('invalid token') >= 0) {
    throw new Error('米家接口返回 Invalid Token');
  }

  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    parsed = null;
  }

  if (parsed === null || parsed === undefined) {
    // 明文解不开 → 试 RC4 解密。密钥是 signedNonce（不是 ssecurity）
    let plain = '';
    try {
      plain = bytesToUtf8(await decryptRc4Bytes(signedNonce, body));
    } catch (e) {
      throw new Error('响应既不是 JSON 也不是可解密的 RC4');
    }
    if (plain.trim().toLowerCase().indexOf('invalid token') >= 0) {
      throw new Error('米家接口返回 Invalid Token');
    }
    try {
      parsed = JSON.parse(plain);
    } catch (e) {
      throw new Error('解密后的响应不是 JSON：' + plain.trim().slice(0, 80));
    }
  }

  if (parsed.code !== 0 || parsed.result === undefined) {
    throw new Error(String(parsed.message || parsed.desc || '米家接口返回错误'));
  }
  return parsed.result;
}

/* ================================================================ 登录 */

/** 登录相关请求的公共头 */
function loginHeaders() {
  const base = 'deviceId=' + deviceId + ';pass_o=' + passO + ';uLocale=' + LOCALE;
  return {
    'User-Agent': userAgent,
    'Accept-Encoding': 'identity',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Connection': 'keep-alive',
    'Cookie': cookieJar.length > 0 ? base + ';' + cookieJar : base
  };
}

/**
 * 把响应里的 Set-Cookie 合并进 jar。同名覆盖，保留其余。
 *
 * ⚠️ 来源优先级对齐内置版（`MijiaQrLoginService.updateCookies`，已验证能登录）：
 * 先解析原始 `headers['set-cookie']`，`res.cookies` 只作兜底 —— SDK 的
 * `cookies` 字段格式没有文档保证（部分版本把多个 Cookie 用 `;` 拼接，
 * 按逗号切分只吸收到第一个，serviceToken 直接丢），插件登录被 403 而
 * 内置能登录的差异就出在这类「看着等价、实则不等价」的环节。
 *
 * ⚠️ 米家登录流程完全依赖 Cookie 串联（serviceLogin 种下 → 取二维码时带上
 * → 长轮询时再带上 → location 跳种 serviceToken），这里丢一个 Cookie，
 * 下一步就 403/静默失败。
 */
const COOKIE_ATTRS = 'path|domain|expires|max-age|secure|httponly|samesite|version|comment';

function absorbCookies(res) {
  if (!res) return;
  let raw = '';
  if (res.headers) {
    raw = String(res.headers['set-cookie'] || '');
  }
  if (!raw && res.cookies) {
    raw = String(res.cookies);
  }
  if (!raw) return;
  const absorbed = [];
  // 兼容两种拼接：标准的多 Set-Cookie 逗号拼接、SDK 的分号拼接。
  // 先按「逗号后紧跟 name=」切块，块内再按分号逐段识别，跳过属性段
  const chunks = raw.split(/,(?=\s*[^=;]+=)/);
  for (let i = 0; i < chunks.length; i++) {
    const segments = chunks[i].split(';');
    for (let k = 0; k < segments.length; k++) {
      const seg = segments[k].trim();
      if (!seg) continue;
      const eq = seg.indexOf('=');
      if (eq <= 0) continue;
      const name = seg.substring(0, eq).trim();
      if (!name || new RegExp('^(' + COOKIE_ATTRS + ')$', 'i').test(name)) continue;
      const pair = seg;
      const kept = [];
      const existing = cookieJar.split(';');
      for (let j = 0; j < existing.length; j++) {
        const item = existing[j].trim();
        if (item && item.indexOf(name + '=') !== 0) kept.push(item);
      }
      kept.push(pair);
      cookieJar = kept.join(';');
      absorbed.push(name);
    }
  }
  if (absorbed.length > 0) {
    Host.log.info('mijia', '吸收 Cookie: ' + absorbed.join(',') + '，jar 现有: '
      + cookieJar.split(';').map(function (p) { return p.split('=')[0]; }).join(',')).catch(function () {});
  }
}

/** 米家的登录接口在 JSON 前会塞一个 `&&&START&&&` 防 JSONP 前缀 */
function parseLoginJson(body) {
  const text = String(body || '').replace('&&&START&&&', '');
  try {
    return JSON.parse(text);
  } catch (e) {
    const preview = text.trim().slice(0, 120);
    if (preview.toLowerCase().indexOf('invalid token') >= 0) {
      throw new Error('登录返回 Invalid Token，请重新生成二维码');
    }
    // 风控页是 Apache 风格的 HTML 403，直接报「不是有效 JSON」会误导排查方向
    if (preview.toLowerCase().indexOf('<html') >= 0 || preview.indexOf('403') >= 0) {
      throw new Error('请求被服务端风控拦截（403），请过一段时间再试');
    }
    throw new Error('登录响应不是有效 JSON：' + preview);
  }
}

/** 从 jar 里取 serviceToken —— 后面所有米家接口的 Cookie 都要它 */
function extractServiceToken() {
  const parts = cookieJar.split(';');
  for (let i = 0; i < parts.length; i++) {
    const pair = parts[i].trim();
    if (pair.indexOf('serviceToken=') === 0) return pair.substring('serviceToken='.length);
  }
  return '';
}

/** ① 拿 serviceLogin 的 location，再拿二维码 ticket */
async function fetchLoginTicket() {
  const serviceUrl = ACCOUNT_HOST + '/pass/serviceLogin?_json=true&sid=mijia&_locale=' + LOCALE;
  // 超时对齐内置版（HttpClient 默认 30s）—— 桥默认 15s 偏短
  const serviceRes = await Host.http('GET', serviceUrl, loginHeaders(), undefined, 30000);
  absorbCookies(serviceRes);

  const serviceData = parseLoginJson(serviceRes.body);
  if (!serviceData.location) throw new Error('serviceLogin 没有返回 location');

  // location 里的 query 原样搬到二维码地址上
  const query = String(serviceData.location).split('?')[1] || '';
  const qrUrl = ACCOUNT_HOST + '/longPolling/loginUrl?theme=&bizDeviceType=&_hasLogo=false'
    + '&_qrsize=240&_dc=' + Date.now() + (query ? '&' + query : '');

  const qrRes = await Host.http('GET', qrUrl, loginHeaders(), undefined, 30000);
  absorbCookies(qrRes);

  const qrData = parseLoginJson(qrRes.body);
  if (!qrData.loginUrl || !qrData.qr || !qrData.lp) {
    throw new Error('二维码响应缺少字段');
  }
  return { lp: qrData.lp, qr: qrData.qr };
}

/**
 * ② 轮询扫码结果。这是个**长轮询**接口，服务端会挂住直到用户扫码或超时。
 *
 * 拿到的完整凭据形状与宿主 `MijiaAuthData` 一致 —— 数据面要按它发请求，
 * 字段名不能改。
 */
async function pollLoginTicket(lp) {
  // 长轮询接口：服务端会挂住连接直到扫码或超时，必须给足 120s（内置版同款）
  const res = await Host.http('GET', lp, loginHeaders(), undefined, 120000);
  absorbCookies(res);

  const data = parseLoginJson(res.body);
  if (!data.psecurity || !data.ssecurity || !data.passToken || !data.userId || !data.cUserId) {
    // 还没扫 / 已过期，都走这里。宿主侧靠调用方重试，插件也交给宿主轮询
    throw new Error('waiting');
  }

  // 有些流程要再访问一次 location 才会把 serviceToken 种进 cookie
  if (data.location) {
    try {
      absorbCookies(await Host.http('GET', data.location, loginHeaders(), undefined, 30000));
    } catch (e) {
      // 之前这里静默吞掉，但实际上 serviceToken 就靠这一跳种下来 ——
      // 失败在下面才暴露成「未能取得 serviceToken」，中间断了哪段全靠猜
      await Host.log.error('mijia', 'location 跳转失败（serviceToken 可能种不下）: ' + e).catch(function () {});
    }
  }

  const serviceToken = extractServiceToken();
  await Host.log.info('mijia', '扫码凭据已到，location 跳后 jar 里的 Cookie: '
    + cookieJar.split(';').map(function (p) { return p.split('=')[0]; }).join(',')
    + '，serviceToken=' + (serviceToken ? '有(' + serviceToken.length + '字符)' : '无')).catch(function () {});
  if (!serviceToken) {
    throw new Error('未能取得 serviceToken（location 跳转没种下 Cookie，请看上方「吸收 Cookie」日志定位断在哪一跳）');
  }

  return {
    userId: data.userId,
    cUserId: data.cUserId,
    passToken: data.passToken,
    ssecurity: data.ssecurity,
    serviceToken: serviceToken,
    deviceId: deviceId,
    passO: passO,
    userAgent: userAgent,
    locale: LOCALE
  };
}

/* ================================================================ 数据面 */

/**
 * 把米家设备对象转成宿主期望的形状。
 *
 * ⚠️ 字段名是**米家原始命名**，不是驼峰 —— 宿主 `HomeModels.parseDevice`
 * 逐字段读的是 `isOnline` / `home_id` / `room_id` / `spec_type` / `local_ip` /
 * `parent_id`。写成 `homeId` / `roomId` 不会报错，只会静默变成空字符串，
 * 然后界面上一堆设备「没有房间、显示离线」。
 *
 * 这里其实是「原样透传」—— 米家返回什么就用什么。宿主特意把
 * `parseDevice` 设计成接米家原字段，就是为了让插件能直接把云端对象递过去，
 * 不用在两边各维护一套映射。
 */
function toDevice(raw, homeId) {
  const did = String((raw && raw.did) || '');
  if (!did) return null;
  const out = {};
  const keys = Object.keys(raw);
  for (let i = 0; i < keys.length; i++) {
    out[keys[i]] = raw[keys[i]];
  }
  // home_id 有时不在设备对象里，用当前家庭补上
  if (out.home_id === undefined || out.home_id === '') {
    out.home_id = homeId;
  }
  return out;
}

function asArray(v) {
  return v instanceof Array ? v : [];
}

function asNumber(v, fallback) {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

/* ── 实时视频流（摄像头）────────────────────────────────────────────
 * miot-spec 里摄像头可能带这几条取流服务，语义各不相同：
 *
 *   camera-stream-for-google-home   → action `start-hls-stream`，出参 stream-address（m3u8）
 *                                     新机型这条服务里可能只有 `initiate-webrtc-session`
 *   camera-stream-for-amazon-alexa  → action `start-rtsp-stream`，出参 stream-address（rtsp）
 *   p2p-stream                      → 私有 P2P，in/out 全空，只有米家 App 能用（无解）
 *
 * 🔴 **一律按服务名/动作名去找，绝不硬编码 siid/aiid**：
 * 不同机型这两个编号完全不同（有的摄像头 google-home 服务是 siid 7，有的是 5），
 * 写死编号在换机型时的表现是「动作返回 code=0 但 out 为空」——一种
 * 看上去哪都没错、却什么都拿不到的失败。
 *
 * ⚠️ **这条路只覆盖少数机型**。把 miot-spec.org 上 279 个 camera 型号全量扫过一遍
 * （脚本 `scripts/scan_camera_stream.js`，结果见 `docs/摄像头与路由器适配调研.md` §9）：
 *
 *   - 带 google-home 服务的一共 66 个，其中**只有 53 个有 `start-hls-stream`**；
 *     另外 13 个（xiaomi-c201 / c302n / c500a、midr-bw400/300 系列、
 *     chuangmi-061a03 / 120ae1、isa-700sa……）那条服务里只有
 *     `initiate-webrtc-session` —— 需要 WebRTC 会话，没有可直接播的地址
 *   - 带 p2p-stream 的 244 个（87%），但 `start-p2p-stream` 的 in/out 全空，
 *     纯私有协议，第三方客户端拿不到任何东西
 *   - 换句话说：**约八成机型的公开 spec 里根本不存在可播取的流地址**
 *
 * 所以「取不到流」是常态，不是异常。既然拿不到，就必须给出**可操作的下一步**
 * （见 `describeStreamSupport` 给出的归因 + 手动地址兜底），而不是一句「不支持」。
 *
 * 取到的地址是**短时效**的，所以缓存带过期时间；播放页失效时会再调一次本模块，
 * 那时按 did 命中过期条目 → 重新发起动作。
 */
const STREAM_SERVICES = [
  { token: 'camera-stream-for-google-home', action: 'start-hls-stream', kind: 'hls' },
  { token: 'camera-stream-for-amazon-alexa', action: 'start-rtsp-stream', kind: 'rtsp' }
];

/** 默认有效期：读不到 expiration-time 时按 10 分钟算（米家 HLS 普遍在 5~30 分钟） */
const STREAM_DEFAULT_TTL_MS = 10 * 60 * 1000;
/** 提前量：留 30s 缓冲，避免「刚好在过期那一刻开始播」 */
const STREAM_EXPIRE_MARGIN_MS = 30 * 1000;

const streamCache = {};

/* ── 手动直播地址（兜底通道）───────────────────────────────────────
 * 存 `secureStore` 的独立键 `stream_url_<did>`。
 *
 * 为什么值得单独做一条：约八成机型的 spec 里根本没有可播的流地址（见模块头），
 * 但其中不少支持米家 App 里的「局域网监控」（打开后会给出
 * `rtsp://<user>:<pass>@<ip>:554/live/ch00_0`）。那是唯一不依赖云端、
 * 不依赖 spec、也不会过期的取流方式 —— 让用户能自己救自己，
 * 比给一句「不支持」有用得多。
 */
const manualStreamCache = {};

async function loadManualStream(did) {
  if (manualStreamCache[did] !== undefined) return manualStreamCache[did];
  let value = '';
  try {
    const stored = await Host.secureStore.get('stream_url_' + did);
    if (typeof stored === 'string' && stored.length > 0) value = stored;
  } catch (e) {
    // 读不到当作没配：这不是错误，只是没有兜底地址
    value = '';
  }
  manualStreamCache[did] = value;
  return value;
}

async function saveManualStream(did, url) {
  await Host.secureStore.set('stream_url_' + did, url);
  manualStreamCache[did] = url;
}

async function clearManualStream(did) {
  manualStreamCache[did] = '';
  try {
    await Host.secureStore.delete('stream_url_' + did);
  } catch (e) {
    // 删不掉不阻塞：内存态已清，本次会话不会再读到它
  }
}

/** 手动地址的格式校验：只拦明显不是地址的输入，能不能播交给播放器判断 */
function normalizeStreamUrl(raw) {
  const url = String(raw || '').trim();
  if (url.length === 0) throw new Error('地址不能为空');
  if (url.indexOf('://') <= 0) {
    throw new Error('地址要以协议开头，例如 rtsp:// 或 https://');
  }
  return url;
}

/** 从地址猜流类型（手动填的地址没有 kind 字段可用） */
function kindOfUrl(url) {
  const lower = String(url || '').toLowerCase();
  if (lower.indexOf('rtsp://') === 0) return 'rtsp';
  if (lower.indexOf('.m3u8') >= 0) return 'hls';
  if (lower.indexOf('.flv') >= 0) return 'flv';
  return 'http';
}

/** 取 spec 里某个 iid 对应的属性声明（动作的 in/out 给的是 iid） */
function findSpecProperty(spec, iid) {
  const services = asArray(spec && spec.services);
  for (let i = 0; i < services.length; i++) {
    const props = asArray(services[i] && services[i].properties);
    for (let j = 0; j < props.length; j++) {
      if (Number(props[j].iid) === Number(iid)) {
        return props[j];
      }
    }
  }
  return null;
}

/** 动作的 in/out 在不同 spec 版本里可能是 iid 数组，也可能是对象数组 */
function iidList(value) {
  const out = [];
  const list = asArray(value);
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item === null || item === undefined) continue;
    if (typeof item === 'number' || typeof item === 'string') {
      out.push(Number(item));
    } else if (item.iid !== undefined) {
      out.push(Number(item.iid));
    }
  }
  return out;
}

function findAction(service, actionToken) {
  const actions = asArray(service && service.actions);
  for (let i = 0; i < actions.length; i++) {
    const type = String((actions[i] && actions[i].type) || '').toLowerCase();
    if (type.indexOf(':action:' + actionToken) >= 0) {
      return actions[i];
    }
  }
  return null;
}

/**
 * 在 spec 里找一条可用的取流方案。
 * 返回 `{siid, aiid, kind, args, urlPiid}`；找不到返回 null。
 */
function findStreamPlan(spec) {
  const services = asArray(spec && spec.services);
  for (let k = 0; k < STREAM_SERVICES.length; k++) {
    const want = STREAM_SERVICES[k];
    for (let i = 0; i < services.length; i++) {
      const service = services[i];
      const type = String((service && service.type) || '').toLowerCase();
      if (type.indexOf(':service:' + want.token) < 0) continue;
      const action = findAction(service, want.action);
      if (!action) continue;
      // 入参：目前只见过一个（video-attribute），按声明顺序逐个取值
      const inPiids = iidList(action.in);
      const args = [];
      for (let n = 0; n < inPiids.length; n++) {
        args.push(pickPropertyValue(spec, inPiids[n]));
      }
      // 出参：按 out 的顺序找 stream-address 那一项
      const outPiids = iidList(action.out);
      let urlIndex = 0;
      for (let n = 0; n < outPiids.length; n++) {
        const prop = findSpecProperty(spec, outPiids[n]);
        const propType = String((prop && prop.type) || '').toLowerCase();
        if (propType.indexOf('stream-address') >= 0) {
          urlIndex = n;
          break;
        }
      }
      return {
        siid: Number(service.iid),
        aiid: Number(action.iid),
        kind: want.kind,
        args: args,
        urlIndex: urlIndex
      };
    }
  }
  return null;
}

/** 从 `urn:miot-spec-v2:service:<token>:...` 里取 `<token>`（取不到返回空串） */
function serviceToken(service) {
  const parts = String((service && service.type) || '').split(':');
  return parts.length > 3 && parts[2] === 'service' ? parts[3] : '';
}

/** 从 `urn:miot-spec-v2:action:<token>:...` 里取 `<token>`（取不到返回空串） */
function actionToken(action) {
  const parts = String((action && action.type) || '').split(':');
  return parts.length > 3 && parts[2] === 'action' ? parts[3] : '';
}

/**
 * 这台设备的 spec 属于哪种取流形态 —— 取不到流时用它把原因说清楚。
 *
 * 返回 `{ mode, services }`：
 *   'hls' / 'rtsp' → 有可直接播的地址（`findStreamPlan` 能命中）
 *   'webrtc'       → 那条服务里只有 initiate-webrtc-session（新机型走 WebRTC
 *                    会话），本应用（AVPlayer）播不了 —— 和「设备不支持」是两回事
 *   'p2p'          → 只有 p2p-stream，私有协议，第三方拿不到地址
 *   'none'         → 连取流服务都没有
 *
 * `services` 是服务 token 列表：失败时一并回显，省得来回问「你那台有什么服务」。
 */
function describeStreamSupport(spec) {
  const plan = findStreamPlan(spec);
  const services = asArray(spec && spec.services);
  const tokens = [];
  let hasWebrtc = false;
  let hasP2p = false;
  for (let i = 0; i < services.length; i++) {
    const token = serviceToken(services[i]);
    if (token) tokens.push(token);
    if (token === 'p2p-stream') hasP2p = true;
    const actions = asArray(services[i] && services[i].actions);
    for (let j = 0; j < actions.length; j++) {
      if (actionToken(actions[j]) === 'initiate-webrtc-session') hasWebrtc = true;
    }
  }
  if (plan) return { mode: plan.kind, services: tokens };
  if (hasWebrtc) return { mode: 'webrtc', services: tokens };
  if (hasP2p) return { mode: 'p2p', services: tokens };
  return { mode: 'none', services: tokens };
}

/** 把取流形态翻成一句用户看得懂的话 */
function describeStreamMode(mode) {
  if (mode === 'webrtc') {
    return '这台机型走的是 WebRTC 直播（新机型），本应用的播放器不支持该协议';
  }
  if (mode === 'p2p') {
    return '这台机型只提供米家私有的 P2P 流，第三方客户端取不到地址';
  }
  if (mode === 'none') {
    return '这台设备的规格里没有实时视频流服务';
  }
  return '这台设备没有开放实时视频流';
}

/* ------------------------------------------------ 米家 P2P 厂商探测 */

/**
 * vendor id → 名字。取值与 go2rtc 的 `getVendorName` 一致（同一份开源实现）。
 * 未知 id 原样回显数字 —— 云端随时可能加新厂商，写死枚举反而会盖住线索。
 */
const P2P_VENDOR_NAMES = { '1': 'tutk', '3': 'agora', '4': 'cs2', '6': 'mtp' };

function p2pVendorName(id) {
  const key = String(id);
  return P2P_VENDOR_NAMES[key] || ('unknown(' + key + ')');
}

/**
 * 这家 P2P 厂商对第三方意味着什么 —— 直接决定「还有没有路」。
 *
 * 判断依据是 go2rtc 的实际实现：它把这四家都试过一遍，
 * README 里对 tutk 的原话是「P2P 圈里最糟糕的东西，跑得一塌糊涂」。
 */
function describeP2pVendorRoad(id) {
  const name = p2pVendorName(id);
  if (name === 'cs2') {
    return [
      '这条有路 —— cs2 是纯局域网 UDP 直连（摄像头 32108 端口）：',
      '没有 NAT 打洞、没有信令服务器，因为客户端和摄像头本来就在同一个局域网，',
      '所谓 P2P 在这里直接退化成点对点。go2rtc 已用开源代码走通过，',
      '全程只有「握手 → 认证 → 开流 → 收包解密」四步，可以在宿主侧自行实现。',
      '密钥协商用 X25519、媒体用 ChaCha20 —— 鸿蒙系统库原生就有 X25519。'
    ];
  }
  if (name === 'tutk') {
    return [
      '这条很难 —— tutk 是 ThroughTek Kalay：除了 p2p_id 还得走它自家的打洞集群，',
      'go2rtc 作者对它的评价是「P2P 圈里最糟糕的东西」。',
      '第三方要从零重写一套 Kalay 客户端，不建议投入。'
    ];
  }
  if (name === 'agora') {
    return [
      '这条基本没路 —— agora 是声网 RTC，第三方没有公开的接入方式。'
    ];
  }
  return [
    '这家厂商没有已知的第三方实现，先别投入。'
  ];
}

/**
 * 问米家云：这台摄像头走哪家 P2P。
 *
 * 接口来自 go2rtc 的开源实现（`internal/xiaomi/xiaomi.go::getMissURL`）：
 *   POST /v2/device/miss_get_vendor
 *   {"app_pubkey":"<32字节公钥 hex>","did":"…","support_vendors":"TUTK_CS2_MTP"}
 *   → {"vendor":{"vendor":<id>,"vendor_params":{"p2p_id":"…"}},
 *      "public_key":"<设备公钥>","sign":"<设备签名>"}
 *
 * 为什么这一枪值得单独打：**「这台设备能不能自己取流」完全由 vendor 决定**。
 * 而 spec 层与开放动作接口两层都已经证明拿不到任何连接参数（§12）——
 * 这里问的是**米家 App 自己用的接口**，所以能看到不一样的答案。
 */
async function queryP2pVendor(did, model, clientPublicHex) {
  /*
   * 公钥归属：正式取流时私钥必须留在**宿主**（ArkTS 侧算共享密钥），
   * 插件只负责把宿主给的公钥送去云端换设备公钥与签名 —— 全程接触不到私钥。
   * 传了 clientPublicHex 就走这条路；诊断路径（probestream）不传，
   * 由插件自造一对（那份私钥只用于探测报告，用完即弃）。
   */
  const hostSupplied = typeof clientPublicHex === 'string' && clientPublicHex.length > 0;
  let publicKeyHex;
  let privateKeyHex = '';
  if (hostSupplied) {
    publicKeyHex = String(clientPublicHex).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    if (publicKeyHex.length !== 64) {
      return { ok: false, error: '宿主公钥应为 64 个十六进制字符（实得 ' + publicKeyHex.length + '）' };
    }
  } else {
    const pair = await x25519GenerateKeyPair();
    publicKeyHex = bytesToHex(pair.publicKey);
    privateKeyHex = bytesToHex(pair.privateKey);
  }

  /*
   * support_vendors 是在告诉云端「我这边支持这几家」，云端据此挑一个双方都有的返回。
   * 三家都写上才能看到设备的真实归属 —— 少写一家，云端可能直接回
   * 「no available vendor support」，而那是**我们**没声明，不是设备不支持，
   * 很容易被误读成「这台设备没戏」。
   */
  const params = {
    app_pubkey: publicKeyHex,
    did: String(did),
    support_vendors: 'TUTK_CS2_MTP'
  };

  /*
   * 域名试两条，顺序有讲究：
   *   · api.mijia.tech —— 本插件平时走的（米家 App 的域名，接口最全）
   *   · api.io.mi.com  —— go2rtc 走的（米家开放平台域名）
   * 同一个米家云、同一套签名，但**接口不保证在两边都暴露**。
   * 先试自己这条，不行再试它那条；两条都不行，才是真的不行。
   */
  const hosts = [API_HOST, 'https://api.io.mi.com/app'];
  /*
   * 米家 App 调摄像头业务接口时会带 `miot-request-model`，这里照做 ——
   * 云端的接口鉴权有时会看这个头（`/perf/camera/...` 那条抓包就是明证）。
   * 带了不亏，真机上万一被挑出来，至少不是我们少发了东西。
   */
  const headers = model ? { 'miot-request-model': String(model) } : undefined;
  let lastError = '';

  for (let i = 0; i < hosts.length; i++) {
    try {
      const result = await request('/v2/device/miss_get_vendor', params, hosts[i], headers);
      let vendorId = null;
      let p2pId = '';
      let initString = '';
      if (result && result.vendor && typeof result.vendor === 'object') {
        vendorId = result.vendor.vendor;
        const vp = result.vendor.vendor_params;
        if (vp && vp.p2p_id) p2pId = String(vp.p2p_id);
        // init_string 是 P2P 信令服务器列表（加密编码），远程直连要用它解出服务器
        if (vp && vp.init_string) initString = String(vp.init_string);
      }
      return {
        ok: true,
        host: hosts[i],
        vendorId: vendorId,
        p2pId: p2pId,
        initString: initString,
        devicePublic: result && result.public_key ? String(result.public_key) : '',
        sign: result && result.sign ? String(result.sign) : '',
        publicKeyHex: publicKeyHex,
        privateKeyHex: privateKeyHex
      };
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
  }
  return { ok: false, error: lastError, publicKeyHex: publicKeyHex };
}

/**
 * missPair 的单次尝试：把 queryP2pVendor 的探测结构规整成给宿主读的形态。
 * 失败（vendorId 未知 / 公钥缺失）不在这里重试 —— 由 missPair 统一编排。
 */
async function missPairOnce(device, did, clientPublicHex) {
  try {
    const probe = await queryP2pVendor(did, device && device.model, clientPublicHex);
    return {
      ok: !!probe.ok,
      vendorId: (probe.vendorId === null || probe.vendorId === undefined) ? -1 : Number(probe.vendorId),
      devicePublic: probe.devicePublic || '',
      sign: probe.sign || '',
      // vendor=1（tutk）时的 P2P 寻址 id（云端 vendor_params.p2p_id）；cs2 为空
      uid: probe.p2pId || '',
      // P2P 信令服务器列表（加密编码，宿主解出后走远程直连）；拿不到为空串
      initString: probe.initString || '',
      error: probe.error || ''
    };
  } catch (e) {
    return { ok: false, vendorId: -1, devicePublic: '', sign: '', uid: '', initString: '',
      error: String((e && e.message) || e) };
  }
}

/** 把 vendor 探测结果排成报告段落。报告要能独立读懂，不能只丢一行 id 给人猜。 */
function vendorProbeLines(probe) {
  const lines = [];
  lines.push('── 米家 P2P 厂商探测 ──');
  if (!probe) {
    lines.push('  （未执行）');
    return lines;
  }
  if (!probe.ok) {
    lines.push('  查询失败：' + probe.error);
    lines.push('  → 这只说明**我们没拿到厂商信息**，不等于这台设备没有 P2P。');
    lines.push('     spec 与开放动作接口本来就查不到这一层（见上面的探测结论）。');
    return lines;
  }
  lines.push('  接口：/v2/device/miss_get_vendor（走 '
    + String(probe.host).replace('https://', '') + '）');
  lines.push('  厂商：' + p2pVendorName(probe.vendorId)
    + '（vendor id = ' + String(probe.vendorId) + '）');
  lines.push('  设备公钥：' + (probe.devicePublic
    ? probe.devicePublic.substring(0, 24) + '…' : '未返回'));
  lines.push('  设备签名：' + (probe.sign
    ? '有（' + probe.sign.length + ' 字符）' : '未返回'));
  if (probe.p2pId) lines.push('  TUTK p2p_id：' + probe.p2pId);
  lines.push('');
  const roads = describeP2pVendorRoad(probe.vendorId);
  for (let i = 0; i < roads.length; i++) lines.push('  ' + roads[i]);
  return lines;
}

/**
 * 从一段**属性声明**里挑一个值。
 *
 * 优先 720P：直播场景下首帧速度与带宽比清晰度重要（1080P 在部分机型上
 * 会被云端限流到只剩几帧/秒，体验反而更差）。找不到已知档位就用第一个可用值，
 * 再不行给 1 —— 米家这类枚举的合法值基本都从 1 开始。
 *
 * ⚠️ 入参是**属性对象本身**，不是 iid。iid 只在服务内唯一，
 * 拿 iid 去全局查找会命中别的服务里的同号属性（见 `findServiceProperty`）。
 */
function pickValueFromProperty(prop) {
  const list = asArray(prop && prop['value-list']);
  for (let i = 0; i < list.length; i++) {
    const desc = String((list[i] && list[i].description) || '');
    if (desc.indexOf('1280_720') >= 0) {
      return list[i].value;
    }
  }
  if (list.length > 0 && list[0].value !== undefined) {
    return list[0].value;
  }
  return 1;
}

/**
 * 按 piid 全局查找属性再取值。
 *
 * HLS 路径沿用这个入口（历史原因）。新代码请优先用 `pickValueFromProperty` ——
 * 传 iid 全局查会命中别的服务里的同号属性，只是现有调用点恰好没踩到。
 */
function pickPropertyValue(spec, piid) {
  return pickValueFromProperty(findSpecProperty(spec, piid));
}

/** 从动作出参里挑出一个像 URL 的字符串 */
function pickStreamUrl(out, preferredIndex) {
  const list = asArray(out);
  const candidate = list[preferredIndex];
  if (typeof candidate === 'string' && candidate.indexOf('://') > 0) {
    return candidate;
  }
  for (let i = 0; i < list.length; i++) {
    const value = list[i];
    if (typeof value === 'string' && (value.indexOf('http://') === 0 || value.indexOf('https://') === 0 || value.indexOf('rtsp://') === 0)) {
      return value;
    }
  }
  return '';
}

/**
 * 找服务里 `expiration-time` 属性的 piid。
 *
 * 🔴 注意方向：spec **声明**里没有设备当前值，必须拿这个 piid 再去
 * 读一次属性（`getProperty`）才知道这路的实际有效期。早先想当然地
 * 读声明里的 `value` 字段，那永远拿不到东西（而且不会报错）。
 */
function findExpirationPiid(spec, siid) {
  const services = asArray(spec && spec.services);
  for (let i = 0; i < services.length; i++) {
    if (Number(services[i].iid) !== Number(siid)) continue;
    const props = asArray(services[i].properties);
    for (let j = 0; j < props.length; j++) {
      const propType = String((props[j] && props[j].type) || '').toLowerCase();
      if (propType.indexOf('expiration-time') >= 0) {
        return Number(props[j].iid);
      }
    }
  }
  return 0;
}

/* ── WebRTC 取流探测（诊断用）───────────────────────────────────────
 * 2026-09 全量扫描发现：16 个机型（xiaomi-c201 / c302n / c500a / odg301 /
 * 083ae2、midr-bw400 系列、isa-700sa、chuangmi-061a03 / 112ae1 / 120ae1 /
 * 079ae2 …）的 spec 里**没有 HLS、没有 RTSP，p2p-stream 也用不了**，
 * 取流服务里只剩一套 WebRTC 信令：
 *
 *   initiate-webrtc-session     in=[video-attribute, session-id, webrtc-offer]  out=[stream-url]
 *   webrtc-session-connected    in=[session-id]
 *   webrtc-session-disconnected in=[session-id]
 *
 * 入参收 SDP offer 这点是明确的（属性名就叫 Webrtc Offer），但**出参槽位名叫
 * 「Stream URL」** —— 与 WebRTC 语义不符：标准应答应当是一段 answer SDP
 * （含 candidate / fingerprint / setup）。miot-spec 里没有更贴切的字段可借，
 * 所以很可能只是**复用了槽位名、实际装 answer SDP**；但也可能真给一个播放地址
 * （WHEP 风格的信令 URL）。
 *
 * 两种可能对应**完全不同的实现路径**，而且从 spec 推断不出来 —— 所以这里不猜，
 * 直接打一次真实请求，把返回值原样回显给人看。
 *
 * 本函数**只探测、不建连**：拿到应答就返回，不做 ICE / DTLS，不碰 streamCache。
 * 探测用的 offer 是一段结构合法、内容占位的 SDP —— 云端若认真解析它，
 * 会返回错误码；那本身就是「这条路是标准 WebRTC」的证据。
 */

/** 随机小写串（ice-ufrag / ice-pwd 用） */
function probeToken(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

/** 随机 sha-256 指纹串（占位，只为让 SDP 结构完整） */
function probeFingerprint() {
  const hex = '0123456789ABCDEF';
  const parts = [];
  for (let i = 0; i < 32; i++) {
    let pair = '';
    for (let j = 0; j < 2; j++) {
      pair += hex.charAt(Math.floor(Math.random() * 16));
    }
    parts.push(pair);
  }
  return parts.join(':');
}

/**
 * 构造一段结构合法的最小 SDP offer。
 * 我们作为**接收方**，方向是 `recvonly`；编码固定 H264 + rtcp-mux ——
 * 这是那批机型 spec 里唯一声明的视频编码（见 Video Codec Type 的值域）。
 */
function buildProbeOffer() {
  const lines = [
    'v=0',
    'o=- ' + Date.now() + ' 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=ice-ufrag:' + probeToken(8),
    'a=ice-pwd:' + probeToken(24),
    'a=ice-options:trickle',
    'a=fingerprint:sha-256 ' + probeFingerprint(),
    'a=setup:actpass',
    'a=mid:0',
    'a=recvonly',
    'a=rtcp-mux',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f'
  ];
  // SDP 规定用 CRLF 分隔
  return lines.join('\r\n') + '\r\n';
}

/** 在 spec 里找 alexa 那条 WebRTC 信令服务 */
function findWebrtcPlan(spec) {
  const services = asArray(spec && spec.services);
  for (let i = 0; i < services.length; i++) {
    const service = services[i];
    if (serviceToken(service) !== 'camera-stream-for-amazon-alexa') continue;
    const action = findAction(service, 'initiate-webrtc-session');
    if (!action) continue;
    return { service: service, action: action };
  }
  return null;
}

/**
 * 在**指定服务内**找属性。
 *
 * ⚠️ 别用 `findSpecProperty` —— 它是全局按 iid 找的，而 iid 只在服务内唯一
 * （`camera-control` 的 [2] 和 `camera-stream-for-amazon-alexa` 的 [2] 是两回事）。
 * 取流路径上那个巧合能用，是因为命中的属性恰好先被遍历到；诊断路径不能赌这个。
 */
function findServiceProperty(service, iid) {
  const props = asArray(service && service.properties);
  for (let i = 0; i < props.length; i++) {
    if (Number(props[i].iid) === Number(iid)) return props[i];
  }
  return null;
}

/** 服务清单明细（诊断报告用）：每个服务连同它的动作一起列出来 */
function describeSpecServices(spec) {
  const services = asArray(spec && spec.services);
  const lines = [];
  for (let i = 0; i < services.length; i++) {
    const service = services[i];
    const names = [];
    const actions = asArray(service.actions);
    for (let j = 0; j < actions.length; j++) {
      names.push(actionToken(actions[j]) || '?');
    }
    lines.push('  [' + service.iid + '] ' + (serviceToken(service) || '?')
      + (names.length > 0 ? '  动作: ' + names.join(' , ') : ''));
  }
  return lines;
}

/**
 * 报告最终要显示在宿主的 `TextArea` 里 —— 那里**不渲染 Markdown**。
 *
 * 于是 `**加粗**` 和 `` `代码` `` 到了用户眼前只是星号与反引号噪声：
 * 真机反馈里一整屏都是 `＊＊…＊*`，把真正要看的信息淹掉了。
 * 所以出口处统一抹掉标记、只留文字 —— 报告是纯文本，就该按纯文本写。
 *
 * 放在出口而不是逐行改写：报告有六个出口（两个探针 + 解密 + 各自的提前返回），
 * 靠人记得「新写的一行别带星号」是守不住的，统一过一道才不会漏。
 */
function plainReport(text) {
  return String(text)
    .replace(/\*\*/g, '')
    .replace(/`([^`]*)`/g, '$1');
}

/** 把出参数组原样转成可读文本（诊断要的是**原文**，不是被解释过的值） */
function dumpRawValues(out) {
  const lines = [];
  const list = asArray(out);
  if (list.length === 0) {
    lines.push('  (出参为空)');
    return lines;
  }
  for (let i = 0; i < list.length; i++) {
    const value = list[i];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    lines.push('  [' + i + '] ' + typeof value + '  长度=' + String(text || '').length);
    lines.push('      开头 400 字符：' + String(text || '').substring(0, 400));
  }
  return lines;
}

/**
 * 三类「不是载荷」的键 —— 判定「云端到底给没给东西」时必须**全都**排除。
 *
 *   ① 元数据：只说这次调用成不成功（code / message …）
 *   ② 回显键：把请求参数原样复读回来（did / siid / aiid …），不含任何新信息
 *   ③ 遥测键：执行耗时 / 网络时延 / 时间戳（exe_time / net_cost / otlocalts …）
 *
 * 🔴 ③ 是最容易漏的一类。真机 `start-p2p-stream` 的返回体长这样：
 *
 *     {"did":"1077776155","miid":0,"siid":9,"aiid":1,"code":0,"exe_time":79,
 *      "net_cost":69,"ot_cost":28,"otlocalts":1790001896467469,
 *      "oa_rpc_cost":181,"withLatency":0}
 *
 *   十个键里**没有一个是载荷，连 `out` 键都不存在**。
 *   只排除 ① 的话，这十键会被当成「有内容」，于是又一次误报成
 *   「看不懂，请交回开发者」—— 同一个坑踩两遍，只是换了个马甲。
 *   所以判定必须一眼看穿「回显 + 遥测」这一整个信封。
 */
function classifyKey(k) {
  const low = String(k).toLowerCase();
  // ① 状态元数据（只说成不成功）
  if (low === 'code' || low === 'message' || low === 'msg' || low === 'status'
    || low === 'id' || low === 'traceid' || low === 'trace_id' || low === 'timestamp') {
    return '元数据';
  }
  // ② 回显（请求参数的复读）
  if (low === 'did' || low === 'miid' || low === 'siid' || low === 'aiid'
    || low === 'iid' || low === 'piid' || low === 'uid') {
    return '回显';
  }
  // ③ 遥测（耗时 / 时延 / 时间戳）—— 用模式匹配而非枚举：
  //    云端随时会加新字段名，枚举一漏就又是一次误报。
  if (low.indexOf('cost') >= 0) return '遥测';
  if (low.indexOf('latency') >= 0) return '遥测';
  if (low.indexOf('time') >= 0) return '遥测';
  // 时间戳：以 ts 结尾（ts / ots / localts / otlocalts）——
  // 注意别用「长度 <= 8」这类阈值卡，`otlocalts` 就有 9 个字符，
  // 卡掉它这一条，整个信封判定就又被顶穿了。
  if (low.length <= 12 && low.substring(low.length - 2) === 'ts') return '遥测';
  return '';
}

/** 这个键是否**不可能是载荷**（元数据 / 回显 / 遥测三类都算） */
function isNoiseKey(k) {
  return classifyKey(k).length > 0;
}

/** 兼容旧名：顶层键一览里只关心「是不是元数据」时用它 */
function isMetaKey(k) {
  return classifyKey(k).length > 0;
}

/**
 * 把一次动作调用的**整个返回体**原样摊开（诊断要的是原文，不是被解释过的值）。
 *
 * 🔴 为什么不能只 dump `out`：
 *   `/miotspec/action` 的返回体从来不止 `out` 一个键，真机常见
 *   `{code:0, out:[], message:'…'}`，私有参数还可能挂在 out 之外的键上。
 *   而 `callAction()` 只回 `out.out`（见其注释）—— 用它会**静默丢掉**
 *   恰恰是探测最想拿到的那些字段。所以诊断路径一律直打 request，
 *   再用这个函数把顶层键、完整原文、出参数组三层全交出来。
 *
 * 报告是给人看的，因此三个层次都要有：**先看键名判断有没有料**，
 * **再看原文逐字核对**，最后才是被解释过的出参。
 */
function dumpActionResult(result) {
  const lines = [];
  if (result === null || result === undefined) {
    lines.push('  (返回体为空)');
    lines.push('');
    return lines;
  }
  if (typeof result !== 'object') {
    lines.push('  (返回体不是对象) ' + String(result).substring(0, 400));
    lines.push('');
    return lines;
  }

  const keys = Object.keys(result);
  lines.push('  ── 返回体顶层键（共 ' + keys.length + ' 个）──');
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const v = result[k];
    let shape = '';
    if (v === null || v === undefined) {
      shape = String(v);
    } else if (v instanceof Array) {
      shape = '数组 长度=' + v.length;
    } else if (typeof v === 'object') {
      shape = '对象 键=' + Object.keys(v).join(',');
    } else {
      shape = typeof v + '=' + String(v).substring(0, 80);
    }
    const kind = classifyKey(k);
    lines.push('    · ' + k + '  →  ' + shape + (kind ? '   (' + kind + ')' : ''));
  }
  /*
   * 显式点出「有没有 out」——真机上 `start-p2p-stream` 的返回体里
   * **压根没有 out 这个键**，只回声 + 遥测。这种形状光看键名列表容易
   * 被理解成「还没找到 out」，说破了才清楚：不是没找到，是不存在。
   */
  if (result.out === undefined) {
    lines.push('    ⚠️ 返回体里**没有 `out` 键** —— 这个动作的响应结构里就没有出参位。');
  }
  lines.push('');

  const json = JSON.stringify(result);
  const LIMIT = 1200;
  lines.push('  ── 完整原文' + (json.length > LIMIT ? '（截断至 ' + LIMIT + ' 字符，共 ' + json.length + '）' : '') + ' ──');
  lines.push('  ' + json.substring(0, LIMIT));
  lines.push('');

  /*
   * 没有 `out` 键时**不再列**「出参明细」。
   *
   * 上面刚说完「响应结构里没有出参位」，这里再挂一个「(出参为空)」，
   * 读者会理解成「有出参位、只是这次空着」—— 两种完全不同的形状
   * 又被搅回一起了。说了不存在，就别再摆一个空盘子。
   */
  if (result.out !== undefined) {
    lines.push('  ── 出参 out 明细 ──');
    const rawLines = dumpRawValues(result.out);
    for (let i = 0; i < rawLines.length; i++) lines.push(rawLines[i]);
  }
  return lines;
}

/**
 * 打一次动作调用并交出**完整返回体**（探针专用，与 `callAction` 的分工是：
 * 后者给业务用、只回 out；这个给诊断用、什么都留着）。
 * `code !== 0` 依旧抛错 —— 失败本身也是探测结论，
 * 上层 catch 要能分清「云端拒了」和「返回了个看不懂的东西」。
 */
async function actionRaw(did, siid, aiid, inList) {
  const result = await request('/miotspec/action', {
    did: did,
    params: { did: did, siid: siid, aiid: aiid, in: asArray(inList) }
  });
  if (result && Number(result.code) !== 0) {
    throw new Error('设备拒绝 code=' + result.code
      + (result.message ? '（' + result.message + '）' : ''));
  }
  return result || {};
}

/** 一个值算不算「什么都没给」：空串 / 空数组 / 空对象 / null 都算 */
function isBlankPayload(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (v instanceof Array) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/**
 * 返回体里**除噪音键外**是否一个载荷都没有。
 *
 * 五种「空」都要算进来，缺一种就会误报：
 *   · 压根没有非噪音键（`{code:0}`）
 *   · 有 out 但数组为空（`{code:0,out:[]}`）
 *   · 有 out 但里面全是空串（`{code:0,out:['']}`）
 *   · 只有 code / message 这类元数据（`{code:0,out:[],message:'ok'}`）
 *   · **只有回显 + 遥测、连 out 键都没有**（真机 start-p2p-stream 的实际形状）
 *
 * 反过来，out 之外**任何**不属于噪音的键都算载荷：P2P 参数若要下发，
 * 最可能挂在那儿，绝不能漏判。
 */
function actionPayloadIsEmpty(result) {
  if (!result || typeof result !== 'object') return true;
  const keys = Object.keys(result);
  const outList = asArray(result.out);
  for (let i = 0; i < outList.length; i++) {
    if (!isBlankPayload(outList[i])) return false;
  }
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (isNoiseKey(k) || k === 'out') continue;
    if (!isBlankPayload(result[k])) return false;
  }
  return true;
}


/* ── 网关（路由器）局域网管理 ───────────────────────────────────────
 * 小米路由器在局域网内另有一套 luci 接口（`http://<网关>/cgi-bin/luci/...`），
 * 与云平台**完全独立**：凭据是**路由器管理密码**，不是米家令牌；
 * 口令算法按固件代次分两套（SHA1 / SHA256）。协议来自社区逆向文档
 * （GitHub MiWiFi-API 一类项目）+ 抓包，**没有官方承诺**，固件升级可能变更。
 *
 * 四条必须守住的红线：
 *
 *  1. **凭据隔离**：管理密码存 `secureStore` 的独立键（`miwifi_<did>`），
 *     绝不写进云平台那份 auth JSON —— 两者的权限级别完全不同
 *     （云令牌只能控设备，管理密码能改整网配置）。
 *  2. **只打局域网明文 http**：地址来自用户设备所在的网段，
 *     绝不把它当公网地址用、也绝不附带任何云平台 Cookie。
 *  3. **口令算法按代次**：`init_info` 是免登录的，先问它拿到 routerId，
 *     再用 routerId 构造 nonce；两代哈希算法各试一次（见 hashCandidates）。
 *  4. **失败要抛出**：宿主页面靠异常提示用户（「密码不对」和「网络不通」
 *     对用户是两件事），返回空对象会让界面显示成「没有设备」。
 */
const MIWIFI_KEY = 'a2ffa5c9be07488bbb04a3a47d3c5f6a';
/** 局域网请求超时：路由器就在身边，5 秒足够；久等只会让页面卡住 */
const MIWIFI_TIMEOUT_MS = 5000;
/** 探测网关地址时的超时：更短，因为要试好几个候选地址 */
const MIWIFI_PROBE_TIMEOUT_MS = 2500;

/** 当前会话（内存态，插件被重载后靠 secureStore 里的密码重建） */
const gwSession = { ip: '', stok: '', variant: '' };

/**
 * 部分 luci 接口会返回 `while(1);{...}` 前缀（防 JSON 劫持），先剥掉。
 */
function stripJsonPrefix(text) {
  const body = String(text === undefined || text === null ? '' : text).trim();
  if (body.indexOf('while(1);') === 0) {
    return body.substring(8).trim();
  }
  return body;
}

function parseLuciJson(response) {
  const raw = response && response.body !== undefined ? response.body : '';
  const text = stripJsonPrefix(raw);
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('网关返回的不是 JSON（可能地址不是这台路由器）: ' + text.substring(0, 60));
  }
}

/** 网关地址候选顺序：设备记录里的本机地址 → 小米默认网关 → 常见家用网段 */
function gatewayCandidates(device) {
  const out = [];
  const push = function (value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (!text || out.indexOf(text) >= 0) return;
    out.push(text);
  };
  // 只有形如 IPv4 的 local_ip 才值得试（云端有时给的是空串或域名）
  const localIp = device && device.localIp ? String(device.localIp) : '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(localIp)) {
    push(localIp);
  }
  push('192.168.31.1');
  push('192.168.1.1');
  push('192.168.0.1');
  return out;
}

function luciUrl(ip, path) {
  if (gwSession.stok) {
    return 'http://' + ip + '/cgi-bin/luci/;stok=' + gwSession.stok + path;
  }
  return 'http://' + ip + '/cgi-bin/luci' + path;
}

async function luciGet(ip, path) {
  const res = await Host.http('GET', luciUrl(ip, path), { 'Accept': 'application/json' }, undefined, MIWIFI_TIMEOUT_MS);
  if (!res || res.status !== 200) {
    throw new Error('网关返回状态 ' + (res ? res.status : '空'));
  }
  return parseLuciJson(res);
}

/**
 * 一次登录尝试。`material` 决定第二次哈希的拼接物（密钥 or nonce），
 * `algo` 决定用 SHA1 还是 SHA256 —— 这两个维度就是社区文档里那几代算法的差异。
 */
async function loginOnce(ip, password, material, algo) {
  const inner = await Host.crypto.sha1Hex(password);
  const outer = algo === 'sha256'
    ? await Host.crypto.sha256Hex(inner + material)
    : await Host.crypto.sha1Hex(inner + material);
  const res = await Host.httpForm(
    'http://' + ip + '/cgi-bin/luci/api/xqsystem/login',
    { 'Accept': 'application/json' },
    { username: 'admin', password: outer, logtype: '2', nonce: gwSession.nonce }
  );
  if (!res || res.status !== 200) {
    throw new Error('登录接口返回状态 ' + (res ? res.status : '空'));
  }
  return parseLuciJson(res);
}

/** 从登录响应里抠出 stok：有的固件给 token 字段，有的只在 url 里带 */
function extractStok(body) {
  if (!body) return '';
  if (body.token) return String(body.token);
  if (body.stok) return String(body.stok);
  const url = String(body.url || '');
  const m = url.match(/;stok=([^/]+)/);
  return m ? m[1] : '';
}

/**
 * 探测并缓存网关地址。
 * 顺序试候选地址，谁能答上 `init_info` 就算找到 —— 不做「ping」，
 * 因为浏览器沙箱里没有 ICMP，而 init_info 本来就是免登录的。
 */
async function resolveGatewayIp(device, force) {
  if (!force && gwSession.ip) {
    return gwSession.ip;
  }
  const candidates = gatewayCandidates(device);
  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      const info = await luciGet(candidates[i], '/api/xqsystem/init_info');
      if (info && (info.hardware || info.romVersion || info.routerId)) {
        gwSession.ip = candidates[i];
        return candidates[i];
      }
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error('没有找到小米路由器（试过 ' + candidates.join('、') + '）'
    + (lastError ? '：' + lastError.message : ''));
}

/** 库里的密码（含上次成功的算法变体） */
async function loadGatewayCredential(did) {
  try {
    const stored = await Host.secureStore.get('miwifi_' + did);
    if (!stored) return null;
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (!parsed || !parsed.password) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

async function saveGatewayCredential(did, password, variant) {
  const payload = JSON.stringify({ password: password, variant: variant, savedAt: Date.now() });
  await Host.secureStore.set('miwifi_' + did, payload);
}

/**
 * 建立会话：先解析地址 → init_info → 构造 nonce → 试算法 → 存 stok。
 *
 * ⚠️ 两代哈希会在**一次登录里顺序试**。代价是密码真的输错时多耗一次尝试
 * （小米路由器连续失败会短暂锁定），收益是不用让用户「换个算法再点一次」——
 * 后者对用户来说是完全不可理解的。失败时把两次的原始返回都拼进错误信息，
 * 便于事后判断到底是密码错还是算法代次不对。
 */
async function ensureGatewaySession(device, password) {
  const did = String(device && device.did ? device.did : '');
  if (!did) throw new Error('缺少设备 did');
  if (gwSession.stok && gwSession.ip && gwSession.did === did) {
    return gwSession;
  }

  let credential = null;
  let plain = password;
  if (!plain) {
    credential = await loadGatewayCredential(did);
    if (!credential) {
      throw new Error('还没有保存过这台路由器的管理密码，请先登录');
    }
    plain = credential.password;
    gwSession.variant = credential.variant || '';
  }

  const ip = await resolveGatewayIp(device, !gwSession.ip);
  const initInfo = await luciGet(ip, '/api/xqsystem/init_info');
  // routerId 就是米家 did；拿不到就用设备自己的 did（两者通常一致）
  const deviceKey = String(initInfo.routerId || (device && device.did) || 'miha');
  gwSession.nonce = '0_' + deviceKey + '_' + Math.floor(Date.now() / 1000)
    + '_' + (1000 + Math.floor(Math.random() * 9000));
  gwSession.initInfo = initInfo;

  const attempts = [];
  // 上次成功过的变体优先（省一次失败尝试）
  const order = gwSession.variant === 'nonce' ? ['nonce', 'key'] : ['key', 'nonce'];
  let lastBody = null;
  for (let i = 0; i < order.length; i++) {
    const variant = order[i];
    const material = variant === 'key' ? MIWIFI_KEY : gwSession.nonce;
    const algo = String(gwSession.nonce).charAt(0) === '4' ? 'sha256' : 'sha1';
    const body = await loginOnce(ip, plain, material, algo);
    lastBody = body;
    const code = Number(body && body.code !== undefined ? body.code : 0);
    if (code === 0) {
      const stok = extractStok(body);
      if (!stok) {
        throw new Error('登录成功但没有拿到会话令牌（固件格式有变）');
      }
      gwSession.stok = stok;
      gwSession.did = did;
      gwSession.variant = variant;
      if (password) {
        await saveGatewayCredential(did, password, variant);
      }
      await Host.log.info('mijia', '网关登录成功 ip=' + ip + ' 算法=' + algo + '/' + variant)
        .catch(function () {});
      return gwSession;
    }
    attempts.push(variant + ' → ' + JSON.stringify(body).substring(0, 120));
  }
  throw new Error('网关登录失败（密码错误，或这台固件的口令算法代次不同）：'
    + attempts.join(' | '));
}

/** 把 misystem/status 的原始结构翻译成宿主认识的字段（缺的给 -1） */
function normalizeGatewayStatus(initInfo, status) {
  const cpu = (status && status.cpu) || {};
  const mem = (status && status.mem) || {};
  const wan = (status && status.dev && status.dev.wan) || {};
  const count = (status && status.count) || {};
  const load = asNumber(cpu.load, -1);
  /*
   * 小米给的 `cpu.load` 是「每核平均负载」（1.0 = 满载）的浮点数，
   * 换算成百分比要乘 100。上限截到 999：有的固件直接给百分比，
   * 那样乘出来会是几千，截一下至少不会在界面上出现荒唐的数字。
   */
  const cpuPercent = load < 0 ? -1 : Math.min(Math.round(load * 100), 999);
  const memTotal = asNumber(mem.total, 0);
  const memUsage = asNumber(mem.usage, 0);
  const memPercent = memTotal > 0 ? Math.round(memUsage / memTotal * 100) : -1;
  return {
    model: String(initInfo.hardware || ''),
    firmware: String(initInfo.romVersion || ''),
    routerDid: String(initInfo.routerId || ''),
    bound: Number(initInfo.bound) === 1 || initInfo.bound === true,
    onlineClients: asNumber(count.online, -1),
    uptimeSeconds: asNumber(status && status.uptime, -1),
    cpuPercent: cpuPercent,
    memoryPercent: memPercent,
    temperature: asNumber(status && status.temperature, -1),
    /*
     * ⚠️ 速率的单位按**字节/秒**处理（社区文档如此）。若某固件给的是 KB/s，
     * 显示值会小 1024 倍 —— 这是本模块唯一无法在本地验证的量纲，
     * 已列入 docs/摄像头与路由器适配调研.md 的未验证项。
     */
    downloadSpeed: asNumber(wan.download, -1),
    uploadSpeed: asNumber(wan.upload, -1)
  };
}

/** devicelist 里 ip 字段的形状随固件变化：字符串 / 数组 / 对象都见过 */
function extractClientIp(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Array) {
    for (let i = 0; i < value.length; i++) {
      const one = extractClientIp(value[i]);
      if (one) return one;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    if (value.ip) return String(value.ip);
  }
  return '';
}

/** 拉黑判定：`authority.wan == 0` 即禁外网（set_mac_filter 的语义） */
function isClientBlocked(item) {
  const authority = (item && item.authority) || {};
  if (authority.wan !== undefined && authority.wan !== null) {
    return Number(authority.wan) === 0;
  }
  return false;
}

function normalizeClient(item) {
  const stats = (item && item.statistics) || {};
  return {
    mac: String((item && item.mac) || '').toLowerCase(),
    ip: extractClientIp(item ? item.ip : ''),
    // name 为空时用 oname（部分固件把备注放这里），再空就退到 mac（宿主会显示它）
    name: String((item && item.name) || (item && item.oname) || ''),
    online: asNumber(stats.online, 0) > 0 || extractClientIp(item ? item.ip : '') !== '',
    blocked: isClientBlocked(item),
    downloadSpeed: asNumber(stats.downspeed, -1),
    uploadSpeed: asNumber(stats.upspeed, -1),
    onlineSeconds: asNumber(stats.online, -1)
  };
}

/* ── 设备能力描述（spec）──────────────────────────────────────────
 * 与内置版同源的两条路径（MIoTSpecParser / MijiaSpecClient 的 JS 版）：
 * ① 有 urn（米家 spec_type）→ miot-spec.org 的 instance JSON **原样透传** ——
 *    宿主 PluginDataSource 拿到后自己走 parseMIoTSpecInstance，形状零转换零风险；
 * ② 只有 model → home.miot-spec.com 的规格页 HTML 里抠 page JSON ——
 *    它是 camelCase（valueRange/valueList），而宿主解析器吃 kebab-case
 *    （value-range/value-list），必须逐层改名转形状。
 * spec 极少变化，进程内缓存一份即可。
 */
const specCache = {};

async function fetchSpecInstance(urn) {
  const url = 'https://miot-spec.org/miot-spec-v2/instance?type=' + encodeURIComponent(urn);
  const res = await Host.http('GET', url, {}, undefined, 20000);
  if (!res || res.status !== 200) {
    throw new Error('miot-spec.org 返回状态 ' + (res ? res.status : '空'));
  }
  const parsed = JSON.parse(res.body);
  if (!parsed || !parsed.type) {
    throw new Error('miot-spec.org 响应缺 type 字段');
  }
  return parsed;
}

async function fetchSpecByModel(model) {
  const res = await Host.http('GET', 'https://home.miot-spec.com/spec/' + encodeURIComponent(model), {}, undefined, 20000);
  if (!res || res.status !== 200) {
    throw new Error('home.miot-spec.com 返回状态 ' + (res ? res.status : '空'));
  }
  const m = String(res.body).match(/<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) {
    throw new Error('home.miot-spec.com 页面里没有 spec JSON');
  }
  const page = JSON.parse(m[1].trim());
  const props = (page && page.props) || {};
  const product = props.product || {};
  const tree = props.tree || {};
  // urn 兜底与内置版 parseMijiaSpecPageJson 一致：tree 缺 type 时按 model 拼
  return {
    type: tree.type || ('urn:miot-spec-v2:device:' + model),
    description: product.name || model,
    services: convertSpecServices(tree.services)
  };
}

function convertSpecServices(services) {
  const out = [];
  if (!(services instanceof Array)) return out;
  for (let i = 0; i < services.length; i++) {
    const s = services[i] || {};
    out.push({
      iid: s.iid,
      type: s.type,
      description: s.description,
      properties: convertSpecProperties(s.properties),
      actions: s.actions instanceof Array ? s.actions : []
    });
  }
  return out;
}

function convertSpecProperties(properties) {
  const out = [];
  if (!(properties instanceof Array)) return out;
  for (let i = 0; i < properties.length; i++) {
    const p = properties[i] || {};
    // camelCase → kebab-case；value-list 的条目形状两边一致（value/description）直接透传
    const converted = {
      iid: p.iid,
      type: p.type,
      description: p.description,
      format: p.format,
      access: p.access instanceof Array ? p.access : []
    };
    if (p.unit !== undefined) converted.unit = p.unit;
    if (p.valueRange !== undefined) converted['value-range'] = p.valueRange;
    if (p.valueList !== undefined) converted['value-list'] = p.valueList;
    out.push(converted);
  }
  return out;
}

/* ================================================================ 插件 */

Plugin.register({
  /**
   * ① 初始化：载入凭据并恢复设备指纹。
   *
   * ⚠️ Host 桥的信封拆包（unwrap）会把「形似 JSON 的字符串」自动 parse 成对象：
   * set 存进去的是 JSON 字符串，get 读回来的**可能已经是对象**（也可能还是
   * 字符串，取决于内容首字符是不是 { 或 [）。所以这里必须两种形状都接得住 ——
   * 直接 JSON.parse(stored) 的话，对象会被隐式 String() 成 "[object Object]"
   * 再炸出语法错误，init 永远 false（真机踩过：登录成功但家庭/设备全空）。
   */
  async init() {
    try {
      const stored = await Host.secureStore.get('auth');
      if (!stored) return false;
      auth = (typeof stored === 'string') ? JSON.parse(stored) : stored;
      deviceId = auth.deviceId;
      passO = auth.passO;
      userAgent = auth.userAgent;
      await Host.log.info('mijia', '凭据已载入，uid=' + auth.userId);
      return true;
    } catch (e) {
      // init 失败曾经被完全吞掉（return false 不留痕迹），真机上查了一整晚
      await Host.log.error('mijia', 'init 恢复凭据失败: ' + e).catch(function () {});
      return false;
    }
  },

  /**
   * ② 登录第一步：交付二维码。
   *
   * ⚠️ 视图契约有三个容易踩的点（对照 `PluginLogin.parseLoginView`）：
   *   - 二维码地址的字段名是 **`imageUrl`**，不是 `payload` / `qr`
   *   - 必须给 **`pollInterval`**（毫秒）且 > 0，否则宿主**根本不会轮询**，
   *     二维码就一直挂在那没人处理
   *   - 返回的对象里除了 `sessionId` 和 `view`，其余字段宿主不读 ——
   *     所以轮询地址要存在插件自己的状态里（`pendingLp`），不能指望回传
   */
  async loginBegin() {
    // ⚠️ 设备指纹（deviceId/passO/userAgent）必须**持久化复用**，不能每次登录
    // 都随机生成 —— 每次都是「全新设备」，风控眼里就是批量登录的机器人
    // （真机踩过：一晚上反复登录后整条登录链被 403 拦截）。真机 App 的
    // deviceId 是稳定的，这里对齐这个行为。
    let fp = null;
    try {
      const stored = await Host.secureStore.get('fingerprint');
      if (stored) fp = (typeof stored === 'string') ? JSON.parse(stored) : stored;
    } catch (e) {
      fp = null;
    }
    if (!fp || !fp.deviceId || !fp.passO || !fp.userAgent) {
      deviceId = await randomHex(16);
      passO = await randomHex(16);
      userAgent = UA_PREFIX + '-' + await randomHex(40) + '-CN-'
        + await randomHex(32) + '-' + await randomHex(32)
        + '-SmartHome-MI_APP_STORE-' + await randomHex(40)
        + '|' + await randomHex(40) + '|' + passO + '-64';
      await Host.secureStore.set('fingerprint',
        JSON.stringify({ deviceId: deviceId, passO: passO, userAgent: userAgent })
      ).catch(function () {});
    } else {
      deviceId = fp.deviceId;
      passO = fp.passO;
      userAgent = fp.userAgent;
    }
    cookieJar = '';

    const ticket = await fetchLoginTicket();
    // 轮询地址存在插件侧：宿主的 loginPoll 只传 sessionId，不带别的
    pendingLp = ticket.lp;

    return {
      sessionId: 'mijia-' + Date.now(),
      view: {
        type: 'qr',
        imageUrl: ticket.qr,
        hint: '用米家 App 扫码登录',
        pollInterval: POLL_INTERVAL_MS,
        expiresIn: QR_EXPIRES_SECONDS
      }
    };
  },

  /**
   * ③ 轮询扫码状态。
   *
   * ⚠️ 宿主只传 `sessionId`（见 `PluginManager.startPolling`）——
   * 轮询地址要从插件自己的 `pendingLp` 取，不能指望参数里带。
   *
   * ⚠️ 「还没扫」必须返回 `state: 'pending'`，**不能抛错**：
   * 宿主连续 3 次收到异常就判登录失败，用户刚掏出手机二维码就没了。
   */
  async loginPoll(sessionId) {
    if (!pendingLp) return { state: 'error', message: '缺少轮询地址' };

    let credentials;
    try {
      credentials = await pollLoginTicket(pendingLp);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      // 「还没扫」不是错误 —— 长轮询超时也会走到这里
      if (msg === 'waiting' || msg.indexOf('waiting') >= 0) {
        return { state: 'pending' };
      }
      if (msg.indexOf('Invalid Token') >= 0) {
        return { state: 'expired', message: msg };
      }
      // 网络抖动也不该立刻判失败，交给宿主的重试容忍逻辑
      return { state: 'pending', message: msg };
    }

    auth = credentials;
    pendingLp = '';
    await Host.secureStore.set('auth', JSON.stringify(auth));
    await Host.log.info('mijia', '登录成功 uid=' + auth.userId);
    return { state: 'success' };
  },

  async loginCancel() {
    cookieJar = '';
    pendingLp = '';
    return { state: 'cancelled' };
  },

  /** ④ 家庭列表。字段名按宿主 `Home` 形状：id / name / uid / dids / roomlist */
  async getHomes() {
    if (!auth) return [];
    const result = await request('/v2/homeroom/gethome_merged', {
      fg: true,
      fetch_share: true,
      fetch_share_dev: true,
      fetch_cariot: true,
      limit: 300,
      app_ver: 7,
      plat_form: 0
    });

    const homes = [];
    const seen = [];
    // 自建家庭 / 共享家庭 / 另一种共享键名，三处都要收（宿主也是三路）
    const sources = [result.homelist, result.share_home_list, result.share_homelist];
    for (let s = 0; s < sources.length; s++) {
      const list = asArray(sources[s]);
      for (let i = 0; i < list.length; i++) {
        const raw = list[i] || {};
        const id = String(raw.id || '');
        if (!id || seen.indexOf(id) >= 0) continue;
        seen.push(id);
        homes.push({
          id: id,
          name: String(raw.name || id),
          uid: String(raw.uid || ''),
          dids: [],
          roomlist: asArray(raw.roomlist).map(function (r) {
            return { id: String(r.id || ''), name: String(r.name || '') };
          })
        });
      }
    }
    return homes;
  },

  /** ⑤ 设备列表。key 必须是 did —— 宿主按 key 索引 */
  async getDevices() {
    if (!auth) return {};
    const homes = await this.getHomes();
    const out = {};

    for (let h = 0; h < homes.length; h++) {
      const home = homes[h];
      let startDid = '';
      // 分页：服务端一次最多给一批，靠 max_did 续
      for (let page = 0; page < 20; page++) {
        let result;
        try {
          result = await request('/home/home_device_list', {
            home_owner: Number(home.uid) || 0,
            home_id: Number(home.id),
            limit: 200,
            start_did: startDid,
            get_split_device: true,
            support_smart_home: true,
            get_cariot_device: true,
            get_third_device: true
          });
        } catch (e) {
          await Host.log.error('mijia', '取设备失败 home=' + home.id + ' ' + e);
          break;
        }

        const list = asArray(result.device_info);
        for (let i = 0; i < list.length; i++) {
          const device = toDevice(list[i], home.id);
          if (device) {
            // key 必须是 did：宿主按 key 索引（虽然它也会按 did 字段兜底重建）
            out[String(device.did)] = device;
          }
        }

        const maxDid = String(result.max_did || '');
        if (list.length === 0 || !maxDid || maxDid === startDid) break;
        startDid = maxDid;
      }
    }

    await Host.log.info('mijia', '载入 ' + Object.keys(out).length + ' 个设备');
    return out;
  },

  /**
   * ⑥ 设备能力描述。
   *
   * 曾经是 `return null` + capabilities.spec=false（当样例时故意留空让宿主降级）。
   * 内置源退役后插件成了唯一数据源，这里必须真正实现，否则详情页整页报
   * 「不提供设备能力描述」。宿主 parseDevice 已把米家的 spec_type 映射成
   * SmartDevice.urn，所以 device 上直接读 urn / model 两个驼峰字段。
   *
   * 返回的是 miot-spec.org 的原始 instance JSON —— 宿主自己解析，
   * 插件不做二次加工（与内置版 MIoTSpecParser 的契约完全一致）。
   */
  async getSpecForDevice(device) {
    if (!auth) return null;
    const urn = device && device.urn ? String(device.urn) : '';
    const model = device && device.model ? String(device.model) : '';
    if (!urn && !model) {
      throw new Error('设备既无 spec_type（urn）也无 model，无法获取能力描述');
    }
    const cacheKey = urn || ('model:' + model);
    if (specCache[cacheKey]) {
      return specCache[cacheKey];
    }
    const instance = urn ? await fetchSpecInstance(urn) : await fetchSpecByModel(model);
    specCache[cacheKey] = instance;
    await Host.log.info('mijia', 'spec 已载入 ' + cacheKey + '（services='
      + (instance.services ? instance.services.length : 0) + '）').catch(function () {});
    return instance;
  },

  /**
   * ⑦ 控制通道。
   *
   * 只有云端一条 —— LAN 与 MIPS 留在宿主，不搬（见 docs/插件化改造调研.md §7）。
   * `priority` 小的先试，这里只有一条所以取 100。
   */
  async createTransports() {
    return [{ id: 'mijia-cloud', kind: 'cloud', priority: 100 }];
  },

  async isTransportAvailable(transportId) {
    return transportId === 'mijia-cloud' && auth !== null;
  },

  /**
   * ⑧ 读属性。
   *
   * ⚠️ 返回 `undefined` 是「读到了但没这个属性」，**不是**「读失败」。
   * 读失败要 throw，宿主据此走降级路径。
   */
  async getProperty(transportId, did, siid, piid) {
    if (!auth) throw new Error('未登录');
    const result = await request('/miotspec/prop/get', {
      params: [{ did: did, siid: siid, piid: piid }],
      datasource: 0
    });
    const list = asArray(result);
    if (list.length === 0) return undefined;
    const first = list[0] || {};
    if (Number(first.code) !== 0) throw new Error('设备返回 code=' + first.code);
    return first.value;
  },

  async getProperties(transportId, did, params) {
    if (!auth) throw new Error('未登录');
    const requestParams = [];
    for (let i = 0; i < params.length; i++) {
      requestParams.push({
        did: params[i].did || did,
        siid: params[i].siid,
        piid: params[i].piid
      });
    }
    const result = await request('/miotspec/prop/get', {
      params: requestParams,
      datasource: 0
    });
    const list = asArray(result);
    const out = [];
    for (let i = 0; i < requestParams.length; i++) {
      const p = requestParams[i];
      // 逐条对齐返回值，拿不到就是 undefined（不是失败）
      const found = list[i];
      out.push({
        did: p.did,
        siid: p.siid,
        piid: p.piid,
        value: (found && Number(found.code) === 0) ? found.value : undefined
      });
    }
    return out;
  },

  /**
   * ⑨ 写属性。
   *
   * ⚠️ 米家的写请求载荷是**两层 did**：外层一个、`params[]` 里再一个。
   * 少写一个会被服务端判非法 —— 这类错误在真机上只表现为「点了没反应」。
   *
   * ⚠️ 失败必须 throw。返回 false 会被宿主当成功，界面显示「已打开」
   * 而设备没动 —— 最难查的一类 bug。
   */
  async setProperty(transportId, did, siid, piid, value) {
    if (!auth) throw new Error('未登录');
    const body = {
      did: did,
      params: [{ did: did, siid: siid, piid: piid, value: value }]
    };
    await Host.log.info('mijia', 'prop/set did=' + did + ' siid=' + siid + ' piid=' + piid
      + ' value=' + JSON.stringify(value) + ' (typeof ' + typeof value + ')'
      + ' body=' + JSON.stringify(body)).catch(function () {});
    const result = await request('/miotspec/prop/set', body);
    await Host.log.info('mijia', 'prop/set 响应: ' + JSON.stringify(result)).catch(function () {});
    const list = asArray(result);
    const first = list[0];
    const code = first ? Number(first.code) : 0;
    // ⚠️ BLE Mesh 网关控制是异步的：code=1 表示「网关已受理、等设备回报」，
    // 官方文档明确「可视为成功」。只有非 0/1 才是真失败。
    if (code !== 0 && code !== 1) {
      throw new Error('设备拒绝写入 code=' + first.code);
    }
    // 契约是「返回属性值」，回显请求值
    return value;
  },

  /** ⑩ 执行动作。`params` 是**单个对象**，不是数组（与 set_properties 不同） */
  async callAction(transportId, did, siid, aiid, inList) {
    if (!auth) throw new Error('未登录');
    const body = {
      did: did,
      params: {
        did: did,
        siid: siid,
        aiid: aiid,
        in: asArray(inList)
      }
    };
    await Host.log.info('mijia', 'action did=' + did + ' siid=' + siid + ' aiid=' + aiid
      + ' in=' + JSON.stringify(asArray(inList))).catch(function () {});
    const result = await request('/miotspec/action', body);
    await Host.log.info('mijia', 'action 响应: ' + JSON.stringify(result)).catch(function () {});
    const out = result || {};
    const acode = Number(out.code);
    // 同 setProperty：BLE Mesh 网关下 code=1 = 已受理（异步执行），非 0/1 才是真失败
    if (acode !== 0 && acode !== 1) throw new Error('动作执行失败 code=' + out.code);
    return out.out !== undefined ? out.out : {};
  },

  /**
   * ⑫ 取实时视频流地址（摄像头直播）。
   *
   * 宿主播放页会调它两次以上：进页面一次，流失效后再来一次。
   * 所以这里必须**拿到地址后立刻返回**，不要在里面等待任何播放事件 ——
   * 宿主侧的单次调用超时是 60 秒，而直播本身是长连接。
   *
   * 返回 `{url, kind, expiresIn}`：
   *   - kind = hls / rtsp（页面据此决定能不能直接交 AVPlayer）
   *   - expiresIn = 秒，0 表示未知
   */
  async getStreamUrl(device) {
    if (!auth) throw new Error('未登录');
    const did = device && device.did ? String(device.did) : '';
    if (!did) throw new Error('getStreamUrl 缺少 did');

    // ① 手动地址优先：用户按提示自己在米家 App 里开了「局域网监控」之后填进来的那条。
    //    不过期、不走云端 —— 也该排在云端动作前面，省一次请求，也省一次可能的失败
    const manual = await loadManualStream(did);
    if (manual) {
      return { url: manual, kind: kindOfUrl(manual), expiresIn: 0, source: 'manual' };
    }

    // ② 命中的云端缓存直接复用：同一台摄像头在有效期内重复取流是浪费，
    //    而且部分机型连续 start 会让前一路流被顶掉（表现为画面刚出来就断）
    const cached = streamCache[did];
    if (cached && cached.expireAt > Date.now()) {
      return {
        url: cached.url,
        kind: cached.kind,
        expiresIn: Math.round((cached.expireAt - Date.now()) / 1000),
        source: 'cloud'
      };
    }

    const spec = await this.getSpecForDevice(device);
    const plan = findStreamPlan(spec);
    if (!plan) {
      // 失败要说清是**哪一种**「不支持」：WebRTC 新机型 / 纯 P2P 机型 / 连服务都没有
      // —— 三种情况用户的预期完全不同。顺手把服务列表带上，一次把信息给全，
      // 省掉一轮「你那台有什么服务」的来回。
      const support = describeStreamSupport(spec);
      throw new Error(describeStreamMode(support.mode)
        + '（设备服务：' + (support.services.join('/') || '无') + '）');
    }

    const raw = await this.callAction('mijia-cloud', did, plan.siid, plan.aiid, plan.args);
    const url = pickStreamUrl(raw, plan.urlIndex);
    if (!url) {
      throw new Error('设备没有返回流地址（动作 code=0 但 out 为空，'
        + '通常是这台机型的取流动作需要米家 App 私有参数）');
    }

    // 有效期：先读设备属性，读不到退回默认值（见 findExpirationPiid 的说明）
    let ttlSeconds = 0;
    const ttlPiid = findExpirationPiid(spec, plan.siid);
    if (ttlPiid > 0) {
      try {
        const value = await this.getProperty('mijia-cloud', did, plan.siid, ttlPiid);
        ttlSeconds = asNumber(value, 0);
        if (ttlSeconds < 0) ttlSeconds = 0;
      } catch (e) {
        // 读不到不是失败：只是个优化项，别让它把已经拿到的地址丢掉
        await Host.log.info('mijia', '读流有效期失败（按默认 ' + Math.round(STREAM_DEFAULT_TTL_MS / 1000)
          + 's 算）: ' + e).catch(function () {});
      }
    }
    const ttlMs = ttlSeconds > 0
      ? Math.max(ttlSeconds * 1000 - STREAM_EXPIRE_MARGIN_MS, 5000)
      : STREAM_DEFAULT_TTL_MS;
    streamCache[did] = { url: url, kind: plan.kind, expireAt: Date.now() + ttlMs };

    await Host.log.info('mijia', '取流成功 did=' + did + ' kind=' + plan.kind
      + ' 有效期=' + Math.round(ttlMs / 1000) + 's').catch(function () {});
    return { url: url, kind: plan.kind, expiresIn: Math.round(ttlMs / 1000), source: 'cloud' };
  },

  /**
   * ⑫b 保存手动直播地址（局域网 RTSP 等）。
   *
   * 前提是用户在米家 App 里打开了摄像头的「局域网监控」开关，
   * 拿到形如 `rtsp://user:pass@192.168.31.123:554/live/ch00_0` 的地址。
   * 存下来之后 `getStreamUrl` 会优先返回它 —— 这是 spec 里取不到流时的唯一出路。
   */
  async saveStreamUrl(device, url) {
    const did = device && device.did ? String(device.did) : '';
    if (!did) throw new Error('缺少设备 did');
    const normalized = normalizeStreamUrl(url);
    await saveManualStream(did, normalized);
    // 顺手清掉云端缓存：换了地址之后那条短时效地址已经没有意义
    delete streamCache[did];
    return true;
  },

  /** ⑫c 清除手动地址，回到云端自动取流 */
  async clearStreamUrl(device) {
    const did = device && device.did ? String(device.did) : '';
    if (!did) throw new Error('缺少设备 did');
    await clearManualStream(did);
    return true;
  },

  /**
   * ⑫d WebRTC 取流探测（诊断）。
   *
   * 用途只有一个：回答「那 16 个只有 WebRTC 的机型，到底能不能做直播」。
   * 返回 `{ report }` —— 一段**给人看的多行文本**，宿主原样显示，不做解析。
   *
   * 报告分三部分：
   *   ① 设备标识 + spec 服务清单（判定这台属于哪一档）
   *   ② WebRTC 信令的服务/动作/入参出参映射（证实 spec 结构）
   *   ③ 真实发起一次会话，原样回显出参，并给出格式判定
   *
   * ⚠️ 第③步会**真的向米家云端发起一次 WebRTC 会话请求**。
   *    它不改变设备状态、不留下连接，但会消耗一次云端调用 ——
   *    所以只挂在用户主动点「探测」时，不进任何自动流程。
   */
  async probeWebrtc(device) {
    if (!auth) throw new Error('未登录');
    const did = device && device.did ? String(device.did) : '';
    if (!did) throw new Error('probeWebrtc 缺少 did');

    const lines = [];
    const spec = await this.getSpecForDevice(device);
    const support = describeStreamSupport(spec);

    lines.push('设备：' + (device.name || '未命名'));
    lines.push('型号：' + (device.model || '未知'));
    lines.push('urn ：' + String((spec && spec.type) || device.urn || '未知'));
    lines.push('');
    lines.push('取流形态：' + support.mode);
    lines.push('说明：' + describeStreamMode(support.mode));
    lines.push('');
    lines.push('── spec 服务清单 ──');
    const svcLines = describeSpecServices(spec);
    for (let i = 0; i < svcLines.length; i++) lines.push(svcLines[i]);
    lines.push('');

    const plan = findWebrtcPlan(spec);
    if (!plan) {
      lines.push('── WebRTC 信令 ──');
      lines.push('  这台设备的 spec 里没有 initiate-webrtc-session，');
      lines.push('  走 WebRTC 方案的前提不成立，探测到此为止。');
      return { report: plainReport(lines.join('\n')) };
    }

    // ② spec 结构
    const inPiids = iidList(plan.action.in);
    const outPiids = iidList(plan.action.out);
    lines.push('── WebRTC 信令 ──');
    lines.push('  服务: ' + serviceToken(plan.service) + '  siid=' + plan.service.iid);
    lines.push('  动作: initiate-webrtc-session  aiid=' + plan.action.iid);
    const inDesc = [];
    for (let i = 0; i < inPiids.length; i++) {
      const prop = findServiceProperty(plan.service, inPiids[i]);
      inDesc.push(inPiids[i] + '=' + String((prop && prop.description) || '?'));
    }
    lines.push('  入参: ' + inDesc.join(' , '));
    const outDesc = [];
    for (let i = 0; i < outPiids.length; i++) {
      const prop = findServiceProperty(plan.service, outPiids[i]);
      outDesc.push(outPiids[i] + '=' + String((prop && prop.description) || '?'));
    }
    lines.push('  出参: ' + outDesc.join(' , '));
    lines.push('');

    // ③ 真实发起一次：按出参名字逐个填参，不认识的就按 spec 值域挑
    const sessionId = 'probe-' + Date.now() + '-' + probeToken(6);
    const offer = buildProbeOffer();
    const args = [];
    const argDesc = [];
    for (let i = 0; i < inPiids.length; i++) {
      const prop = findServiceProperty(plan.service, inPiids[i]);
      const propType = String((prop && prop.type) || '').toLowerCase();
      if (propType.indexOf('session-id') >= 0) {
        args.push(sessionId);
        argDesc.push('session-id「' + sessionId + '」');
      } else if (propType.indexOf('webrtc-offer') >= 0) {
        args.push(offer);
        argDesc.push('offer（' + offer.length + ' 字符 SDP）');
      } else {
        // 其余入参（video-attribute 这类枚举）按**本服务内**该属性的值域挑一个
        const picked = pickValueFromProperty(prop);
        args.push(picked);
        argDesc.push(String((prop && prop.description) || '?') + '=' + picked);
      }
    }

    lines.push('── 实时探测 ──');
    lines.push('  传参: ' + argDesc.join(' , '));
    lines.push('');
    try {
      /*
       * 与 P2P 探针同一条规矩：**不用 callAction**（它只回 `out.out`，
       * 会把 `Stream URL` 之外的返回字段整片丢掉），改用 actionRaw
       * 把整个返回体交出来 —— WebRTC 的出参槽位语义本来就没定死，
       * 真答可能是 SDP、也可能挂在别的键上，先原文，再解释。
       */
      const result = await actionRaw(did, plan.service.iid, plan.action.iid, args);
      const rawLines = dumpActionResult(result);
      for (let i = 0; i < rawLines.length; i++) lines.push(rawLines[i]);
      // 不再补空行：dumpActionResult 自己末尾已经留了一行（补了就是两个空行）

      const list = asArray(result.out);
      const first = typeof list[0] === 'string' ? list[0] : '';
      const whole = JSON.stringify(result || {});
      if (first.indexOf('v=') === 0 || whole.indexOf('v=0\r') >= 0 || whole.indexOf('a=ice-') >= 0) {
        lines.push('  判定：返回里出现 SDP 应答文本 ✅');
        lines.push('        → 这条路是标准 WebRTC，可做（服务端已认真解析了 offer）。');
        lines.push('        → 下一步要用能跑 RTCPeerConnection 的容器来承载（本机 AVPlayer 不行）。');
      } else if (first.indexOf('://') > 0) {
        lines.push('  判定：返回的是一个播放/信令地址（不是 SDP）。');
        lines.push('        → 需再确认它是 WHEP 风格的信令 URL，还是可直接播的地址。');
      } else if (actionPayloadIsEmpty(result)) {
        lines.push('  判定：云端受理了动作，但返回体里一个载荷都没有。');
        lines.push('        → 地址可能要靠再读 Stream URL / Stream Status 属性去取。');
      } else {
        lines.push('  判定：返回格式非预期 —— 但原文已完整打印（含顶层键与出参），直接交回开发者。');
      }
    } catch (e) {
      lines.push('  ❌ 调用失败：' + String((e && e.message) || e));
      lines.push('');
      lines.push('  失败也是有价值的信息 ——');
      lines.push('    · 报参数校验类错误 → 云端确实在解析 SDP，这条路是标准 WebRTC；');
      lines.push('    · 报权限/不支持 → 该动作可能只对 Alexa 官方客户端开放。');
    }
    return { report: plainReport(lines.join('\n')) };
  },

  /**
   * ⑫d 解密一段抓包里的 `data`（**离线**，不产生任何网络请求）。
   *
   * 为什么非得在插件里做：米家 App 的请求体是 RC4 密文，抓包工具只看得到密文。
   * 要还原明文，唯一的钥匙是**本账号的 ssecurity** —— 推当次 signedNonce 才能解。
   * 而 ssecurity 就躺在插件的 secureStore 里，所以让用户把密文粘进来、
   * 明文拿出去，**凭据一步都不用离开设备**。
   *
   * 入参：整段表单文本（`'data=...&_nonce=...'`），也容忍 `{ blob }` / `{ data, nonce }` 对象。
   * 宿主走的是**字符串**形态 —— ArkTS 不允许即席对象字面量，为一个字段建 class 不划算。
   *
   * 🔑 **钥匙优先取自抓包自带的 `ssecurity`**（抓包表单里就有），取不到才退回
   * 本机登录会话的那一份。这条很要紧：米家 App 的会话与本 App 的会话
   * 是两套钥匙，用本机的 ssecurity 解米家 App 的密文必然解出乱码。
   * 也因此**不要求先登录** —— 带着 ssecurity 的抓包随时随地能解。
   *
   * 返回 `{ report }`（给人看的多行文本，与两个探针同形状）。
   */
  async decryptCapture(payload) {
    let blob = '';
    let dataOverride = '';
    let nonceOverride = '';
    let ssecurityOverride = '';
    if (typeof payload === 'string') {
      blob = payload;
    } else if (payload) {
      blob = String(payload.blob || '');
      dataOverride = String(payload.data || '');
      nonceOverride = String(payload.nonce || '');
      ssecurityOverride = String(payload.ssecurity || '');
    }

    const fields = parseCaptureBlob(blob);
    const data = (dataOverride || fields.data || '').trim();
    const nonce = (nonceOverride || fields.nonce || '').trim();

    if (!data) throw new Error('没找到 data 字段：把抓包里 data=... 那一段整段粘进来');
    if (!nonce) throw new Error('没找到 _nonce 字段：解密必须带上同一次请求的 _nonce=...');

    /*
     * 钥匙优先级：抓包自带 > 调用方显式传入 > 本机登录会话。
     *
     * 🔴 这条优先级是整段逻辑的关键。米家的 ssecurity 与登录会话**成对签发**
     *    （插件续期时就必须连着换，见 refreshServiceToken），所以米家 App 的
     *    会话和本 App 的会话是两套钥匙 —— 拿本机的 ssecurity 去解米家 App 抓的
     *    密文，必然解出乱码，而 RC4 不会报错。
     *    好在米家把 ssecurity **明文放在请求体里**（插件自己发请求也这么带），
     *    所以抓包里通常就有一份：用它就能解，**与当前登录会话无关**。
     *    于是这里也不再强制要求先登录。
     */
    const carried = (ssecurityOverride || fields.ssecurity || '').trim();
    const keyFromCapture = carried.length > 0;
    const ssecurity = carried || String((auth && auth.ssecurity) || '');
    if (!ssecurity) {
      throw new Error('没有可用的 ssecurity：本 App 当前未登录，'
        + '而这段抓包里也没带 ssecurity=... 字段。把它一起粘进来即可，不必先登录。');
    }

    const signedNonce = await getSignedNonce(ssecurity, nonce);

    // 先拿到字节：解码那一步失败的原因和 RC4 本身失败完全不同，要分开说
    let bytes = null;
    try {
      bytes = await decryptRc4Bytes(signedNonce, data);
    } catch (e) {
      throw new Error('RC4 解密失败：' + String((e && e.message) || e)
        + '（data 不是合法 base64？）');
    }
    if (!bytes || bytes.length === 0) {
      throw new Error('解密结果为空。这段密文可能不是 RC4 —— 看抓包里有没 miot-encrypt-algorithm: ENCRYPT-RC4');
    }

    let plain = '';
    try {
      plain = bytesToUtf8(bytes);
    } catch (e) {
      /*
       * 字节不是合法 UTF-8。这里**不抛**：退回逐字节映射，把原始字节
       * 交给下面的判定与定位段去说 —— 报告里既给出结论、也留着乱码本身，
       * 比一句「失败」有用得多。
       */
      for (let i = 0; i < bytes.length; i++) plain += String.fromCharCode(bytes[i]);
    }

    /*
     * U+FFFD 是 TextDecoder 碰到非法字节时的**替换字符** —— 它本身「可打印」，
     * 含义却恰恰是「这里解码失败了」。数它的个数，比看可打印占比准得多：
     * 每一个替换字符都是一处确定的「这不是合法文本」的证据。
     */
    let replacement = 0;
    for (let i = 0; i < plain.length; i++) {
      if (plain.charCodeAt(i) === 0xfffd) replacement += 1;
    }

    const sample = Math.min(plain.length, 200);
    let printable = 0;
    for (let i = 0; i < sample; i++) {
      const c = plain.charCodeAt(i);
      if (c === 0xfffd) continue;
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c > 0x2e80) printable++;
    }
    const ratio = sample > 0 ? printable / sample : 0;

    /*
     * 最强的判据是**能不能当 JSON 解析** —— 明文本来就是 JSON
     * （米家的请求体是 `data=<加密后的 JSON>`），所以解得对就一定 parse 得过。
     * 之前只看「可打印占比」，那是个很弱的信号：46% 这个数字读者根本无从判断
     * 意味着什么，也说不出下一步该干嘛。
     */
    let jsonOk = false;
    try {
      const parsed = JSON.parse(plain);
      jsonOk = parsed !== null && typeof parsed === 'object';
    } catch (e) {
      jsonOk = false;
    }

    // 返回给宿主的一律是「给人看的报告」—— 与两个探针同形状，宿主只认一种
    const out = [];
    out.push('解密完成 —— 长度对照');
    out.push('  密文（base64）  ' + data.length + ' 字符');
    out.push('  密文字节 / 解密后字节  ' + bytes.length + ' / ' + bytes.length
      + ' 字节');
    out.push('    （RC4 是流密码，这两者**必然相等** —— 相等不代表解对了）');
    out.push('  按 UTF-8 解码  ' + plain.length + ' 字符'
      + (replacement > 0 ? '，其中替换字符 U+FFFD ' + replacement + ' 处' : ''));
    out.push('  可打印占比      ' + Math.round(ratio * 100) + '%（抽样 ' + sample + ' 字符）');
    out.push('  钥匙来源        ' + (keyFromCapture
      ? '抓包自带的 ssecurity ✅（与当前登录会话无关）'
      : '本机登录会话的 ssecurity'));
    out.push('');

    if (jsonOk) {
      out.push('判定：✅ 明文是合法 JSON —— 钥匙正确，下面的明文就是原文。');
    } else if (replacement === 0 && ratio > 0.95 && plain.length > 0) {
      out.push('判定：⚠️ 明文是合法文本，但不是 JSON（可能是表单或其它格式）。');
      out.push('      → 如果这段本来就不该是 JSON，那这次解密是成功的。');
    } else {
      out.push('判定：❌ 解出来不是合法文本 —— 钥匙对不上。');
      out.push('      （RC4 解错钥匙既不报错、也不吐异常，只给你一串乱码，');
      out.push('        所以只能靠「明文是不是合法文本 / JSON」来判。）');
    }

    /*
     * 解错时给出「乱在哪」：用户拿着一串乱码去求助时，
     * 前几十个字节的十六进制往往比多问三句话更有用 —— 规律肉眼可见。
     */
    if (!jsonOk) {
      out.push('');
      out.push('── 定位 ──');
      const head = bytes.slice(0, 48);
      out.push('  密文前 48 字节（十六进制）：');
      out.push('    ' + toHex(head));
      out.push('  同样的字节当作 ASCII 读：');
      out.push('    ' + toAsciiPreview(head));
      const first = bytes.length > 0 ? Number(bytes[0]) : -1;
      out.push('  首字节 ' + (first >= 0 ? '0x' + toHex(bytes.slice(0, 1)) : '?')
        + ' —— 明文若是 JSON，这里本该是 0x7b（{）'
        + (first === 0x7b ? ' ✅' : ' ❌'));
      out.push('');
      out.push('── 可能的原因（按概率）──');
      out.push('  1. ★ 这段密文不是本会话加密的');
      out.push('     米家的 ssecurity 与登录会话**成对签发**：米家 App 的会话和本 App');
      out.push('     的会话是两套钥匙。拿本机的 ssecurity 解米家 App 的密文，必然解不开。');
      out.push('     ✔ 解决：抓包表单里一般**自带 ssecurity=…**，把它连着一起粘进来');
      out.push('       （本功能优先用它，且不需要先登录）。若抓包里确实没有这个字段，');
      out.push('       这段密文在本机解不开 —— 只有本 App 自己那一会话的抓包才解得了。');
      out.push('  2. data 与 _nonce 取自两次不同的请求 —— 两者必须同批，缺一不可。');
      out.push('  3. 密文被截断：base64 长度须为 4 的倍数。本段 ' + data.length + ' 字符，'
        + (data.length % 4 === 0 ? '✅ 符合' : '❌ 不符合') + '。');
      out.push('  4. 这段本身不是 RC4 密文 —— 核对抓包里的 miot-encrypt-algorithm 头。');
    }

    out.push('');
    out.push('── 明文（原样）──');
    out.push(prettyPlain(plain));
    return { report: plainReport(out.join('\n')) };
  },

  /**
   * ⑫f 统一取流诊断入口：按设备的**取流形态**自动挑探针。
   *
   * 宿主只调这一个 —— 它不该关心这台设备是 WebRTC 型还是纯 P2P 型，
   * 那是 spec 层的事。判断放这里，宿主侧的代码就只剩「显示报告」。
   */
  async probeStream(device) {
    if (!auth) throw new Error('未登录');
    const spec = await this.getSpecForDevice(device);
    const support = describeStreamSupport(spec);
    if (support.mode === 'p2p') {
      return await this.probeP2p(device);
    }
    /*
     * 其余形态（webrtc / hls / rtsp / none）都走 WebRTC 那支：
     * 它在最前面就打印「取流形态 + 说明 + spec 服务清单」，对任何机型都有信息量 ——
     * 而能走到诊断这一步的设备，看这份清单本来就正是用户需要的东西。
     */
    return await this.probeWebrtc(device);
  },

  /**
   * ⑫e P2P 取流链路探测 —— 专门回答「只有私有 P2P 的机型到底有没有出路」。
   *
   * 全量扫描（`scripts/scan_camera_stream.js`）显示 66% 的摄像头型号属于这一类：
   * `p2p-stream` 服务的 `start-p2p-stream` 在 spec 里 **in/out 全空**。
   * 但米家对 P2P 从不在 spec 里描述参数，**空不等于没有** ——
   * 真调一次才知道云端到底给不给东西。这个探针就是那一枪。
   *
   * ⚠️ 会真的向云端发起一次 P2P 会话，因此探测完**立刻调 stop-stream 收尾**，
   *    不留推流态。只挂在用户主动点「探测」时，不进任何自动流程。
   */
  async probeP2p(device) {
    if (!auth) throw new Error('未登录');
    const did = device && device.did ? String(device.did) : '';
    if (!did) throw new Error('probeP2p 缺少 did');

    const lines = [];
    const spec = await this.getSpecForDevice(device);
    const support = describeStreamSupport(spec);

    lines.push('设备：' + (device.name || '未命名'));
    lines.push('型号：' + (device.model || '未知'));
    lines.push('urn ：' + String((spec && spec.type) || device.urn || '未知'));
    lines.push('');
    lines.push('取流形态：' + support.mode);
    lines.push('说明：' + describeStreamMode(support.mode));
    lines.push('');
    lines.push('── spec 服务清单 ──');
    const svcLines = describeSpecServices(spec);
    for (let i = 0; i < svcLines.length; i++) lines.push(svcLines[i]);
    lines.push('');

    const services = asArray(spec && spec.services);
    let svc = null;
    for (let i = 0; i < services.length; i++) {
      if (serviceToken(services[i]).indexOf('p2p-stream') >= 0) { svc = services[i]; break; }
    }
    if (!svc) {
      lines.push('── P2P 服务 ──');
      lines.push('  这台设备的 spec 里没有 p2p-stream 服务，探测到此为止。');
      return { report: plainReport(lines.join('\n')) };
    }

    lines.push('── P2P 服务 ──');
    lines.push('  服务: ' + serviceToken(svc) + '  siid=' + svc.iid);
    const props = asArray(svc.properties);
    for (let i = 0; i < props.length; i++) {
      lines.push('    属性 [' + props[i].iid + '] ' + String(props[i].description || '?')
        + '  format=' + String(props[i].format || '?'));
    }
    if (props.length > 0) {
      lines.push('    ↑ 这些属性全是**编解码协商参数**（编码 / 采样率 / 分辨率 / 对讲模式），');
      lines.push('      描述的是「怎么编」，没有一个回答「连哪里」——');
      lines.push('      地址、密钥这一类的字段，spec 里压根不存在。');
    }
    const acts = asArray(svc.actions);
    let startAct = null;
    let stopAct = null;
    for (let i = 0; i < acts.length; i++) {
      const t = actionToken(acts[i]);
      lines.push('    动作 [' + acts[i].iid + '] ' + t
        + '  in=' + JSON.stringify(acts[i].in || []) + ' out=' + JSON.stringify(acts[i].out || []));
      if (t === 'start-p2p-stream') startAct = acts[i];
      if (t === 'stop-stream') stopAct = acts[i];
    }
    lines.push('');
    if (!startAct) {
      lines.push('  没有 start-p2p-stream 动作，探测到此为止。');
      return { report: plainReport(lines.join('\n')) };
    }

    lines.push('── 实时探测 ──');
    lines.push('  调用 start-p2p-stream  siid=' + svc.iid + '  aiid=' + startAct.iid + '  in=[]');
    lines.push('');
    // 供报告末尾的「下一步」判断用：探测失败时保持 false，不装作拿到了东西
    let payloadEmpty = false;
    let actionFailed = false;
    try {
      /*
       * 🔴 这里**故意不用 callAction**：它只回传 `result.out`，
       *    result 里其它键会被整个丢掉（`return out.out !== undefined ? out.out : {}`）。
       *    P2P 的连接参数若挂在别的键上（p2p_info / server / key…），
       *    用 callAction 永远看不见 —— 那正是本次探测最想拿到的东西。
       *    所以改用 actionRaw：一样校验 code，但把整个 result 原样交出来。
       */
      const result = await actionRaw(did, svc.iid, startAct.iid, []);
      const rawLines = dumpActionResult(result);
      for (let i = 0; i < rawLines.length; i++) lines.push(rawLines[i]);
      // 不再补空行：dumpActionResult 自己末尾已经留了一行（补了就是两个空行）

      /*
       * 判定分三档，别让元数据键（code/message）冒充载荷：
       *   有载荷 + 含 p2p 字样 → 值钱，让人去细读原文；
       *   压根没载荷          → 这就是结论：动作接口不下发连接参数；
       *   有载荷但看不懂      → 才轮到「交回开发者」，而且原文已经在上面了。
       */
      const json = JSON.stringify(result || {});
      payloadEmpty = actionPayloadIsEmpty(result);

      if (!payloadEmpty && (json.indexOf('p2p') >= 0 || json.indexOf('P2P') >= 0)) {
        lines.push('  判定：返回体里有载荷、且出现 p2p 字样 —— 值钱的东西就在上面，逐字读。');
      } else if (payloadEmpty) {
        lines.push('  判定：云端受理了动作，但返回体里**一个载荷都没有**'
          + (result && result.out === undefined ? ' —— 连 `out` 键都不存在' : '')
          + '（只有回显 / 遥测 / 状态这类信封字段）。');
        /*
         * exe_time 是「设备真的动过」的硬证据：它来自设备本地的执行计时，
         * 只有动作真正跑完才会有值。有了它就能把结论从
         * 「可能没被受理」抬到「确实执行了，但返回结构里就没有出参位」。
         */
        const exeTime = Number(result && result.exe_time);
        if (!isNaN(exeTime) && exeTime > 0) {
          lines.push('        · 旁证：exe_time=' + exeTime + 'ms —— 设备**确实执行了**这个动作，');
          lines.push('          不是被拒绝、也不是超时。所以「拿不到参数」是设计如此。');
        }
        lines.push('        → 这就是本次探测的结论：`start-p2p-stream` 不下发连接参数。');
        lines.push('          米家从不把 P2P 参数放进开放的动作接口，它只对自家客户端');
        lines.push('          通过私有通道下发（长连接/推送，或 camera 业务网关）。');
        lines.push('          **开放接口这一层到此为止 —— 但这不等于是死路**：');
        lines.push('          小米官方的 Miloco 自带 PPCS 客户端，能把画面转成网页可播的流。');
        lines.push('          本 App 已接入它 —— 见下面的「下一步 · 路线 A」。');
      } else {
        lines.push('  判定：返回体里有载荷、但没看到 p2p 关键字 —— 上面原文已完整打印，直接交回开发者。');
      }
    } catch (e) {
      actionFailed = true;
      lines.push('  ❌ 调用失败：' + String((e && e.message) || e));
      lines.push('');
      lines.push('  失败同样是结论 —— 报「不支持 / 无权限」即说明该动作');
      lines.push('  只对米家自家客户端开放，第三方无法发起。');
    }

    /*
     * 无论成败都给下一步 —— 用户在诊断页停下来时，
     * 最需要的不是「这条路不行」，而是「那下一条路是哪个」。
     */
    // 收尾：探测完立刻 stop，别把摄像头晾在推流态
    if (stopAct) {
      lines.push('');
      lines.push('（收尾：已调用 stop-stream 结束本次探测会话）');
      try {
        await actionRaw(did, svc.iid, stopAct.iid, []);
      } catch (e) {
        lines.push('  stop-stream 失败（无害）：' + String((e && e.message) || e));
      }
    }

    /*
     * 再往前探一层：问米家云这台设备走哪家 P2P。
     *
     * 上面已经证明 spec 层和开放动作接口都拿不到连接参数 —— 但米家 App 自己能拿到，
     * 说明参数存在于**另一条通道**（米家 App 专用的云接口）里。
     * 这一步就去问那条通道：先不问参数，先问「走哪家 P2P」，
     * 因为答案直接决定还有没有路（cs2 能做 / tutk 很难 / agora 没戏）。
     */
    lines.push('');
    let vendorProbe = null;
    try {
      vendorProbe = await queryP2pVendor(did, device && device.model);
    } catch (e) {
      vendorProbe = { ok: false, error: String((e && e.message) || e) };
    }
    const vLines = vendorProbeLines(vendorProbe);
    for (let i = 0; i < vLines.length; i++) lines.push(vLines[i]);

    /*
     * 无论成败都给下一步，而且**按可行性排**。
     *
     * 顺序是会变的 —— Miloco（小米官方）出来之后，路线 A 从
     * 「局域网中继」换成了「用官方通道」，原来的中继降为 B、复刻协议降为 C。
     * 报告若还停在旧顺序上，用户就会先去试最难的那条。
     */
    lines.push('');
    lines.push('── 下一步（三条路，按可行性排）──');
    if (actionFailed || payloadEmpty) {
      lines.push('  ★ 路线 A（推荐）：用 Miloco —— 小米官方的取流服务');
      lines.push('     它自己实现了米家私有 PPCS，连纯 P2P 机型都能出画面，');
      lines.push('     并把画面重编成网页可播的流。在局域网里装好 Miloco 后，');
      lines.push('     回到本页点「用 Miloco 观看」并填它的地址即可 ——');
      lines.push('     本机不需要支持任何米家私有协议。');
      lines.push('     前提：Miloco 与摄像头在同一局域网，且它已开放局域网访问。');
      lines.push('');
      lines.push('  路线 B（可行，但要一台额外的中继设备）：局域网 RTSP + 中继');
      lines.push('     ① 米家 App 打开这台摄像头的「局域网监控」，记下它给的地址；');
      lines.push('     ② 局域网里随便一台常开的机器跑个中继把它转成 HLS');
      lines.push('        （go2rtc 一条命令即可，配置里写 streams: cam: rtsp://…）；');
      lines.push('     ③ 回到本页「填写手动地址」，填中继给出的 .m3u8 地址。');
      lines.push('     注意：本机播放器吃 HLS、不吃 RTSP —— 中继这一步不能省。');
      lines.push('');
      lines.push('  路线 C（很难，等于复刻私有协议）');
      lines.push('     抓米家 App 点开这台摄像头直播那一刻的请求，看 camera 业务网关');
      lines.push('     （app.business.smartcamera.api.mijia.tech）下哪条返回连接信息。');
    } else {
      lines.push('  先把上面的原文逐字读完，再决定是否要抓米家 App 的请求对照。');
    }
    lines.push('');
    /*
     * 如果厂商探测认出 cs2，那还剩一条**开发向**的路。
     *
     * 它不在上面三条「今天就能用」的路线里（那三条是给用户当下操作用的），
     * 但它是唯一能让本 App 彻底不依赖任何外部服务的做法 ——
     * 值不值得投入，取决于有没有人写。所以要说清楚它存在、以及代价。
     */
    if (vendorProbe && vendorProbe.ok && p2pVendorName(vendorProbe.vendorId) === 'cs2') {
      lines.push('');
      lines.push('  〔开发向〕路线 0：让本 App 自己取 P2P（最彻底，但要写代码）');
      lines.push('    上面探测出这台设备走 cs2 —— 四家厂商里唯一被第三方完整');
      lines.push('    实现过的一支，而且协议只有四步。真做起来需要在宿主侧新增');
      lines.push('    约千行网络与协议代码（UDP 握手 / 认证 / 开流 / ChaCha20 解密），');
      lines.push('    再接给播放器。好处是不用 Miloco、不用中继、不用抓包，');
      lines.push('    在同一局域网内直接出画面；代价是开发和真机调试的工作量。');
    }

    lines.push('  提示：抓包的 data=…&_nonce=… 可直接粘到「解析一段抓包」入口就地解出明文，');
    lines.push('  解密用的 ssecurity 只在本机（不会离开设备）。');

    return { report: plainReport(lines.join('\n')) };
  },

  /**
   * ⑫b CS2 P2P 配对：宿主出公钥，这里只跑 miss_get_vendor 换设备公钥与签名。
   *
   * 与 probeStream 里的厂商探测同源（queryP2pVendor），差别只有两点：
   * 公钥由宿主传入（私钥不出宿主，见函数内注释）、返回的是**给机器读的
   * 结构**而不是给人看的报告 —— 宿主拿到 devicePublic/sign 就能自己
   * 起 UDP 会话。vendor=4（cs2）之外的结果原样返回，由宿主分档解释。
   *
   * 带重试：云端偶发 code:-8（同 did / 同 cookie 随机出现，单次失败不算
   * 失败），脚本实测连发 5 次成功率 ≥9/10。插件运行环境没有定时器，
   * 好在这条链路每发一趟请求本身就是一秒上下，连续重试天然带间隔。
   * vendorId 非 4 是**确定性的答案**（云端明确回答了设备走别家），
   * 重发多少次都一样 —— 不重试，直接返回。
   */
  async missPair(device, clientPublicHex) {
    const did = String(device && device.did ? device.did : '');
    if (!did) throw new Error('缺少设备 did');
    const TRIES = 5;
    let last = null;
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      const result = await missPairOnce(device, did, clientPublicHex);
      last = result;
      if (!result.ok) {
        await Host.log.info('mijia', 'missPair 第 ' + attempt + '/' + TRIES
          + ' 次未成功（' + result.error + '），重试').catch(function () {});
        continue;
      }
      if (result.vendorId >= 1 && result.vendorId !== 4) {
        return result; // 云端明确回答了"设备走别家"——确定性答案，不重试
      }
      // cs2 或 vendor 未知：公钥/签名缺一项都算这次没拿到，重试
      if (result.devicePublic.length === 0 || result.sign.length === 0) {
        await Host.log.info('mijia', 'missPair 第 ' + attempt + '/' + TRIES
          + ' 次: 响应缺公钥或签名，重试').catch(function () {});
        continue;
      }
      return result;
    }
    return last;
  },

  /** ⑬ 网关状态。未登录也能给出型号/固件（`init_info` 免登录）；有保存的密码时会自动登录 */
  async gatewayInfo(device) {
    const did = String(device && device.did ? device.did : '');
    if (!did) throw new Error('缺少设备 did');
    // 先解析地址并拿 init_info：这样即便还没登录，页面也能显示「这是哪台路由器」
    const ip = await resolveGatewayIp(device, false);
    const initInfo = await luciGet(ip, '/api/xqsystem/init_info');
    let status = {};
    let loggedIn = gwSession.stok.length > 0;
    if (!loggedIn) {
      const credential = await loadGatewayCredential(did);
      if (credential) {
        // 有密码就自动登录：用户不该每进一次页面都手输一次
        try {
          await ensureGatewaySession(device, '');
          loggedIn = true;
        } catch (e) {
          await Host.log.info('mijia', '网关自动登录失败（等待用户手输）: ' + e).catch(function () {});
        }
      }
    }
    if (loggedIn) {
      status = await luciGet(ip, '/api/misystem/status');
    }
    const result = normalizeGatewayStatus(initInfo, status);
    result.loggedIn = loggedIn;
    result.gatewayIp = ip;
    return result;
  },

  /** ⑭ 网关登录：验证并保存管理密码（独立存储键，见模块头说明） */
  async gatewayLogin(device, password) {
    const plain = String(password || '');
    if (plain.length === 0) throw new Error('密码不能为空');
    // 换密码登录时先丢掉旧会话，避免拿旧 stok 去发请求
    gwSession.stok = '';
    await ensureGatewaySession(device, plain);
    return true;
  },

  /** ⑮ 忘掉网关密码与会话 */
  async gatewayForget(device) {
    const did = String(device && device.did ? device.did : '');
    gwSession.stok = '';
    gwSession.variant = '';
    if (did) {
      try {
        await Host.secureStore.delete('miwifi_' + did);
      } catch (e) {
        // 删不掉不阻塞：内存态已清，本次会话不会再发请求
      }
    }
    return true;
  },

  /** ⑯ 网关下的终端列表 */
  async gatewayClients(device) {
    await ensureGatewaySession(device, '');
    const body = await luciGet(gwSession.ip, '/api/misystem/devicelist');
    const code = Number(body && body.code !== undefined ? body.code : 0);
    if (code !== 0) {
      throw new Error('取终端列表失败 code=' + code + '（会话可能已过期，请重进页面）');
    }
    const list = asArray(body.list);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const client = normalizeClient(list[i]);
      if (client.mac) out.push(client);
    }
    return out;
  },

  /** ⑰ 拉黑 / 放行一台终端（禁外网） */
  async gatewaySetBlocked(device, mac, blocked) {
    const target = String(mac || '').toLowerCase();
    if (!target) throw new Error('缺少 MAC 地址');
    await ensureGatewaySession(device, '');
    const wan = blocked ? '0' : '1';
    const body = await luciGet(gwSession.ip,
      '/api/xqsystem/set_mac_filter?mac=' + encodeURIComponent(target) + '&wan=' + wan);
    const code = Number(body && body.code !== undefined ? body.code : 0);
    if (code !== 0) {
      throw new Error('设置失败 code=' + code + (body && body.msg ? '：' + body.msg : ''));
    }
    return true;
  },

  /** ⑱ 重启网关。返回即代表指令已下发（设备随后会断线，属正常） */
  async gatewayReboot(device) {
    await ensureGatewaySession(device, '');
    const body = await luciGet(gwSession.ip, '/api/xqsystem/reboot');
    const code = Number(body && body.code !== undefined ? body.code : 0);
    if (code !== 0) {
      throw new Error('重启指令被拒绝 code=' + code + (body && body.msg ? '：' + body.msg : ''));
    }
    return true;
  },

  /** ⑬ 退出登录：清掉凭据与运行态。宿主退出登录时会调 */
  async logout() {
    auth = null;
    cookieJar = '';
    try {
      await Host.secureStore.delete('auth');
    } catch (e) {
      // 删不掉也无所谓 —— 内存里的 auth 已经清了，本次会话不会再发请求
    }
    return true;
  },

  async dispose() {
    auth = null;
    cookieJar = '';
  }
});
