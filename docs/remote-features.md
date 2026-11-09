# 远程控制功能清单

> 按功能推进的活文档：做完一项勾一项，新想法进「功能池」。对标参考：WorkBuddy 手机版。
> 最后更新：2026-11-09（已合入 upstream v0.5.0 / Pi 1.5.0，全量验证通过）

## 当前架构

```
手机 App (Flutter)  ──┐
                      ├──► Relay (server/, :8788, 独立进程) ──► 桌面应用内置 gateway
MuMu 模拟器 (10.0.2.2)┘      E2EE + 配对强制（诊断模式需显式 env）     │ 出站 WS，不监听端口
                                                                    ▼
                                                    agent-host utilityProcess（真实 handlers）
```

- **gateway 已接入桌面应用**：随桌面应用启动（设置里启用后），设置开关热生效，宿主崩溃自动拉起后自动恢复
- 独立宿主脚本 `scratch/remote-real-host.mjs` 为会话期调试工具，未入库（无 UI 场景也走桌面 gateway；启用时注意避免双宿主）
- **Relay 可由桌面应用内置托管（局域网模式）**：esbuild 单文件 `out/relay/relay.mjs`（147KB，含 ws），RelayService 以 ELECTRON_RUN_AS_NODE 子进程托管，健康探测 + 退避重启 + 端口冲突探测（exclusive bind，Windows 双绑定陷阱）；打包经 extraResources 分发。自定义 Relay 模式仍支持手动/VPS
- PC 端唯一监听端口 8788（局域网模式默认，可在设置中改；2026-11-09 起从 8787 迁移，与北京 VPS 的 pi-relay 端口一致）

## 启动命令速查

```bash
# 桌面应用（局域网模式下内置 Relay + gateway 全部自动拉起，设置 → 消息渠道 → 自建托管）
npm run dev

# 手动 Relay（仅自定义模式 / 调试；局域网模式不需要）
RELAY_CIPHER_REQUIRED=false RELAY_ALLOW_PLAINTEXT_PUBLIC=diagnostic npm --prefix server run dev

# 手机端
cd mobile && flutter run -d 127.0.0.1:16384       # MuMu（局域网地址填 PC 局域网 IP，见设置卡片二维码）
cd mobile && flutter run -d 192.168.31.118:38043 # 真机无线调试
```

## 已完成 ✅

### 链路
- [x] 手机 → Relay → PC gateway → 真实 agent host 全链路（双端验证：MuMu + 真机小米 13 Ultra）
- [x] **gateway 接入桌面应用本体**：`RemoteControlController`（agent-host 进程内），设置开关热生效，随桌面启动，宿主崩溃自动恢复；修复 role=host 缺失与 ws 模块解析
- [x] headless toolchain polyfill（独立宿主用；应用内由 main 天然应答）
- [x] 连接层健壮性：hello_ack 门控 + 请求排队；手机断线自动重连；宿主网关自动重连
- [x] relay 修复：目标 peer 短暂缺席丢帧不断链（route.drop）

### 主页（手机）
- [x] 真实会话列表按 `projectRoot` 分组，折叠/展开（WorkBuddy 风格卡片）
- [x] 会话搜索（标题/项目名/路径）
- [x] 组头：路径 + 任务数 + 运行中红点 + ＋新建（带模型选择）+ ⋯刷新
- [x] 会话行：状态圆点 + 标题 + 时间/条数 + ⋯（重命名 / 删除 / 复制会话 ID）
- [x] **设置页**（AppBar 齿轮）：连接状态灯、Relay 地址、设备标识、Host ID、重新连接、断开返回

### 聊天页（手机）
- [x] 真实历史（含 thinking / toolCall / toolResult 还原）
- [x] 发指令 + 流式回复；**发送后立即 loading 态**（乐观用户气泡 + 「正在回复…」spinner，首字后消失）
- [x] **markdown 渲染**（assistant 气泡）：粗体/斜体/行内代码/代码块/标题/有序无序列表/链接（零依赖手写渲染器）
- [x] **思考过程折叠卡片**（💭 思考过程 + 预览 + 展开全文，对齐桌面）
- [x] 工具卡片（对齐桌面 ToolCallBlock）：toolCall/toolResult 按 toolCallId 配对、中文标签、输入预览、运行中/错误态
- [x] 审批卡片（批准/拒绝回传）+ 中止按钮
- [x] **"/" 命令面板**：输入 "/" 弹出内置命令 + PC 技能列表（skills.list），点选填入
- [x] AppBar 当前模型 chip → bottom sheet 切模型（models.preferences.get，enabledModels 过滤）

### 会话管理（手机）
- [x] 重命名（sessions.rename，对话框）
- [x] 删除（sessions.delete，二次确认）
- [x] **会话列表本地缓存** ✅ 新增：按 hostId 隔离存 shared_preferences（`remote.sessionsCache.<hostId>`），进页/重连先渲染缓存再静默刷新；运行中 dot 不进缓存、以刷新结果为准；损坏数据容错为空。单测 3 项（往返排序 / 多主机隔离 / 坏数据容错）

### 多 PC 切换（对标 WorkBuddy 设备选择器）
- [x] Relay：host 可自报**稳定 hostId + 展示名**（重连即覆盖注册）；hello_ack 下发**主机目录**（在线/离线 + lastSeenAt）；信封级 `hosts.list` 控制帧（relay 本地应答，零知识不受影响）
- [x] 桌面：电脑名称（默认 hostname）+ 持久 hostId 存入 `uiState.remoteControl`，gateway hello 携带，身份变更自动重建连接
- [x] 手机：主页头部改为**设备选择器**（当前 PC 名 + 在线/离线徽章）→ 底部弹层列出所有已知电脑（在线优先、离线显示「上次在线 x 前」、当前项 ✓）
- [x] 选中主机持久化（shared_preferences），重启后恢复；切换即重握手并按新 hostId 路由
- [x] 离线目标：请求**快速失败**而非 30s 超时；列表清空并提示「所选电脑当前离线」，上线后自动加载
- [x] 双宿主联调验收：桌面应用（真实会话，显示名 = 本机 hostname）+ 会话期伪装 PC 脚本（独立数据目录，hostId `host-fake-home-pc`）同时在线，手机来回切换数据互不串（该脚本未入库，复验需按 `scratch/e2ee-e2e.mjs` 的 host 侧重写）

### E2EE 端到端加密（Step 2）✅ 新增
- [x] **密钥模型**：host 静态 X25519 密钥对（私钥 PKCS8 存 `userData/remote-host-e2ee.json`，公钥进 uiState/配对二维码）；设备每次连接生成临时 X25519 密钥对；X25519 ECDH → HKDF-SHA256（双方公钥入 salt，防 unknown-key-share）→ AES-256-GCM，双向独立密钥（c2h/h2c）
- [x] **信封格式**：路由帧 `payload` = base64 密文 + `cipher{alg,keyId,iv,tag}` + 头部 `e2eePub`（发送方公钥）；AAD 绑定整个信封头 + cipher 元数据（canonical JSON，字段序固定），relay 改头/换向即解密失败
- [x] **hello 握手**：host hello 携带 `e2eePub` → relay 存主机目录 → 设备 hello_ack 的 hosts[] 下发；设备端与**扫码钉扎的公钥比对**（TOFU 锚点），不符即拒连并停自动重连（`handshakeError`）
- [x] **重放防护**：端侧滑动窗口 nonce 缓存（4096 条）+ ±120s 时间戳漂移；relay 头级 ts 窗（`RELAY_REPLAY_WINDOW_MS`，过期帧丢弃不断链 + 审计）
- [x] **relay 收紧**：`relay-service` 不再注入诊断 env——内置局域网 relay 默认 `cipherRequired` + `pairingRequired`；配对绑定持久化（`RELAY_STATE_PATH` → `userData/relay-pairings.json`，重启不清）；诊断明文仍可经显式 env 开启（本地调试）
- [x] **桌面**：`src/agent-host/remote/cipher.ts`（Node crypto）；gateway hello_ack 后进入 cipherMode，每设备会话密钥缓存（公钥变更自动轮换），镜像事件按设备封印；私钥只随 host-bound 配置下发（`withRemoteE2eeSecrets`），uiState/渲染器不可见（ui-state-patch 拒绝私钥字段）
- [x] **手机**：`mobile/lib/core/e2ee.dart`（cryptography 包 ^2.7，纯 Dart）；每次 connect 生成临时密钥、hello 携带公钥、hello_ack 校验钉扎、封序发送（`_sendChain` 保证乱序不串）；扫码载荷新增 `e2eePub`（连接前钉扎）
- [x] **测试**：cipher 5 项 + gateway E2EE 4 项（封/解/防篡改/防重放/事件封印）+ relay 2 项（目录公钥/ts 窗）+ 手机 8 项（**跨语言 golden 向量与 TS 字节级一致**）+ 桌面全量 1868/0；三方 E2E `node scratch/e2ee-e2e.mjs` 13/13（真实 relay formal 模式：配对→密钥协商→加密 RPC 往返、未配对 4003、明文 4002、relay 输出无明文、凭证重启存活）。✅ 2026-11-09 提交前复跑全绿：桌面 1868/0 + typecheck、手机全量 24/24、relay 15/15、三方 E2E 13/13
- [ ] **真机端到端**（MuMu/真机 + 桌面 app）：扫码配对 → 加密会话聊天，与 Step 1 扫码待办合并验证

### 配对凭证（Step 1）✅ 新增
- [x] **Relay**：`pairingRequired` 配置（默认 true，诊断需 `RELAY_ALLOW_PLAINTEXT_PUBLIC=diagnostic`）；`PairingService` 设备绑定表（`pairDevice`/`verifyDevice`/`revokeDevice`/`listDevices`，secret 哈希存储、timingSafeEqual 校验）；control 帧 `pair.create` / `pair.revoke` / `pair.devices`（仅 host 可发，cipher gate 之前处理，payload 只含元数据）
- [x] **hello 配对闸门**：device hello 的 `auth` 支持 `pairingToken`（一次性扫码令牌 → 自动批准绑定 + 签发 `deviceSecret`）与 `deviceSecret`（重连凭证）；新 token 优先于旧凭证（支持重新配对）；`pairingRequired` 下无有效凭证 close 4003 并审计
- [x] **桌面**：gateway `sendControl`（traceId 关联 relay 的 `*.result` 帧，5s 超时）；RPC `remote.pair.create/revoke/devices`（契约注册于 registerHandlers）；设置卡片新增「设备配对」区——添加设备（生成含 `{v,relayUrl,hostId,token}` 的配对二维码）、已配对设备列表 + 撤销（撤销即踢掉在线连接）
- [x] **手机**：`parseRelayQr` 支持 JSON 配对载荷（兼容纯 URL）；deviceId 持久化（`remote.deviceId`）；配对成功自动保存 relay 签发的 `deviceSecret`；重连 hello 携带凭证，免重复扫码
- [x] 测试：relay 13 项（配对发放/重连/撤销踢线/单次令牌/无效令牌/未配对拒绝）、gateway 12 项（control 往返/header/断链拒绝）、手机 16 项（QR JSON 解析等）；三端 typecheck + 桌面全量 1859 通过
- [ ] **真机扫码配对端到端**（需物理相机 + 设置页点「添加设备」）：与「真机扫码端到端」待办合并验证

### 扫码连接（手机端）✅ 新增
- [x] 桌面端二维码：局域网模式与**自定义 Relay 模式都有**（矩阵直绘 SVG，无 canvas 依赖；自定义模式带「显示/收起」开关 + 地址复制按钮）
- [x] 手机端 `mobile_scanner`（7.5）：扫码页（QR-only、绿框取景、手电筒、切换摄像头、非 relay 码提示）
- [x] 连接页入口：地址框右侧扫码图标 + 「扫描电脑屏幕上的二维码」按钮；识别成功自动填入并**直接连接**
- [x] `parseRelayQr` 解析容错：接受 `ws://`/`wss://`，把 `http(s)` 归一化为 `ws(s)`，缺路径补 `/ws`，拒绝非 relay 载荷（5 个单测全过）
- [ ] 真机扫码端到端（需物理摄像头；MuMu 模拟器无真实相机，仅验证页面与权限流）

### steer / follow-up 排队消息 + clear_queue（对标 PC 回合中交互）✅ 新增
- [x] 发送逻辑：`agent.running` 流驱动回合状态镜像——运行中发送自动改为 `steer`（插队，本轮内送达），空闲发 `prompt`；对标 PC「Enter=steer」
- [x] 输入框运行中态：黄色边框 + 提示「回合进行中，发送将插队…」
- [x] 队列横条：运行中每 5 秒轮询 `agent.state`（`agentState.queuedMessages`），黄色横条显示「已排队 n 条」+ 每条内容（⚡ 插队 / ⏭ 排队）+ **清空**按钮（`clear_queue`，带 loading，用返回值刷新）
- [x] 生命周期：`agent.running` 订阅驱动轮询启停（空闲零开销）；进入页面从 `sessions.get` 的 `agentState.running` 恢复状态；回合结束自动清空横条
- [x] 白名单补充：`agent.state`（只读）三处镜像 + gateway 测试断言
- [x] 协议 E2E 验收（会话期脚本，未入库）：prompt 长回合 → steer + follow_up → `get_state` 快照确认两条在队列 → `clear_queue` → 队列确认清空，全 PASS
- [x] **手机 UI 视觉确认** ✅ 2026-11-09（MuMu + uiautomator 文本断言）：黄条 5 秒轮询内出现「已排队 1 条（回合中送达）」、条目带「⚡ 插队」标记、清空按钮生效。验证前发现并修复两个 bug：
  1. **回合状态镜像断裂**：PC 端 `agent.running` 事件负载是全局 `{sessionIds, runningSessionIds}`（handlers.ts），chat_page 却读 `data['running']` 布尔 → 永远 false，运行中发送退化为 prompt、黄条不出现。已改为 `ids.contains(sessionId)`
  2. **恢复路径失效**：`sessions.get` 需显式 `includeState: true` 才返回 agentState，chat_page 未传 → 进页恢复 running 态永远 false。已补传

### 息屏保活（Android 前台服务）✅ 新增
- [x] `flutter_foreground_task` 11.x：TaskHandler 在**服务 isolate 回调**里注册（主 isolate 注册会向主引擎发无 handler 的 start → MissingPluginException 噪音，已避开）；`startService` 携带 callback
- [x] Service 声明 `foregroundServiceType="connectedDevice"` + `stopWithTask="true"`（应用关闭即停）；Android 14+ 该类型要求 anyOf 权限，补 `CHANGE_NETWORK_STATE`（普通权限，安装即授予）
- [x] `ForegroundTaskOptions`：`eventAction: nothing()`（不周期唤醒）、WakeLock + WifiLock 开启、不自启
- [x] 设置页「息屏保活」开关（默认开，shared_preferences），连接成功即启动、断开连接即停止
- [x] MuMu 实测：服务 `isForeground=true types=0x10`、常驻通知（ONGOING|NO_CLEAR）、息屏 30 秒（Asleep）期间 `devices` 恒为 1，唤醒后链路完好
- [ ] 真机回归（小米 13 Ultra）：息屏 + 锁屏 + 后台 5 分钟链路不断；需系统设置放行自启动、电池策略「无限制」

### 桌面设置 UI
- [x] 消息渠道 → 「自建托管」卡片：总开关 + **模式单选（局域网内置 / 自定义 Relay）** + 端口（可改）+ **局域网地址（网卡枚举，虚拟网卡过滤，点标签切换）+ 一键复制 + 二维码**（矩阵直绘 SVG）+ 服务状态灯（运行中/启动中/端口冲突/意外停止 + 明细）+ PC 名称 + 已连设备数
- [x] **托盘菜单快捷开关** ✅ 新增：托盘 checkbox「手机远程控制」，点击走与设置卡片同一链路（applyRemoteControlConfig 归一化 + RelayService 启停 + gateway 热生效）；设置卡片改开关时托盘勾选同步，托盘切换后设置卡片经 onRemoteStatus(state=disabled) 镜像回本地草稿
- [x] **手动重连按钮** ✅ 新增：状态行「重连」（启用时显示）→ `desktop:reconnect-remote` IPC → main 拉起内置 relay（lan 模式，start 对 running 幂等）+ host-manager 转发 `remote:reconnect` → controller `reconnectNow()`（dispose 旧 gateway + 立即重拨，不等 3s 自动重连轮；也解救卡在 connecting 的假死连接）；按钮 1.5s busy 反馈

### 内置 Relay（局域网服务）✅ 新增
- [x] `server/` esbuild 单文件打包（`scripts/build-relay.mjs` → `out/relay/relay.mjs`，147KB 含 ws），build/dev 流程接入，打包版经 extraResources 分发
- [x] `RelayService`（src/main/relay-service.ts）：ELECTRON_RUN_AS_NODE 子进程托管、/healthz 健康探测、退避重启（3/6/12s ×3）、exclusive-bind 端口冲突探测（Windows 允许双绑定的陷阱）、崩溃/冲突明细透出 UI
- [x] `uiState.remoteControl` 扩展 `mode: "lan" | "custom"` + `lanPort`；lan 模式 gateway 自动拨 `ws://127.0.0.1:<port>/ws`，custom 模式行为不变
- [x] `listLanAddresses`（src/main/lan-addresses.ts）：IPv4 网卡枚举，过滤 loopback/链路本地/虚拟网卡（WSL/Hyper-V/VMware/Docker/VPN 等），物理网卡优先
- [x] MuMu 实测：局域网地址 `ws://192.168.31.68:8787/ws` 直连内置 relay 全链路通（healthz hosts 1 / devices 1）
- [x] 端口冲突实测：预占端口 → `port-conflict` 状态 + 明细；解除后重启恢复 running

### 远程白名单（安全面变更，三处镜像 + gateway 测试）
- [x] `models.preferences.get` / `skills.list`（只读）
- [x] `sessions.rename` / `sessions.delete`（会话管理）
- [x] 显式禁止清单：models.list/refresh/各 set、skills.search/install/set/getContent、settings.* 等
- [x] gateway 测试 9 项（含放行/拒绝断言）+ relay 测试 10 项（含多 PC 目录三例）全过

## 已知问题 ⚠️

- ~~手机聊天页消息重复渲染~~ ✅ 已修复（2026-11-09）：根因是流式 upsert 只看最后一行，消息内 thinking/text 交替时每轮 update 追加新行；改为从尾向前找同 role 同 kind 未完结行（_findOpenLine），done 行/异 role 行作为消息边界
- E2EE 信任模型限制：设备公钥无带外锚点（host 侧信任 hello 中自报的设备临时公钥，靠 GCM 认证防伪造）；host 公钥靠**扫码 TOFU 钉扎**，手动输入地址直连的设备只能信任 relay 下发的公钥（恶意 relay 可对这类设备做 MITM）；host 私钥存本地明文文件（M2 可迁 OS keychain）
- relay 重启后配对凭证已持久化（relay-pairings.json）；主机目录（离线记录）仍是内存态，重启清空
- PC 局域网 IP 为 DHCP 分配，变化后手机端需改 Relay 地址
- 手机息屏/Wi-Fi 休眠断链：已由前台服务 + WifiLock 兜底（MuMu 验证通过，真机回归待做）；厂商杀后台仍需系统设置放行
- **升级注意**：Step 2 后内置 relay 强制配对——旧连接的设备需在桌面设置重新扫码配对一次（配对表持久化后无需重复）
- i18n 门禁存在 6 个历史遗留失败（models/ProviderModelDiscovery.tsx，与远程控制无关）
- 本机 MuMu 构建需 `kotlin.incremental=false`（Kotlin 增量缓存关闭失败的环境问题，已写入 mobile/android/gradle.properties）

## 功能池（按需领取）

- [x] ~~配对凭证 + 设备密钥~~ ✅ Step 1（扫码 token → deviceSecret）+ Step 2（X25519 密钥钉扎）
- [x] ~~E2EE（每设备 X25519 密钥，relay 零知识）~~ ✅ Step 2：host 静态 + 设备临时密钥、AAD 绑定、重放防护、relay 强制密文
- [ ] ~~Relay 部署 VPS~~ ✅ 北京腾讯云已部署（pm2 :8788，强制 E2EE + 配对，见 [relay-deploy.md](relay-deploy.md)）；剩安全组放行 + 客户端接入验收
- [x] ~~托盘菜单快捷开关~~ ✅ 托盘 checkbox「手机远程控制」，与设置卡片同链路（applyRemoteControlConfig + RelayService + gateway 热生效）
- [x] ~~端口迁移~~ ✅ 默认端口 8787 → 8788（VPS 上 8787/8443 被占；桌面/relay/手机占位符已同步）
