# 远程控制功能清单

> 按功能推进的活文档：做完一项勾一项，新想法进「功能池」。对标参考：WorkBuddy 手机版。
> 最后更新：2026-11-08

## 当前架构

```
手机 App (Flutter)  ──┐
                      ├──► Relay (server/, :8787, 独立进程) ──► 桌面应用内置 gateway
MuMu 模拟器 (10.0.2.2)┘         诊断明文模式                        │ 出站 WS，不监听端口
                                                                    ▼
                                                    agent-host utilityProcess（真实 handlers）
```

- **gateway 已接入桌面应用**：随桌面应用启动（设置里启用后），设置开关热生效，宿主崩溃自动拉起后自动恢复
- 独立宿主脚本 `scratch/remote-real-host.mjs` 仍可用于无 UI 场景（启用桌面 gateway 时需停掉它，避免双宿主）
- **Relay 可由桌面应用内置托管（局域网模式）**：esbuild 单文件 `out/relay/relay.mjs`（147KB，含 ws），RelayService 以 ELECTRON_RUN_AS_NODE 子进程托管，健康探测 + 退避重启 + 端口冲突探测（exclusive bind，Windows 双绑定陷阱）；打包经 extraResources 分发。自定义 Relay 模式仍支持手动/VPS
- PC 端唯一监听端口 8787（局域网模式默认，可在设置中改）

## 启动命令速查

```bash
# 桌面应用（局域网模式下内置 Relay + gateway 全部自动拉起，设置 → 消息渠道 → 自建托管）
npm run dev

# 手动 Relay（仅自定义模式 / 调试；局域网模式不需要）
RELAY_CIPHER_REQUIRED=false RELAY_ALLOW_PLAINTEXT_PUBLIC=diagnostic npm --prefix server run dev

# 独立宿主（可选，无 UI 场景；与桌面 gateway 二选一）
node scratch/remote-real-host.mjs

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

### 多 PC 切换（对标 WorkBuddy 设备选择器）
- [x] Relay：host 可自报**稳定 hostId + 展示名**（重连即覆盖注册）；hello_ack 下发**主机目录**（在线/离线 + lastSeenAt）；信封级 `hosts.list` 控制帧（relay 本地应答，零知识不受影响）
- [x] 桌面：电脑名称（默认 hostname）+ 持久 hostId 存入 `uiState.remoteControl`，gateway hello 携带，身份变更自动重建连接
- [x] 手机：主页头部改为**设备选择器**（当前 PC 名 + 在线/离线徽章）→ 底部弹层列出所有已知电脑（在线优先、离线显示「上次在线 x 前」、当前项 ✓）
- [x] 选中主机持久化（shared_preferences），重启后恢复；切换即重握手并按新 hostId 路由
- [x] 离线目标：请求**快速失败**而非 30s 超时；列表清空并提示「所选电脑当前离线」，上线后自动加载
- [x] 双宿主联调验收：桌面应用（真实会话，显示名 = 本机 hostname）+ `scratch/remote-fake-host-b.mjs`（临时伪装 PC，独立数据目录）同时在线，手机来回切换数据互不串
  - 该脚本保留作回归夹具：`node scratch/remote-fake-host-b.mjs`（hostId `host-fake-home-pc`），验证完记得停掉

### 扫码连接（手机端）✅ 新增
- [x] 桌面端二维码：局域网模式与**自定义 Relay 模式都有**（矩阵直绘 SVG，无 canvas 依赖；自定义模式带「显示/收起」开关 + 地址复制按钮）
- [x] 手机端 `mobile_scanner`（7.5）：扫码页（QR-only、绿框取景、手电筒、切换摄像头、非 relay 码提示）
- [x] 连接页入口：地址框右侧扫码图标 + 「扫描电脑屏幕上的二维码」按钮；识别成功自动填入并**直接连接**
- [x] `parseRelayQr` 解析容错：接受 `ws://`/`wss://`，把 `http(s)` 归一化为 `ws(s)`，缺路径补 `/ws`，拒绝非 relay 载荷（5 个单测全过）
- [ ] 真机扫码端到端（需物理摄像头；MuMu 模拟器无真实相机，仅验证页面与权限流）

### 桌面设置 UI
- [x] 消息渠道 → 「自建托管」卡片：总开关 + **模式单选（局域网内置 / 自定义 Relay）** + 端口（可改）+ **局域网地址（网卡枚举，虚拟网卡过滤，点标签切换）+ 一键复制 + 二维码**（矩阵直绘 SVG）+ 服务状态灯（运行中/启动中/端口冲突/意外停止 + 明细）+ PC 名称 + 已连设备数

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

- 诊断明文模式：手机端无 E2EE（relay 必须以诊断模式启动）
- 局域网模式下内置 Relay 与桌面应用同生命周期（应用退出即停）；明文传输的警示已在 UI 中
- PC 局域网 IP 为 DHCP 分配，变化后手机端需改 Relay 地址
- 手机息屏/Wi-Fi 休眠可能断链（自动重连兜底，无前台服务保活）
- 诊断模式下任意设备可枚举主机目录、可冒名注册同 hostId（正式模式须由配对凭证绑定）
- relay 重启会清空离线主机记录（内存态）
- i18n 门禁存在 6 个历史遗留失败（models/ProviderModelDiscovery.tsx，与远程控制无关）
- 本机 MuMu 构建需 `kotlin.incremental=false`（Kotlin 增量缓存关闭失败的环境问题，已写入 mobile/android/gradle.properties）

## 功能池（按需领取）

- [ ] 前台服务保活（息屏后链路不断，Android 前台服务）
- [ ] steer / follow-up 排队消息 UI 与 clear_queue（白名单已放行）
- [ ] 会话列表本地缓存（断线重连不重新全量拉取）
- [ ] 配对凭证 + 设备密钥（**扫码连接已完成**；但仍是诊断明文，正式模式需要配对 token 与每设备密钥，与 E2EE 一起做）
- [ ] E2EE（每设备 X25519 密钥，relay 零知识）
- [ ] Relay 部署 VPS（Docker + TLS，手机 4G 可连；配合 custom 模式与扫码配对）
- [ ] 托盘菜单快捷开关
