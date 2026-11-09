# 自建 Relay 服务器部署教程

> 本教程面向想把手机远程控制跑在自家云服务器上的用户：从一台全新 VPS 开始，到手机配对成功、
> （可选）配好 TLS 加密传输，全流程走一遍。
> 维护者自己那台服务器的运维速记（含内部 IP / ssh 别名）在 [relay-deploy.md](relay-deploy.md)，与本文互不重复。
>
> 相关阅读：[remote-features.md](remote-features.md) —— 远程控制的整体架构与安全模型。

## 工作原理（30 秒版）

```
手机 App ──E2EE──▶ 云 Relay ──E2EE──▶ 桌面端（Windows）
                  只见密文信封，
                  按 hostId/deviceId 转发，
                  无法解读任何消息内容
```

- Relay 是**零知识中继**：只转发端到端加密（E2EE）信封，服务器上不落任何明文。
- 手机首次连接需要**配对**（Step 1）：桌面端出二维码 → 手机扫码 → 服务器签发设备凭证。
- 凭证签发后持久保存在服务器 `relay-pairings.json`（`RELAY_STATE_PATH` 指定的文件），
  之后重连免扫码。
- 默认配置 fail-closed：强制 E2EE（`RELAY_CIPHER_REQUIRED=true`）+ 强制配对
  （`RELAY_PAIRING_REQUIRED=true`），并带防重放窗口与设备级限流。

## 前置条件

| 项目 | 要求 |
|---|---|
| 服务器 | 任意 1 核 1G 以上的云 VPS（Relay 只做转发，资源占用极低，内存上限 300M 足够） |
| 操作系统 | 任意 Linux 发行版（下文以 Ubuntu/Debian 为例） |
| Node.js | **22.19 或更高**（`ws` 依赖与打包目标均为 node22；`node -v` 确认） |
| 进程守护 | pm2（推荐）或 systemd，二选一 |
| 网络 | 一个公网 IP；建议再准备一个域名（用于 TLS，见第 5 步） |

## 第 1 步：获取 Relay 单文件

Relay 是**单文件发布**（约 150KB，已内联 `ws` 依赖），服务器上**不需要仓库、不需要 npm install**。两种获取方式：

**方式 A：直接从 GitHub Release 下载（推荐）**

每次打 `v*` tag 发版，CI 都会发布 `pi-relay-<版本号>.mjs`：

```bash
# 到 https://github.com/ZhengHaoF/pi-desktop/releases 找最新版本的资产名，
# 或用 gh / curl 拉取，例如：
curl -fLO "https://github.com/ZhengHaoF/pi-desktop/releases/download/v0.5.1/pi-relay-v0.5.1.mjs"
```

> 注意核对 Release 页面上实际的文件名（格式为 `pi-relay-<version>.mjs`），
> 并替换上例中的版本号。

**方式 B：从源码自行构建**

```bash
git clone https://github.com/ZhengHaoF/pi-desktop.git
cd pi-desktop
npm ci
node scripts/build-relay.mjs    # → out/relay/relay.mjs
```

然后把它传到服务器：

```bash
ssh <你的服务器> "mkdir -p ~/pi-relay/data"
scp pi-relay-<version>.mjs <你的服务器>:~/pi-relay/relay.mjs
```

## 第 2 步：安装 Node 22 与 pm2

以 Ubuntu/Debian 为例（其他发行版替换包管理命令即可）：

```bash
# Node 22（NodeSource 源）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# pm2
sudo npm install -g pm2
node -v    # 应输出 v22.x
```

## 第 3 步：用 pm2 启动

写入 `~/pi-relay/ecosystem.config.cjs`：

```js
module.exports = {
  apps: [{
    name: "pi-relay",
    script: "/home/<你的用户名>/pi-relay/relay.mjs",   // 改成实际路径
    env: {
      RELAY_PORT: "8788",
      // 配对凭证持久化：不设此项则服务器重启后需重新扫码配对
      RELAY_STATE_PATH: "/home/<你的用户名>/pi-relay/data/relay-pairings.json",
    },
    max_memory_restart: "300M",
    time: true,
  }],
};
```

启动并设置开机自启：

```bash
pm2 start ~/pi-relay/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u <你的用户名> --hp /home/<你的用户名>   # 按输出执行一次 sudo 命令
```

> **不想用 pm2？** systemd 同样可以，一个最小单元：
>
> ```ini
> # /etc/systemd/system/pi-relay.service
> [Unit]
> Description=Pi Desktop Relay
> After=network.target
>
> [Service]
> ExecStart=/usr/bin/node /home/you/pi-relay/relay.mjs
> Environment=RELAY_PORT=8788
> Environment=RELAY_STATE_PATH=/home/you/pi-relay/data/relay-pairings.json
> Restart=always
> User=you
>
> [Install]
> WantedBy=multi-user.target
> ```
>
> `sudo systemctl enable --now pi-relay`

### 可用环境变量（全部有安全默认值，通常无需改动）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RELAY_PORT` | `8788` | HTTP 健康检查 + WebSocket 监听端口 |
| `RELAY_STATE_PATH` | （不设） | 配对凭证持久化 JSON 路径；**生产建议设置**，否则重启后需重新扫码 |
| `RELAY_CIPHER_REQUIRED` | `true` | 拒绝明文信封。改 `false` 仅限本机诊断，且须同时设 `RELAY_ALLOW_PLAINTEXT_PUBLIC=diagnostic`，否则进程启动即报错退出 |
| `RELAY_PAIRING_REQUIRED` | `true` | 拒绝未完成配对的设备（同上，关闭需 diagnostic 门禁） |
| `RELAY_REPLAY_WINDOW_MS` | `120000` | 信封时间戳防重放窗口 |
| `RELAY_RATE_LIMIT_MAX` / `RELAY_RATE_LIMIT_WINDOW_MS` | `240` / `60000` | 每设备令牌桶限流 |
| `RELAY_PAIRING_TTL_MS` | `600000` | 配对二维码有效期 |
| `RELAY_PAIRING_MAX_ATTEMPTS` | `5` | 配对令牌最大失败尝试次数 |

## 第 4 步：放行端口（两个地方都要）

这是**最常见的连不上原因**——防火墙和云厂商安全组是两层独立的门：

```bash
# 1) 系统防火墙
sudo ufw allow 8788/tcp    # 没有 ufw 可跳过
```

2) **云控制台安全组**：到腾讯云 / 阿里云 / AWS 等控制台，在实例的安全组 / 防火墙规则里
   放行入站 TCP 8788。这一步 CLI 做不了，必须在网页控制台操作。

## 第 5 步（强烈建议）：配置 TLS → wss://

裸 `ws://` 是明文传输层。消息内容有 E2EE 保护，但重连握手中的 deviceSecret 有一瞬是明文过网的
（手机与服务器之间的链路层）。公网长期使用请务必套 TLS。

推荐用 Caddy（自动申请续期证书，配置最省事）：

```bash
sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`：

```
relay.example.com {
    reverse_proxy /ws  localhost:8788
    reverse_proxy      localhost:8788
}
```

```bash
sudo systemctl reload caddy
```

用 nginx 的话等价配置：

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;
    # ssl_certificate / ssl_certificate_key 照常配置（或用 certbot 申请）

    location / {
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket 升级必需
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;                     # 长连接别被掐断
    }
}
```

前置条件：域名 A 记录已指到这台服务器；80/443 在安全组与防火墙均已放行（Caddy 需 80 做 ACME 验证）。
配置完成后，客户端一律填 `wss://relay.example.com/ws`，8788 端口可以只对内开放（127.0.0.1）。

## 第 6 步：验证

```bash
curl http://127.0.0.1:8788/healthz
# {"ok":true,"hosts":0,"devices":0,"cipherRequired":true}
```

`cipherRequired:true` 确认强制 E2EE 生效。再从任意一台外网机器确认公网可达：

```bash
curl -m 8 http://<你的服务器IP>:8788/healthz       # 未配 TLS 时
curl -m 8 https://relay.example.com/healthz        # 已配 TLS 时（Caddy/nginx 会转发）
```

## 第 7 步：客户端接入

1. **桌面端**（Windows）：设置 → 消息渠道 → 自建托管 → 打开远程控制 → 切到
   **「自定义 Relay（VPS 等）」** → 填入完整地址：
   - 未配 TLS：`ws://<服务器IP>:8788/ws`
   - 已配 TLS：`wss://relay.example.com/ws`
   - 点「Apply URL」保存。
2. **生成配对二维码**：桌面端设置卡片上点「Show QR」。
3. **手机扫码**：手机 App 扫码完成配对（公网 relay 强制配对）。凭证签发后持久在服务器
   `relay-pairings.json`，之后重连免扫码。
4. 完成。手机此时应显示已连接，可在公司 / 地铁用 4G/5G 直连你的云 Relay。

> 换了服务器或删了 `relay-pairings.json`，旧凭证即失效：重新扫一次码即可。

## 升级版本

```bash
# 下载（或构建）新版单文件后：
scp pi-relay-<新版本>.mjs <你的服务器>:~/pi-relay/relay.mjs
ssh <你的服务器> "pm2 restart pi-relay"
curl http://127.0.0.1:8788/healthz   # 确认起来
```

## 故障排查

| 现象 | 排查顺序 |
|---|---|
| 手机一直"连接中" | ① 本机 `curl http://127.0.0.1:8788/healthz` 通不通 → 不通看 pm2 日志 `pm2 logs pi-relay`；② 通但外网不通 → 安全组没放行（第 4 步第 2 项）；③ 都通 → 检查桌面端填的 URL 是否漏了 `/ws` 路径、`ws`/`wss` 是否与实际 TLS 情况一致 |
| `pm2 start` 立即退出 | 看 `pm2 logs pi-relay` 里的配置报错：最常见是端口被占（换 `RELAY_PORT`）或误设了 `RELAY_CIPHER_REQUIRED=false` 却没设 `RELAY_ALLOW_PLAINTEXT_PUBLIC=diagnostic`（fail-closed 校验会直接抛错） |
| 扫码总失败 | 配对二维码 10 分钟过期（`RELAY_PAIRING_TTL_MS`），重新生成再扫；连错服务器也会失败——确认桌面端 URL 和手机扫的是同一个 relay |
| 服务器重启后要重新扫码 | 没设 `RELAY_STATE_PATH`，凭证只存在内存里。按第 3 步补上并重启 |
| 通过 nginx/Caddy 走 wss 断连 | 检查反代是否带 `proxy_set_header Upgrade/Connection`（WebSocket 升级必需）以及 `proxy_read_timeout` 是否过短 |
| curl healthz 返回 404 | 路径写错，只有 `/healthz` 一个 HTTP 端点 |

## 已知限制

- 服务器重启后，**在线状态**是内存态（主机目录需 host 重新上线后恢复）；配对凭证有
  `RELAY_STATE_PATH` 则不受影响。
- 限流参数是单机进程内的令牌桶，多实例部署（一般不需要）不共享计数。
