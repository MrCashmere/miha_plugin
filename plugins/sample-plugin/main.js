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
 *
 * 5. 插件可以声明 `settings`（见 plugin.json），宿主会画出设置面板，但插件
 *    **只能读**（`Host.settings`）—— 写入权在宿主 UI 里。注意它和 secureStore
 *    的分工：设置存**用户配置**（用户填、插件读），secureStore 存**插件凭据**
 *    （插件自己读写、用户看不见）。
 */

let auth = null;

/**
 * 用户在宿主设置面板里填的值，插件**只读**。
 *
 * 这是「用户配置」；`secureStore` 里那份凭据是「插件凭据」。两者分开的好处
 * 在卸载时才看得见：用户填的东西你删不掉，你存的凭据用户也看不到。
 */
let settings = { autoRefresh: true, maxEntities: 100, entityFilter: 'all' };

/** 清单里声明的 default —— 用户点「恢复默认」时宿主传空对象，插件按这份回落 */
const DECLARED_DEFAULTS = { autoRefresh: 'true', maxEntities: '100', entityFilter: 'all' };

/** `entityFilter` 认得的取值；对不上任何一项时当 all，免得用户看到一个空列表 */
const FILTERS = ['all', 'light', 'switch', 'sensor'];

/**
 * 关掉自动刷新后，上一次的结果最多复用多久。
 *
 * 默认是**开**自动刷新（DECLARED_DEFAULTS 里是 'true'）—— 样例开箱就要能看到
 * 实时数据，不然读的人容易把「30 秒内的缓存」误当成「插件坏了不刷新」。
 */
const CACHE_TTL_MS = 30000;

/** 上一次从 HA 拿到的实体列表。纯插件内部缓存，和设置无关 */
let stateCache = null;

/**
 * 从一份键值对象里取值：键**不存在**时回落到清单声明的 default。
 *
 * 「键不存在」和「值是空串」必须分开看待 —— 前者是「用户没动过这一项」，
 * 后者是「用户把它清空了」，插件对这两种情况的处理往往不一样。
 */
function pick(values, key) {
  const raw = values ? values[key] : undefined;
  return (typeof raw === 'string') ? raw : DECLARED_DEFAULTS[key];
}

/** 把一份键值对象归一化成插件内部用的形状 */
function normalizeSettings(values) {
  const limit = Number(pick(values, 'maxEntities'));
  const filter = pick(values, 'entityFilter');
  return {
    autoRefresh: pick(values, 'autoRefresh') === 'true',
    // number 控件不做数值校验，脏值/空串一律当「不限制」（0）
    maxEntities: (isFinite(limit) && limit > 0) ? Math.floor(limit) : 0,
    entityFilter: FILTERS.indexOf(filter) >= 0 ? filter : 'all'
  };
}

/**
 * 读一次宿主里的设置。
 *
 * 读不到就按 default 跑 —— 设置是「有更好、没有也能用」的附加能力，
 * 不该因为它出问题就让整个插件起不来。
 */
async function loadSettings() {
  try {
    // ⚠️ all() 回来的**已经是对象**，别再 JSON.parse（拆包层会 parse 一遍）
    const all = await Host.settings.all();
    return normalizeSettings(all);
  } catch (e) {
    return normalizeSettings(null);
  }
}

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
    // 宿主在每次调数据面方法前都会调 init()，所以在这里重读设置 = 永远拿最新值。
    // （它也是「改了设置怎么立刻生效」最省事的答案，见 onSettingsChanged 的注释）
    settings = await loadSettings();
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

    // 「自动刷新」关掉时，30 秒内的重复请求复用上一次的结果；开着就每次重新取。
    // 注意插件**没法**要求宿主刷新界面（协议里没这个口子），这个开关能控制的
    // 只是「插件自己要不要省掉这次 HTTP」，控制不了宿主何时来取。
    const reuse = !settings.autoRefresh && stateCache !== null
      && (Date.now() - stateCache.at) < CACHE_TTL_MS;

    let states;
    if (reuse) {
      states = stateCache.states;
    } else {
      const res = await Host.http('GET', auth.host + '/api/states', {
        'Authorization': 'Bearer ' + auth.token
      });
      if (res.status !== 200) {
        await Host.log.error('sample', '取实体失败 HTTP ' + res.status);
        return {};
      }

      try {
        states = JSON.parse(res.body);
      } catch (e) {
        await Host.log.error('sample', '返回内容不是 JSON');
        return {};
      }
      if (!(states instanceof Array)) return {};
      stateCache = { states: states, at: Date.now() };
    }

    // 筛选与截断每次都按**当前**设置重算，所以用户在面板里改完，下一次取设备
    // 就生效了 —— 不需要宿主重连插件，也不受上面那份缓存的影响。
    const wanted = [];
    for (let j = 0; j < states.length; j++) {
      const raw = states[j];
      const rawDid = raw.entity_id;
      if (!rawDid) continue;
      if (settings.entityFilter !== 'all'
        && rawDid.indexOf(settings.entityFilter + '.') !== 0) continue;
      wanted.push(raw);
    }

    // 先排序再截断：不然「最多显示 N 个」每次截到的可能是不同的实体
    wanted.sort(function (a, b) {
      if (a.entity_id < b.entity_id) return -1;
      if (a.entity_id > b.entity_id) return 1;
      return 0;
    });

    const limit = settings.maxEntities;
    const picked = (limit > 0) ? wanted.slice(0, limit) : wanted;
    if (limit > 0 && wanted.length > limit) {
      await Host.log.info('sample', '按设置截断 ' + wanted.length + ' → ' + picked.length);
    }

    const out = {};
    for (let i = 0; i < picked.length; i++) {
      const s = picked[i];
      const did = s.entity_id;
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
    await Host.log.info('sample',
      '载入 ' + Object.keys(out).length + ' 个实体（筛选 ' + settings.entityFilter + '）');
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

  /**
   * ⑫ 设置变更（可选钩子）。用户点「保存」或「恢复默认」之后调用。
   *
   * ⚠️ 宿主**不会**因为设置变了就重连插件 —— `init()` 不会重跑。想让新值立刻
   * 生效，只能在这里自己接住。（本插件把筛选/截断留到 getDevices 里实时计算，
   * 所以这里更新缓存就够了；若你的配置要重建连接或重算 token，就在这里做。）
   *
   * `values` 是**全量**键值对象（不是本次改动的 diff），可以安全地重建整份配置；
   * 点「恢复默认」时它是**空对象** `{}`（存储被清空），此时按声明的 default 回落。
   */
  async onSettingsChanged(values) {
    settings = normalizeSettings(values);
    await Host.log.info('sample', '设置已更新: ' + JSON.stringify(settings));
  },

  /**
   * ⑬ 设置里的动作按钮（可选钩子）。`action` 是条目上写的 `action`（缺省用 `key`）。
   *
   * 这里实现「测试连接」：用已保存的凭据打一次 HA 的 /api/。
   * 返回的 `{ message }` 会直接显示在设置面板上，所以**别抛错** ——
   * 「连不上」是用户要看的结论，不是异常。
   */
  async onSettingsAction(action, values) {
    if (action !== 'test') {
      // 认不出的动作回一句空话，别装死也别报错
      return { message: '' };
    }
    // 动作按钮同样会带全量设置过来，先同步一次，保证测的就是面板上现在这份配置
    settings = normalizeSettings(values);
    if (!auth) {
      return { message: '还没登录，请先在卡片上点「登录」' };
    }
    try {
      const res = await Host.http('GET', auth.host + '/api/', {
        'Authorization': 'Bearer ' + auth.token
      });
      if (res.status === 200) return { message: '连接成功（' + auth.host + '）' };
      if (res.status === 401) return { message: '令牌已失效，请重新登录' };
      return { message: '失败：HTTP ' + res.status };
    } catch (e) {
      return { message: '失败：' + ((e && e.message) ? e.message : String(e)) };
    }
  },

  /** ⑭ 销毁：清掉内存里的凭据与缓存。宿主禁用或卸载时会调 */
  async dispose() {
    auth = null;
    stateCache = null;
  }
});
