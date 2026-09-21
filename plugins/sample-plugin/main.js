/*
 * 示例插件：HA 只读看板
 *
 * 这不是一个能实际连上 Home Assistant 的成品，而是**插件协议的可运行样例**：
 * 它把「注册 → 读凭据 → 表单登录 → 拉取设备列表」这条最小链路走通，
 * 用来验证宿主侧的沙箱、桥、权限、卡片渲染是否都正常。
 *
 * 想接真东西，把 BASE_URL 换成你的 HA 地址、在登录表单里填长期令牌即可。
 *
 * ## 插件作者需要知道的几件事
 *
 * 1. 宿主提供两个全局对象：`Plugin`（注册自己）与 `Host`（调用原生能力）。
 *    别的什么都碰不到 —— 没有 window.document、没有 fetch（会被 CORS 挡）。
 *
 * 2. 所有原生调用都是异步的，都要 `await`。
 *
 * 3. 明确声明在 plugin.json 里的权限才能用对应能力，否则调用会抛异常。
 *    这个插件声明了 network / secureStore / log 三项。
 *
 * 4. `Host.crypto` 里**没有 rc4**（系统加密库不支持）。需要 RC4 的话
 *    在插件内部自己实现，十来行的事。
 */

let auth = null;

/** 读取已保存的凭据，并顺手校验一下还能不能用 */
async function loadAuth() {
  try {
    const raw = await Host.secureStore.get('auth');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    // 桥没权限或存储坏了都不该让 init 整体失败，当作「未登录」处理
    return null;
  }
}

Plugin.register({
  /**
   * ① 初始化。
   * 返回 true = 已连接可用；false = 需要登录（宿主会在卡片上显示「未连接」）。
   */
  async init() {
    auth = await loadAuth();
    if (!auth) return false;
    await Host.log.info('sample', '凭据已载入，目标 ' + auth.host);
    return true;
  },

  /**
   * ② 登录第一步：交付一个视图描述，宿主负责渲染。
   * 这个插件用 `form`（宿主画输入框），因为 HA 的登录就是「地址 + 令牌」。
   */
  async loginBegin() {
    const sessionId = 's' + Date.now();
    return {
      sessionId: sessionId,
      view: {
        type: 'form',
        fields: [
          {
            key: 'host',
            label: '服务器地址',
            type: 'text',
            placeholder: 'http://192.168.1.10:8123'
          },
          {
            key: 'token',
            label: '长期访问令牌',
            type: 'password',
            placeholder: '在 HA 的个人资料页创建'
          }
        ],
        submitLabel: '连接'
      }
    };
  },

  /**
   * ③ 表单提交。`fields` 是宿主按上面 fields 收集来的键值对。
   *
   * 返回的 state 只能是 pending / success / expired / error / cancelled，
   * 宿主按它决定是继续等、关弹窗还是显示错误。
   */
  async loginSubmit(_sessionId, fields) {
    let host = (fields.host || '').trim();
    // 用户很可能只填 IP，补个协议省得他踩坑
    if (host && host.indexOf('://') < 0) {
      host = 'http://' + host;
    }
    // 去掉结尾斜杠，避免拼出 http://x//api/
    while (host.length > 0 && host.charAt(host.length - 1) === '/') {
      host = host.substring(0, host.length - 1);
    }
    const token = (fields.token || '').trim();

    if (!host || !token) {
      return { state: 'error', message: '地址与令牌都要填' };
    }

    const res = await Host.http('GET', host + '/api/', {
      'Authorization': 'Bearer ' + token
    });

    if (res.status === 401) {
      return { state: 'error', message: '令牌无效或已过期' };
    }
    if (res.status !== 200) {
      return { state: 'error', message: '连接失败（HTTP ' + res.status + '）' };
    }

    auth = { host: host, token: token };
    await Host.secureStore.set('auth', JSON.stringify(auth));
    await Host.log.info('sample', '登录成功');
    return { state: 'success' };
  },

  async loginPoll() {
    // form 类型没有轮询概念，直接说还在等
    return { state: 'pending' };
  },

  async loginCancel() {
    return { state: 'cancelled' };
  },

  /**
   * ④ 数据面：家庭容器。
   *
   * 这个插件不区分房间，只给一个虚拟家庭。
   *
   * ⚠️ 字段名要按宿主 `Home` 的形状给：`id` / `name` / `dids` / `roomlist`。
   * 早期样例这里写的是 `roomIds` / `deviceIds`（看起来更语义化），
   * 结果宿主解析出来是个空家庭 —— **协议字段名不是随便起的，宿主不会猜**。
   */
  async getHomes() {
    return [{
      id: 'default',
      name: 'Home Assistant',
      uid: 'ha',
      dids: [],
      roomlist: []
    }];
  },

  /**
   * ⑤ 数据面：设备列表。
   *
   * ⚠️ 返回的 key **必须是 did**，宿主按 key 索引。
   * 也必须是普通对象（JSON 序列化后仍成立），不能带函数或循环引用。
   */
  async getDevices() {
    if (!auth) {
      // 数据面拿不到凭据时返回空而不是抛错：
      // 抛错会让整个设备列表加载失败，用户看到的是空白页而不是「未登录」
      return {};
    }

    const res = await Host.http('GET', auth.host + '/api/states', {
      'Authorization': 'Bearer ' + auth.token
    });
    if (res.status !== 200) {
      await Host.log.error('sample', '取实体失败 HTTP ' + res.status);
      return {};
    }

    let states;
    try {
      states = JSON.parse(res.body);
    } catch (e) {
      await Host.log.error('sample', '返回内容不是 JSON');
      return {};
    }
    if (!(states instanceof Array)) return {};

    const out = {};
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      const did = s.entity_id;
      if (!did) continue;
      const attrs = s.attributes || {};
      out[did] = {
        did: did,
        name: attrs.friendly_name || did,
        // model 用来猜图标，用实体域（light / switch / sensor…）最直观
        model: did.split('.')[0],
        urn: '',
        roomId: '',
        homeId: 'default',
        // unavailable / unknown 都算离线，否则界面上会显示一堆「在线但没数据」
        online: s.state !== 'unavailable' && s.state !== 'unknown',
        token: '',
        localIp: '',
        parentDid: '',
        subDevices: {}
      };
    }
    await Host.log.info('sample', '载入 ' + Object.keys(out).length + ' 个实体');
    return out;
  },

  /**
   * ⑥ 这个插件不声明 spec 能力，返回 null 让宿主降级成「开关 + 详情」的简化卡片。
   *
   * ⚠️ 返回 null 的前提是 `plugin.json` 里 **`capabilities.spec` 是 false**。
   * 声明 true 却返回 null，宿主会按「拿到空 spec」处理并报错 ——
   * 协议里 `capabilities` 是承诺，不是愿望。
   */
  async getSpecForDevice() {
    return null;
  },

  /**
   * ⑦ 控制通道。
   *
   * 这个样例声明了 `lanControl: false`，但**仍然给一条 cloud 通道** ——
   * 因为「只读看板」指的是「没有局域网能力」，不是「什么都不能控制」。
   * HA 的 REST API 本来就能调服务，所以这里给一条真的通道让
   * 「点开关 → 插件发请求 → 宿主收到结果」整条链路可验证。
   *
   * 返回的每一项形状是 `{id, kind, priority}`：
   *   - `id`   宿主之后用它回调 `setProperty` 等方法，插件据此知道走哪条路
   *   - `kind` 只用于日志与排查，宿主不解释它
   *   - `priority` **小的先试**。写操作只走第一条可用通道，所以顺序就是语义
   */
  async createTransports() {
    return [
      { id: 'ha-rest', kind: 'cloud', priority: 100 }
    ];
  },

  /**
   * ⑧ 通道可用性。
   *
   * 插件可以选择实现 `isTransportAvailable(transportId, device?)`。
   * 不实现的话宿主按「可用」处理 —— 所以这一条是可选的。
   * 实现了就要如实回答：返回 true 而实际连不上，会让每次操作都等一次超时。
   */
  async isTransportAvailable(transportId) {
    return transportId === 'ha-rest' && auth !== null;
  },

  /**
   * ⑨ 读属性。
   *
   * HA 没有 MIoT 的 siid/piid 模型，这里做一个**约定映射**让开关能跑起来：
   *   siid=2, piid=1 → 主开关（对应 entity 的 state）
   * 真实插件应该按 `getSpecForDevice` 返回的定义来实现，这里只是样例。
   */
  async getProperty(transportId, did, siid, piid) {
    if (!auth) throw new Error('未登录');
    const res = await Host.http('GET', auth.host + '/api/states/' + did, {
      'Authorization': 'Bearer ' + auth.token
    });
    if (res.status !== 200) {
      // 抛错而不是返回 undefined：undefined 表示「读到了但没值」，
      // 而 HTTP 404 是「读取失败」，两者在宿主侧走完全不同的路径
      throw new Error('HTTP ' + res.status);
    }
    const state = JSON.parse(res.body);
    if (siid === 2 && piid === 1) {
      return state.state === 'on';
    }
    return undefined;
  },

  /** 批量读：宿主可能一次要多个属性，逐条转发即可 */
  async getProperties(transportId, did, params) {
    const out = [];
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      let value;
      try {
        value = await this.getProperty(transportId, p.did || did, p.siid, p.piid);
      } catch (e) {
        value = undefined;
      }
      out.push({ did: p.did || did, siid: p.siid, piid: p.piid, value: value });
    }
    return out;
  },

  /**
   * ⑩ 写属性。
   *
   * ⚠️ 失败必须 **throw**。返回 false / undefined 会被宿主当成「写成功」，
   * 界面就会显示「已打开」而设备其实没动 —— 这是最难查的一类 bug。
   */
  async setProperty(transportId, did, siid, piid, value) {
    if (!auth) throw new Error('未登录');
    if (siid !== 2 || piid !== 1) {
      throw new Error('这个样例只支持 siid=2 piid=1');
    }
    const service = value ? 'turn_on' : 'turn_off';
    const res = await Host.http('POST', auth.host + '/api/services/homeassistant/' + service,
      {
        'Authorization': 'Bearer ' + auth.token,
        'Content-Type': 'application/json'
      },
      JSON.stringify({ entity_id: did }));
    if (res.status !== 200 && res.status !== 201) {
      throw new Error('HTTP ' + res.status);
    }
    // 契约是「返回属性值」，回显请求值即可
    return value;
  },

  /** ⑪ 动作。HA 没有对应概念，样例用服务调用代替 */
  async callAction(transportId, did, siid, aiid, inList) {
    return { called: true, siid: siid, aiid: aiid };
  },

  /** ⑫ 销毁：清掉内存里的凭据。宿主禁用或卸载时会调 */
  async dispose() {
    auth = null;
  }
});
