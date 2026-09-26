# 插件故障排查

> 摘自 `docs/插件开发指南.md` §4.1 / §13。**与原文冲突时以原文为准。**

## 读日志的正确姿势

| 前缀 | 内容 |
| --- | --- |
| `[plugin:<你的插件id>]` | 你通过 `Host.log` 打的日志 |
| `[PluginSandbox]` | 宿主侧的加载过程（注册失败、bootstrap 失败都打在这里） |

**先分清「插件的问题」和「宿主的问题」** —— 这个工程里有大量「宿主报错、插件无辜」的组合，
分不清会把时间全花在改自己的代码上。

---

## ⚠️ 关于 §13 里的自测脚本

开发指南 §13 提到的四个脚本：

- `scripts/simulate_plugin_load.js`
- `scripts/check_bootstrap_template.js`
- `scripts/verify_bootstrap_stitch.js`
- `scripts/verify_invoke_handshake.js`

**不在 miha_plugin 仓库里**（这个仓库只有 `docs/` 和 `plugins/`）。它们属于**宿主工程**。
拿到宿主工程之前，用 SKILL.md §Step 6 里那套「假 `Plugin` / `Host` 跑一遍 + `node --check`」替代。

其中 `check_bootstrap_template.js` 和 `verify_bootstrap_stitch.js` / `verify_invoke_handshake.js`
测的是**宿主自己的代码**（`PluginSandbox.ets` 的模板字符串和握手时序），
插件作者一般用不到 —— 除非你在改宿主。

---

## 症状 → 定位表

### 插件根本跑不起来

| 症状 | 先查这里 |
| --- | --- |
| 卡片上**没有**「登录」按钮 | `plugin.json` 的 `login.type` 写了没 / 写对没；卡片处于「不兼容」状态时也不给 |
| 点「登录」提示「插件未能加载：XXX」 | **冒号后面的 XXX 就是确切原因**，照它查；没带冒号说明是插件连不上沙箱 |
| 提示「插件运行环境未就绪」 | 页面里的运行环境还没准备好。宿主等 3 秒，超时说明 ArkWeb 没起来（真问题，查页面） |
| 提示「插件加载出错：…」 | 插件加载期抛的异常，引号里是原始 message |
| 提示「插件没有调用 Plugin.register」 | 插件跑到最后没注册自己，或注册时抛错被吞了 |
| 提示「读取插件入口失败」 | `plugin.json` 的 `entry` 指向的文件不存在 / 是空的 |
| 提示「插件尚未启用」 | 卡片还是「待启用」状态，需要先确认权限 |
| 插件装了、启用了，却一直显示「未连接」 | 沙箱宿主页面没起来。日志里搜 **「沙箱宿主页面就绪」**：<br>**有** → 沙箱没问题，查插件侧；<br>**没有** → 承载沙箱的组件没跑起来，**与插件无关**（宿主侧的尺寸 / 渲染条件问题） |

### 登录

| 症状 | 先查这里 |
| --- | --- |
| 登录面板一直转圈 | `loginBegin` 没返回 `sessionId`；`qr` 视图忘了给 `pollInterval`（或给了 0） |
| 面板显示「正在准备登录…」+ 转圈 | **正常**，宿主在等 `loginBegin` 返回。一直停在这里多半是 `loginBegin` 里的网络请求卡住了（宿主上限 60s，桥的单请求上限 15s） |
| 面板显示「等待操作…」且下方空白 | 宿主拿到的视图里既没二维码、也没授权页 URL、也没有表单字段。检查 `view.type` 是否写成了协议外的值（只认 `qr` / `web` / `form`） |
| 面板显示「轮询失败」 | 宿主连续 3 次调 `loginPoll` 都抛错（一次网络抖动会被容忍）。**排队态要返回 `pending` 而不是抛错** |
| 二维码不显示 | `imageUrl` 给的地址宿主下不下来；沙箱里不能 `fetch` 图片 |
| 二维码出来但服务端响应内容不全 | 大概率是**忘了带 Cookie**（很多平台靠 Cookie 串联两步请求）。见 `host-bridge.md` §2 |
| 点「登录」弹出空表单 | `plugin.json` 写了 `login` 字段但没实现。不需要登录就**删掉这个字段** |

### 数据面 / 设备

| 症状 | 先查这里 |
| --- | --- |
| 设备没有房间 / 显示离线 / 图标不对 | **`Device` 字段名写成了驼峰**。必须是 `room_id` / `isOnline` / `local_ip` / `parent_id` / `home_id`（见 `protocol.md` §5.1） |
| 家庭是空的 | `Home` 形状写错了（早期样例写过 `roomIds` / `deviceIds`，宿主不会猜） |
| 设备列表整个空白 | `getDevices` 抛错了。**拿不到凭据时应返回 `{}` 而不是抛错** —— 抛错会让整页加载失败 |
| 开关点了没反应，界面却显示「已打开」 | `setProperty` 失败时**没有 throw**。返回 `false` / `undefined` 会被当成写成功 |
| 局域网设备控制不了 | `permissions` 里没声明 `lan`；或 `priority` 顺序错了（写操作只在**第一条可用通道**上执行一次） |
| `Host.udp` 是 undefined | `permissions` 里没声明 `lan` |
| 收发报文内容不对 | 大概率是 base64 ↔ `Uint8Array` 转换写错了；**确认没在用 `TextEncoder`** |
| TCP 报文解析错位 | TCP 是流不是消息，会切包和粘包 —— 必须自己攒缓冲区 |
| `Host.tls.open` 报错 | 常见是 `isBidirectionalAuthentication` 开了却没配 `clientCert` / `clientKey` |
| `Host.httpForm` 发出去的表单体是 `0=d&1=a&2=t...` | `fields` 传了编好的字符串。**必须传键值对象** |
| 签名对不上，服务端 401 | 把 Base64 文本当字节摘要了。用 `base64ToHex` + `sha256BytesBase64`，见 `host-bridge.md` §4 |
| `init` 正常但登录后设备全空 | `secureStore.get` 读回来是**对象**，代码只写了 `JSON.parse(stored)`。见 `host-bridge.md` §3 |
| 相机直播无限转圈 | `getStreamUrl` 返回了凑数的地址。**对没能力的机型抛错才是正确行为** |
| 网关管理页一片空白 | 数值字段给了 `null`（应给 `-1`）；`blocked` 没归一化成布尔 |

### 设置面板（`settings`）

| 症状 | 先查这里 |
| --- | --- |
| 卡片上**没有**「设置」按钮 | `plugin.json` 的 `settings.items` 是空的 / 整段没写；卡片处于「不兼容」状态时也不给。见 `protocol.md` §9.1 |
| 设置面板打开全是空输入框 | 声明里没写 `default`，且用户从没保存过。面板会把 `default` 与已保存值合并显示，空说明两者都没有 —— 去补 `default` |
| 某项**点开就报错** / 显示成文本框 | 该条目的 `type` 写成了协议外的值（只认 text / password / number / switch / select / button），未知类型会退化成文本框。`select` 还要有非空的 `options` |
| 某条设置**完全看不见** | 条目没写 `key` —— 没有 `key` 的条目会被宿主直接丢掉；`select` 里缺 `value` 的选项同理 |
| 插件读到的设置值**永远是旧的** | 设置是**只读**的，且宿主**不会**因为改了设置就重连插件 —— `init()` 不会重跑。要立刻生效，必须在 `onSettingsChanged(values)` 里重读。见 `host-bridge.md` §3.1 |
| `Host.settings.all()` 抛「不是合法 JSON」 | 它的结果已经是**对象**，别再套 `JSON.parse`。见 `host-bridge.md` §3.1 |
| 点了动作按钮没反应 / 提示「插件未连接」 | 宿主会先尝试连接插件再调 `onSettingsAction`。连不上说明插件本身有问题，看提示里冒号后面的原因 |

### 调用过程中的报错

| 症状 | 含义 | 怎么办 |
| --- | --- | --- |
| 报「插件运行环境正在重建，请重试」 | 沙箱页面被 ArkUI 重建（**弹窗也会触发**），派发函数还没重新注入 | **重试即可**，通常几百毫秒恢复。别怀疑自己的代码 |
| 报「插件方法 X 未受理（脚本返回 …）」 | 派发脚本没跑起来 —— 插件 `entry` 有语法错误，或沙箱状态异常 | 检查语法错误（`node --check`） |
| 报「插件方法 X 调用超时」（60s） | 你的方法真的没结算 —— 某个 `await` 永远没 resolve | 检查网络请求是否漏了超时、回调是否漏了 resolve |
| 报「插件方法 X 返回的不是有效信封: null」 | 宿主早期把调用脚本写成 async IIFE，而 `runJavaScript` **不等 Promise 结算** | 宿主侧已修（改成「同步返回 + 回调回推」）。若复现，是宿主的回归 |
| 运行一阵子后突然 `FindObject Unknown object` / `host does not have the interface method` | 代理对象被 GC 了（宿主早期忘了持强引用）。特征是**延迟出现**、与用户操作无关 | **不是插件的 bug**。宿主已修（`proxyObject` 保活 + 孤儿表兜底）。报给宿主维护者 |
| 调用失败但**恰好拿回了正确结果** | 走了孤儿表兜底路径（回推断了、宿主主动捞回） | 功能正常，但说明桥失效过一次。值得看一眼 `native proxy object not found` 的频率 |

### 日志里的噪音（**不是问题，别顺着查**）

| 日志 | 判定 |
| --- | --- |
| `插件 xxx 未成功注册: "yes"`（**值带引号**） | **不是插件的问题**。`runJavaScript` 返回值被 ArkWeb 包了一层引号。宿主已用 `normalizeJsResult()` 剥壳；若还遇到，是宿主的回归。<br>真正的失败长这样：`未成功注册: no:插件注册时抛的原因` |
| `native proxy object not found, name:Host` | 沙箱的 Web 被 ArkUI 重建了（弹窗、父组件重渲染都会触发），旧代理随之失效 |
| `cannot read property ok of null` | 多半是上一条的**后果** —— 调用进行到一半桥没了。宿主已加防护，但根因是重建 |
| `Host 未就绪，跳过重复注册` / `原生代理已注册过` | **正常**。组件重建后复用了同一个 controller，宿主正确跳过重复注册 |
| `bootstrap 失败: fatal:原生桥未注册` | 先搜日志有没有 **`[PluginSandbox] 宿主桥就绪`**。宿主桥要跨**两轮页面加载**才可用（见下） |
| `bootstrap 结果异常，拒绝继续` | bootstrap 回传了非 `ok` / `already` 的内容。这是**保护性失败**（避免后面撞在「Host 未定义」上） |
| `web controller is nullptr` | ArkWeb 首次构建 `Web` 组件时的内部噪音，**通常无害**。判定看三行是否配对：后续只要有 `CreateNWeb NWebId: N, size 1*1` 与 `NWeb size change from 0*0 to 1*1`，沙箱就是好的 |
| `fail to find a valid nweb with id:-1` | **冷启动出现一次是正常的**（controller 构造先于 nweb 创建，扑空一次）。<br>🔴 但**零尺寸那种**不一样：`id:-1` 之后**永远等不到** `CreateNWeb`，沙箱彻底没起来。<br>判定只看一条：**后面有没有跟 `CreateNWeb`** |
| 日志三连：`沙箱未就绪，无法加载插件` + `BindWebTagToWebInstance` + `fail to find a valid nweb with id:-1` | 🔴 沙箱的 `Web` 组件尺寸被改成了 **0**。零尺寸组件不参与布局测量，ArkUI 不会为它创建 nweb 实例，`onPageEnd` 永不触发 —— 组件在树里"挂着"、却根本没跑起来。宿主用的是 **1vp** + `Visibility.Hidden` |
| `RegisterClientDeathObserver failed` / `Found no matching cache` | **系统噪音**，与本工程无关，别顺着它查 |
| `FIX THIS APPLICATION ERROR: … 'pageInfos' has changed during render!` | **不要只查调用位置** —— 去该状态的 `@Watch` 链路上找**同步重入**。⚠️ 外层包 `setTimeout` **无效**（重入在函数内部）。这是宿主侧的路由状态问题，不是插件的 |

---

## 三个会影响你预期的宿主机制

### ① 宿主桥要跨**两轮页面加载**才可用

```
第 1 轮 onPageEnd   页面刚起来 → 装配 controller / bridge → registerJavaScriptProxy
                    → 主动重载页面（loadUrl）
                    ✗ 此时不能跑 bootstrap —— window.Host 还不存在
                    （SDK：注册的对象要到下次页面加载才在 JS 里可见）

第 2 轮 onPageEnd   重载完成后，代理才真正出现在 JS 上下文
                    → bootstrap：把扁平代理缝成 Host.secureStore.get 这样的命名空间
                    → 成功后才 autoConnectAll()（才开始加载插件）
```

**对你的影响**：从「页面开始加载」到「`init()` 能被调用」中间隔了**两次页面加载**，
比你直觉上要久。所以：

- 不要假设「进页面之后马上就能连上」；
- 如果 `init()` 里第一次调 `Host.http` 就报 `undefined`，**先怀疑桥还没到第 2 轮**，
  而不是插件写错了。日志里搜 **`[PluginSandbox] 宿主桥就绪`** —— 出现它才代表能用。

### ② 沙箱会被 ArkUI 重建（弹窗也会触发），重建后自动自愈

重建后 JS 上下文整个换新：`window.Host`、`__miha_invoke__`、你注册的 `impl` 全没了。
宿主会自动重装（重注册代理 → 重载页面 → 补 bootstrap → 重注你的插件源码）。

因此：

- **你的插件会被重新 `register` 一次**。`init()` 里有副作用（写文件、建连接、改全局状态）
  就要做成**幂等**，或者在 `dispose()` 里收干净。
- 重建**期间**的调用会失败并提示「插件运行环境正在重建，请重试」，通常几百毫秒。
- 自愈只在**同一插件**范围内进行 —— 插件已被禁用时不会被装回来，不用担心「停用了却还在跑」。

### ③ 你的插件方法是**位置参数**接收的

`__miha_invoke__` 里是 `fn.apply(impl, args)`，所以宿主
`invoke('setProperty', [did, siid, piid, v])` 会打到你的
`async setProperty(did, siid, piid, v)` 上，直接拿到四个参数。

`runJavaScript` **不等 Promise 结算**，所以宿主走的是「同步返回 `accepted` + 回调回推结果」
的握手。你不需要写任何代码配合，但要知道：**插件报错、宿主却在等超时**，
多半是你的某个 `await` 永远没 resolve。

---

## 最小排查顺序

1. **`node --check main.js`** —— 排除语法错误 / 误写 `import`。
2. **看 `[PluginSandbox]` 日志** —— 有「宿主桥就绪」吗？有「沙箱宿主页面就绪」吗？
3. **看提示语的冒号后面** —— 宿主现在会把确切原因拼进 UI 提示里，照它查。
4. **拿「安装内置示例」做对照** —— 内置示例也连不上，说明是宿主侧问题；只有你自己的插件
   连不上，才是插件侧问题。
5. **逐项核对交付前检查清单**（见 SKILL.md §6）。
