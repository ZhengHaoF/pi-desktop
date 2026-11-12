# Relay VPS 部署指南（pm2）

> **面向用户的从零部署教程见 [relay-tutorial.md](relay-tutorial.md)**（含 Release 下载、systemd、TLS/wss 与故障排查）。
> 本文是维护者的运维速记，绑定当前实际部署的机器与环境。

> 以北京腾讯云 `82.156.168.149`（ssh 别名 `tencent-bj`，Ubuntu 26.04 / Node 22 / pm2 7）为例。
> 产物是单文件，服务器不需要仓库和 node_modules。
> CI 发布：打 `v*` tag 后 `release-mobile-relay` job 会把 `pi-relay-<version>.mjs` 与 APK 一起放进 draft release。

## GitHub Actions 发布 secrets（一次性配置）

打 tag 前先在 GitHub 仓库 → Settings → Secrets and variables → Actions 配置 4 个 secret：

| Secret | 值 | 说明 |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | `scratch/keystore/keystore.base64` 文件内容 | 发布 keystore（base64） |
| `ANDROID_KEYSTORE_PASSWORD` | `scratch/keystore/password.txt` 内容 | keystore 口令 |
| `ANDROID_KEY_ALIAS` | `pi-remote` | 别名固定 |
| `ANDROID_KEY_PASSWORD` | 同 `ANDROID_KEYSTORE_PASSWORD` | key 口令（与 store 相同） |

> ⚠️ `scratch/keystore/` 整个目录已被 gitignore（jks + password + base64），**务必自行另存备份**（密码管理器/离线盘）。keystore 丢失后无法为已发布应用续签名升级。
> 本地无这些 env 时，release 构建自动回退 debug 签名（`flutter run --release` 不受影响）。


## 产物

```bash
node scripts/build-relay.mjs   # → out/relay/relay.mjs（约 150KB，含 ws）
```

## 部署

```bash
ssh tencent-bj "mkdir -p ~/pi-relay/data"
scp out/relay/relay.mjs tencent-bj:~/pi-relay/relay.mjs
```

`~/pi-relay/ecosystem.config.cjs`：

```js
// pi-desktop remote-control relay (Step 1 pairing + Step 2 E2EE enforced).
// Defaults are fail-closed: RELAY_CIPHER_REQUIRED=true, RELAY_PAIRING_REQUIRED=true.
// Do NOT set RELAY_ALLOW_PLAINTEXT_PUBLIC on this box.
module.exports = {
  apps: [{
    name: "pi-relay",
    script: "/home/ubuntu/pi-relay/relay.mjs",
    env: {
      RELAY_PORT: "8788",
      RELAY_STATE_PATH: "/home/ubuntu/pi-relay/data/relay-pairings.json",
    },
    max_memory_restart: "300M",
    time: true,
  }],
};
```

```bash
pm2 start ~/pi-relay/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu   # 按输出执行一次 sudo 命令
```

## 端口与防火墙

- 默认 **8788**（8787/8443 被该机原有面板服务占用）
- ufw：`sudo ufw allow 8788/tcp`
- **腾讯云控制台安全组**：入站放行 TCP 8788（CLI 不可达，必须控制台操作）

## 验证

```bash
curl http://127.0.0.1:8788/healthz
# {"ok":true,"hosts":0,"devices":0,"cipherRequired":true}
curl -m 8 http://82.156.168.149:8788/healthz   # 从任意外网机器测
```

`cipherRequired:true` 确认强制 E2EE 生效；未设任何 `RELAY_ALLOW_PLAINTEXT_PUBLIC` 时配置为 fail-closed（config.ts 强制校验）。

## 排障日志（RELAY_DEBUG_LOG）

配对失败时（手机提示「配对失败…（pairing token rejected）」，或卡在 `pairing required`），先看这份 JSONL 日志：

```bash
# 桌面局域网 relay：默认已开启，文件在 app 的 userData 下
#   Windows: %APPDATA%\<app>\relay-debug.log
# VPS/自建 relay：显式指定路径才开启
export RELAY_DEBUG_LOG=/home/ubuntu/pi-relay/data/relay-debug.log
```

记录的是**判定结果**，不是内容：不含 token/secret 明文（只有 10 位 SHA-256 摘要，可用来把 `pair.create` 与 `device.hello` 对上），不含任何会话数据。

| event | 关键字段 | 用途 |
| --- | --- | --- |
| `relay.start` | `bindingsLoaded`, `statePath` | relay 启动时加载了几条绑定（0 = 状态文件不在/路径变了） |
| `host.hello` | `hostId`, `declaredHostId` | PC 的 gateway 实际用了哪个 hostId 上线 |
| `pair.create` | `hostId`, `tokenDigest` | 二维码里的 token 是谁签发的 |
| `device.hello` | `hasPairingToken`, `tokenVerdict`, `credentialVerdict`（`ok` / `no-binding` / `secret-mismatch`）, `bindingHostIds`, `onlineHostIds` | 一次失败的完整归因 |
| `hello.reject` | `code`, `reason` | 被拒的关闭码与原因 |
| `pair.unbind` / `pair.revoke` | `deviceId`, `hostId`, `removed`/`revoked` | 谁解绑/撤销了什么 |

判读速查：

- `tokenVerdict: "unknown pairing token"` → 这个 token 不是**当前这个 relay 进程**签发的（换过 relay、端口/机器不同，或 relay 重启过——待配对 token 只在内存里，只有设备绑定会落盘）。
- `tokenVerdict: "pairing consumed"` → 手机在重放一个已经用掉的一次性 token；同一个 `pairingTokenDigest` 能在 `pair.create` 里找到就是这种情况。
- `credentialVerdict: "no-binding"` + `bindingHostIds: []` → relay 侧没有这台设备的绑定（`statePath` 不对/被清）；`bindingHostIds` 里有别的 hostId → 手机寻址的 PC 身份变了（多 PC 或重装后 hostId 重新生成）。
- `credentialVerdict: "secret-mismatch"` → 绑定存在但凭证不对（手机端 `remote.deviceSecret.*` 与本 relay 的 secret 不是同一份）。
- `onlineHostIds: []` + `device.hello` 被拒 → 顺带说明 PC 的 gateway 根本没连上这个 relay，光修配对也拉不到数据。

日志写入是 best-effort：超过 4 MB 轮转成 `relay-debug.log.1`，任何 I/O 错误都会让它自我禁用，绝不影响 relay 服务。

## 客户端接入

1. 桌面：设置 → 消息渠道 → 自建托管 → 切「自定义 Relay」→ `ws://82.156.168.149:8788/ws`
2. 手机：桌面设置卡片生成**配对二维码**扫码（公网 relay 强制配对，凭证签发后持久在服务器 `relay-pairings.json`，重连免扫码）

## 升级

```bash
node scripts/build-relay.mjs && scp out/relay/relay.mjs tencent-bj:~/pi-relay/relay.mjs
ssh tencent-bj "pm2 restart pi-relay"
```

## 已知限制

- 传输层是 `ws://` 明文（消息内容有 E2EE 保护；重连 hello 的 deviceSecret 一瞬明文过网）。长期公网使用建议加域名 + nginx/Caddy 终结 TLS → `wss://`
- 服务器重启后主机目录（离线 host 记录）为内存态，需 host 重新上线后恢复
