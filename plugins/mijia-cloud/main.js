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
/** 发一次签名请求，返回 { res, nonce, signedNonce }（解密响应要用当次的 signedNonce） */
async function requestOnce(uri, data) {
  const nonce = await genNonce();
  const signedNonce = await getSignedNonce(auth.ssecurity, nonce);
  const params = await buildEncParams(
    uri, 'POST', signedNonce, nonce,
    [{ key: 'data', value: JSON.stringify(data) }],
    auth.ssecurity
  );
  const res = await Host.httpForm(API_HOST + uri, apiHeaders(), paramsToObj(params));
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

async function request(uri, data) {
  if (!auth) throw new Error('未登录');

  let out = await requestOnce(uri, data);

  /*
   * 401 不再直接判「登录失效」。serviceToken 是会过期的（passToken 通常活得更久），
   * 真机 App 的做法是拿 passToken 静默换一个新的 serviceToken，全程不用扫码。
   * 这里对齐它：续期成功就重发本次请求；续期失败才真正报「请重新登录」。
   */
  if (out.res.status === 401) {
    const preview = String(out.res.body || '').trim().slice(0, 150);
    await Host.log.error('mijia', '接口 401（' + uri + '）: ' + preview).catch(function () {});
    if (await refreshServiceToken()) {
      out = await requestOnce(uri, data);
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
    const result = await request('/miotspec/prop/set', {
      did: did,
      params: [{ did: did, siid: siid, piid: piid, value: value }]
    });
    const list = asArray(result);
    const first = list[0];
    if (first && Number(first.code) !== 0) {
      throw new Error('设备拒绝写入 code=' + first.code);
    }
    // 契约是「返回属性值」，回显请求值
    return value;
  },

  /** ⑩ 执行动作。`params` 是**单个对象**，不是数组（与 set_properties 不同） */
  async callAction(transportId, did, siid, aiid, inList) {
    if (!auth) throw new Error('未登录');
    const result = await request('/miotspec/action', {
      did: did,
      params: {
        did: did,
        siid: siid,
        aiid: aiid,
        in: asArray(inList)
      }
    });
    const out = result || {};
    if (Number(out.code) !== 0) throw new Error('动作执行失败 code=' + out.code);
    return out.out !== undefined ? out.out : {};
  },

  /** ⑪ 退出登录：清掉凭据与运行态。宿主退出登录时会调 */
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
