/*
 * 示例插件：局域网探测（原始 socket 桥的用法演示）
 *
 * 这个样例和 `sample-plugin` 是一对：
 *   - `sample-plugin`   演示 **Host 无状态出口**（http / secureStore / log）+ form 登录
 *   - 本插件            演示 **Host 原始 socket**（udp / tcp / tls）+ 回调注册
 *
 * ## 它做什么
 *
 * 往用户填的地址发一个 UDP 探测包，把**有应答的**主机当作设备列出来。
 * 它**不实现任何厂商协议** —— 探测包里就是一段固定文本，能应答的都对。
 * 目的是让「打开 UDP → 注册回调 → 发包 → 收包 → 转换数据」这条链路能被肉眼验证。
 *
 * ## 插件作者从这个文件能学到什么
 *
 * 1. 沙箱里**没有 socket API**，`Host.udp` / `Host.tcp` / `Host.tls` 是唯一的原始通道；
 * 2. 载荷一律 **Base64**（跨 JS 边界只能传字符串，而报文是任意二进制）；
 * 3. 回调是宿主往沙箱里推的，**注册必须在发包之前**，否则回得快的第一包会丢；
 * 4. TCP 是**流**不是消息：一次回调不代表一个完整报文，协议解析要自己攒缓冲。
 *    UDP 相反，一次回调就是完整一包（本插件用的是 UDP，所以不用管这个）。
 */

/** 探测包内容：纯文本，方便用 nc / tcpdump 对照 */
const PROBE = 'miha-lan-probe/1';

/** 一次探测的等待时间。局域网内常见值在 100ms 以内，留足余量 */
const PROBE_TIMEOUT_MS = 800;

let config = null;

// ---------------------------------------------------------------- base64 工具
//
// 桥收发都用 Base64。沙箱里有 atob / btoa（是 Web 环境），所以这两行就够。
// ⚠️ 别用 TextEncoder 绕：UDP 报文是**任意字节**，不是文本，
// 走 UTF-8 编码会在非 ASCII 字节上直接损坏数据。

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i);
  }
  return out;
}

function utf8ToB64(text) {
  // 探测包是纯 ASCII，逐字符取码即可
  return btoa(text);
}

// ---------------------------------------------------------------- 探测

/**
 * 对若干主机发 UDP 探测，返回有应答的那些。
 *
 * ⚠️ 这里刻意**串行**而不是并发：同一个 socket 上并发发多个请求时，
 * 回调是按主机分发的，需要自己维护 pending 表。串行写法让样例保持
 * 「一眼能看懂」，真实插件里该并发的地方再并发。
 */
async function probeHosts(hosts, port) {
  const found = [];
  if (hosts.length === 0) {
    return found;
  }

  const handle = await Host.udp.open({ localAddress: '0.0.0.0', localPort: 0 });

  /**
   * 用一个可变对象收集应答。
   *
   * 为什么不用 Promise 包一层再 await：宿主推回调是**单方向**的，
   * 没有「回调返回给谁」的概念。用「发完之后等一小会儿再收成结果」的
   * 写法更贴近它的真实语义，也避免了为每个包各建一个 Promise。
   */
  const replies = [];
  await Host.udp.onMessage(handle, function (dataB64, host, fromPort) {
    replies.push({ host: host, port: fromPort, data: b64ToBytes(dataB64) });
  });

  try {
    for (let i = 0; i < hosts.length; i++) {
      const h = hosts[i];
      if (!h) continue;
      try {
        await Host.udp.send(handle, h, port, utf8ToB64(PROBE));
      } catch (e) {
        // 单台发不出去（地址非法等）不该让整轮探测失败
        await Host.log.error('lan-sample', '发送到 ' + h + ' 失败: ' + e);
      }
      // 每台之间稍等，给应答留出往返时间
      await new Promise(function (r) { setTimeout(r, PROBE_TIMEOUT_MS); });
    }
  } finally {
    // ⚠️ 一定要关。socket 是稀缺资源，开着不放会一直占着本地端口
    await Host.udp.close(handle);
  }

  for (let i = 0; i < replies.length; i++) {
    const r = replies[i];
    if (r.data.length === 0) continue;
    found.push(r);
  }
  await Host.log.info('lan-sample', '探测完成，' + found.length + ' 台有应答');
  return found;
}

// ---------------------------------------------------------------- 注册

Plugin.register({
  /**
   * ① 初始化。
   *
   * 探测是「用户主动触发」的动作，不该在启动时就跑一轮（那会在冷启动
   * 拖慢界面，而且用户可能还没连上 Wi-Fi）。所以这里只读配置，
   * 真正的探测放在 getDevices 里。
   */
  async init() {
    try {
      const raw = await Host.secureStore.get('config');
      config = raw ? JSON.parse(raw) : null;
    } catch (e) {
      config = null;
    }
    if (!config) return false;
    await Host.log.info('lan-sample', '目标 ' + config.subnet + ':' + config.port);
    return true;
  },

  /**
   * ② 登录视图：地址段 + 端口。
   *
   * 不弹二维码是因为这类局域网插件没有云端账号，只需要知道往哪儿发。
   */
  async loginBegin() {
    return {
      sessionId: 'lan' + Date.now(),
      view: {
        type: 'form',
        fields: [
          {
            key: 'subnet',
            label: '网段前缀',
            type: 'text',
            placeholder: '192.168.1.',
            default: '192.168.1.'
          },
          {
            key: 'range',
            label: '探测范围',
            type: 'text',
            placeholder: '1-32（最后一段的起止）',
            default: '1-32'
          },
          {
            key: 'port',
            label: 'UDP 端口',
            type: 'text',
            placeholder: '54321',
            default: '54321'
          }
        ],
        submitLabel: '保存并探测'
      }
    };
  },

  async loginSubmit(_sessionId, fields) {
    let subnet = (fields.subnet || '').trim();
    const range = (fields.range || '1-32').trim();
    const port = parseInt((fields.port || '54321').trim(), 10);

    if (!subnet) {
      return { state: 'error', message: '请填写网段前缀' };
    }
    // 用户很可能把最后一段也带上，或者不写点号，都顺手归一化
    while (subnet.length > 0 && subnet.charAt(subnet.length - 1) === '.') {
      subnet = subnet.substring(0, subnet.length - 1);
    }
    if (isNaN(port) || port <= 0 || port > 65535) {
      return { state: 'error', message: '端口要在 1-65535 之间' };
    }

    config = { subnet: subnet, range: range, port: port };
    await Host.secureStore.set('config', JSON.stringify(config));
    await Host.log.info('lan-sample', '已保存配置');
    return { state: 'success' };
  },

  async loginPoll() {
    // form 视图没有轮询
    return { state: 'pending' };
  },

  async loginCancel() {
    return { state: 'cancelled' };
  },

  /**
   * 家庭容器。
   *
   * ⚠️ 字段名要按宿主 `Home` 的形状给：`id` / `name` / `dids` / `roomlist`。
   * 写 `roomIds` / `deviceIds` 的话宿主解析出来是个空家庭（它不会猜字段名）。
   */
  async getHomes() {
    return [{ id: 'lan', name: '局域网', uid: 'lan', dids: [], roomlist: [] }];
  },

  /**
   * ③ 数据面：把有应答的主机当作设备。
   *
   * 返回的 key **必须是 did**，且值是可 JSON 序列化的普通对象。
   */
  async getDevices() {
    if (!config) {
      await Host.log.error('lan-sample', '未配置，返回空列表');
      return {};
    }

    // 把 "1-32" 展开成主机地址列表
    const hosts = [];
    const parts = config.range.split('-');
    const from = parseInt(parts[0], 10);
    const to = parts.length > 1 ? parseInt(parts[1], 10) : from;
    if (isNaN(from) || isNaN(to) || from > to) {
      await Host.log.error('lan-sample', '探测范围格式不对: ' + config.range);
      return {};
    }
    // 上限 254：一个 /24 网段的全部主机。再多也不该用 UDP 串行扫了
    const upper = Math.min(to, from + 253);
    for (let i = from; i <= upper; i++) {
      hosts.push(config.subnet + '.' + i);
    }

    const replies = await probeHosts(hosts, config.port);

    const out = {};
    for (let i = 0; i < replies.length; i++) {
      const r = replies[i];
      const did = 'lan.' + r.host + '.' + r.port;
      out[did] = {
        did: did,
        name: r.host + ':' + r.port,
        model: 'lan-probe',
        urn: '',
        roomId: '',
        homeId: 'lan',
        online: true,
        token: '',
        // localIp 填上，宿主的部分界面会拿它做「局域网直连」的提示
        localIp: r.host,
        parentDid: '',
        subDevices: {}
      };
    }
    return out;
  },

  /** 这个插件不描述设备能力，返回 null（插件清单里 capabilities.spec 也是 false） */
  async getSpecForDevice() {
    return null;
  },

  /**
   * 控制通道。
   *
   * ⚠️ 返回**空数组**是有意为之：这个样例只做「发现」，不做控制。
   * 而且 `plugin.json` 里 `capabilities.lanControl` 也是 false ——
   * 声明与实现必须一致，声明 true 却给空数组会让宿主显示一个点不动的开关。
   *
   * 宿主拿到空数组时的行为：设备列表照常显示，但点开关会抛
   * 「插件未提供任何控制通道」。这是**正确**的降级 ——
   * 如果这里返回一条假通道，用户点了没反应还查不出原因，那才是坏体验。
   */
  async createTransports() {
    return [];
  },

  /**
   * ④ 销毁。
   *
   * 这里不需要手动关 socket —— 本插件每次探测都是「开→用→关」的短生命周期。
   * 但如果你的插件持有**长期连接**（比如一条常驻的 MQTT），必须在 dispose 里
   * 自己 close：宿主虽然也会兜底回收（插件被停用/卸载时统一关），
   * 但主动关能保证时序可控。
   */
  async dispose() {
    config = null;
  }
});
