# Remote Control 协议规范 v1

> 对应实现：`packages/protocol/`（单一真源）
> 上位文档：`docs/remote-control-plan.md` §3、§4、§8
> 状态：M0 冻结版 · 2026-11-05

## 1. 传输与角色

- 传输：WebSocket（RFC 6455），路径 `WS /ws?role=host|device`。PC 侧永远只作为**出站客户端**（role=host），不监听端口。
- 角色：`host`（桌面 Gateway，一台 PC 一个 hostId）与 `device`（手机，deviceId 标识）。
- 编码：UTF-8 JSON 文本帧。

## 2. 信封 RemoteEnvelope

每个 WS 帧（除握手前的 HTTP 层）都是一个信封：

```jsonc
{
  "v": 1,                  // 协议版本，hello 协商，不匹配则拒绝
  "traceId": "…",          // 全链路追踪，进审计日志
  "ts": 1700000000000,     // 发送方毫秒时间戳，防重放窗口 ±120s
  "nonce": "…",            // 全局唯一，防重放 + 幂等
  "role": "device",        // host | device
  "deviceId": "…",         // device 必填
  "hostId": "…",           // 指向目标 host；host→device 方向由 Relay 填
  "cipher": {              // 仅当 payload 为密文时存在
    "alg": "x25519-aes-gcm",
    "keyId": "…",          // 设备会话密钥标识
    "iv": "…",             // base64
    "tag": "…"             // base64
  },
  "payload": { … }         // WireMessage（明文）或 base64 密文字符串
}
```

规则：

1. **hello 之后的所有载荷，公网模式下 `payload` 必须是密文字符串且必须带 `cipher`**；Relay 配置 `cipherRequired: true` 时，post-hello 的明文 payload 一律拒绝（close 4002）。本机/内网诊断模式可临时关闭（`hello` 协商），配置校验启动即失败防呆。
2. **hello 本身允许明文对象**：它是密钥协商前的唯一载荷，只携带认证材料（挑战签名、版本号、设备标签），不含任何会话内容，且 WS 层已有 TLS。
3. Relay 只解析 `v / traceId / ts / nonce / role / deviceId / hostId / cipher`，**不接触 post-hello 载荷明文**（零知识）。
4. `ts` 偏差超过 `RELIABILITY.replayWindowMs` 的帧丢弃并计入审计。

## 3. 载荷 WireMessage（复用桌面线协议）

与 `src/contract/rpc.ts:15-51` 完全同构，五种 `kind`：

| kind | 方向 | 说明 |
| --- | --- | --- |
| `request` | device → host | `{id, method, params}`；`id` 全局唯一，5 分钟滑动窗口内去重，重发返回首次结果 |
| `response` | host → device | `{id, ok, result?, error?}`；对 request.id |
| `event` | host → device | `{topic, key, data}`；`key` 为 sessionId 或 `"*"`（仅 `agent.running`/`sessions.changed` 等全局 topic） |
| `subscribe` | device → host | `{id, topic, key}`；**禁止 `key:"*"`**，必须显式 sessionId |
| `unsubscribe` | device → host | `{id, topic, key}` |

首个载荷必须是 `hello`（见 §4），在完成 `hello_ack` 之前，Relay 丢弃其余一切载荷。

## 4. 握手与版本协商

```jsonc
// device → relay（明文信封层，payload 密文与否按 §2 规则）
{ "kind": "hello", "protocolVersion": 1, "role": "device",
  "appVersion": "0.1.0", "label": "Pixel",
  "auth": { "deviceId": "…", "signature": "…", "challenge": "…" } }

// relay → device
{ "kind": "hello_ack", "protocolVersion": 1, "hostId": "…", "cipherRequired": true }
```

- `protocolVersion` 不匹配 → 关闭连接（close code 4000 + 原因文本），不静默降级。
- `auth` 的验证方式由 Relay 认证层定义（Ed25519 挑战-响应），失败同样 4001 拒绝。
- host 侧 hello 的 `role` 为 `"host"`，其余同构。

## 5. 方法与 topic 白名单（deny-by-default）

以 `packages/protocol/src/allowlist.ts` 为唯一真源，Gateway 与 Relay **双重校验**：

- 允许的方法：`sessions.list / get / context / contextPage / entryContent / executions / executionContent`、`agent.new`、`agent.command`（限定 type）、`files.list / meta / read / preview`、`system.runningCount`。
- 允许的 `agent.command` type：`prompt / steer / follow_up / abort / get_state / clear_queue / set_model / set_thinking_level / extension_ui_response / extension_ui_input / compact`。
- 允许的订阅 topic：`agent.events`、`agent.running`、`sessions.changed`、`files.changed`、`remote.approval`。
- 明确拒绝：`sessions.delete / rename / export`、`files.download`、`mcp.oauth.*`、`channelSecrets.*`、`channels.*`、`herdr.*`、`managedProcesses.*`、`desktop.*`、`updates.*`、`auth.*`、`models.*`、`settings.*`、`browser.*`、`system.allowRoot`，以及一切未知方法。
- `agent.command` 的 params 必须形如 `{sessionId, command:{type,…}}` 且 `type` 在白名单内（`isAgentCommandPayloadAllowed`）。

## 6. 可靠性

| 机制 | 参数 | 行为 |
| --- | --- | --- |
| 心跳 | 15s ping，3 次未 pong 判离线 | 双向；host 离线时 device 显示最后状态，不排队写操作 |
| 幂等 | 5 分钟滑动窗口 | Relay 按 `request.id` 去重 |
| 有序 | 单调 `seq`（Gateway 注入 event 帧） | device 乱序丢弃，缺口请求补发 |
| 补发 | 缓冲 512 条 / 2 MiB | 超限或缺口过大 → device 重新 `sessions.get` 全量对齐 |
| 重连 | 指数退避 + jitter | 重连帧带 `lastSeq`；**上线后先补推挂起审批** |
| 渲染节流 | 20 Hz | 与桌面 `SessionEventBatcher` 对齐 |

## 7. 审批镜像 topic：`remote.approval`

- `data` 为 `ApprovalRequestData`：`{requestId, sessionId, method: confirm|select|input|editor, title, message?, options?, prefill?, placeholder?, expiresAt?, createdAt}`。
- `expiresAt` **仅在扩展自带 timeout 时存在**——这类确认 Host 会到点以默认值（拒绝）结束，Gateway 不拦；无 `expiresAt` 的确认无限挂起，直到手机响应或 abort。
- device 回 `ApprovalResponseData`：`{requestId, action: "respond"|"cancel", response?}`，Gateway 转成 `extension_ui_response` 按 id 回收（幂等）。
- 挂起记录持久化在 **PC 侧**（Relay 不存）；撤销设备或关闭 PC 总开关时批量 abort，回默认值（拒绝）。

## 8. 关闭码

| code | 含义 |
| --- | --- |
| 4000 | 协议版本不匹配 |
| 4001 | 认证失败 |
| 4002 | 白名单拒绝（方法/topic/订阅 key） |
| 4003 | 重放/时间窗校验失败 |
| 4004 | 背压超限 |
| 1000/1001 | 正常关闭 / 服务端下线 |

## 9. E2EE（X25519 + AES-GCM）

- 每台设备与 host 独立配对、独立会话密钥；配对完成后经加密信道完成 X25519 交换。
- `cipher.keyId` 标识当前会话密钥；密钥轮换产生新 keyId，旧 keyId 立即失效。
- AES-256-GCM，IV 96-bit 随机且永不复用；`tag` 单独传输。
- Relay 全程只见密文；审计只记元数据 + HMAC 摘要。
- 私钥丢失不恢复历史密文；历史按需重新拉取并走同一加密通道。
