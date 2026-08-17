# GPT Image Playground 后端（OIDC 账号体系）

后端提供 **OIDC 登录、在线项目持久化和图片生成**。在线项目使用 OIDC 选择的 API Key 时，前端只请求本后端，由后端调用受信任 provider 的 Images 或 Responses API，并在返回图片前写入数据库。

- 框架：Gin + zerolog
- 数据库：PostgreSQL
- 认证：OIDC Authorization Code + PKCE → JWT (access + refresh)
- 配置：YAML（不再使用环境变量）

---

## 目录结构

```
backend/
├── cmd/server/              # 入口
├── config/                  # 配置示例（真实 config.yaml 不入库）
├── internal/
│   ├── auth/                # OIDC 提供商注册、PKCE、State store
│   ├── database/            # PG 连接 + 迁移 + UserRepository
│   ├── handlers/            # auth_handler, health_handler
│   ├── middleware/          # auth, error_handler
│   ├── models/              # User
│   └── services/            # AuthService 组装上层用例
├── pkg/
│   ├── config/              # YAML 加载与默认值
│   └── jwt/                 # 签发/校验/刷新
└── deploy/                  # Dockerfile / nginx / systemd / providers 模板
```

## 快速开始（本地）

1. 安装 Go 1.22+ 与 Postgres 16+
2. 创建数据库：`createdb gpt_image_playground`
3. 准备配置：
   ```bash
   cp config/config.yaml.example config/config.yaml
   # 至少修改 jwt.secret_key、database.password、oidc.providers
   ```
4. 启动：
   ```bash
   go run ./cmd/server -config config/config.yaml
   ```

启动时会自动执行 `internal/database/migrations/*.up.sql`。

---

## API 端点

### 公开接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/health` | 进程存活检查（永远 200） |
| GET  | `/health/ready` | 就绪检查（含数据库 ping） |
| GET  | `/auth/providers` | 列出可用的 OIDC 提供商 |
| GET  | `/auth/login/:provider` | 重定向到 OIDC 授权地址（PKCE+state） |
| GET  | `/auth/callback/:provider` | OIDC 回调，成功后 302 到前端 `frontend_url`，token 通过 hash 传递 |
| POST | `/auth/refresh` | 用 refresh token 换新的 access/refresh，body: `{"refresh_token":"..."}` |

### 受保护接口（需 `Authorization: Bearer <access_token>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/auth/user` | 当前登录用户的公开资料 |
| POST | `/auth/logout` | 第一期 JWT 无状态，仅 204 |
| GET  | `/api/v1/me` | 占位示例，演示登录后的 API 访问 |
| GET/POST | `/api/v1/projects` | 查询或保存在线项目 |
| GET/PATCH/DELETE | `/api/v1/projects/:id` | 读取、重命名或删除在线项目 |
| GET/POST | `/api/v1/projects/:id/images` | 查询或保存项目图片 |
| GET/DELETE | `/api/v1/projects/:id/images/:imageId` | 读取或删除项目图片 |
| POST | `/api/v1/projects/:id/generations` | 由后端调用 Images 或 Responses API 生成图片，图片落库后返回 |
| POST | `/api/v1/projects/:id/edits` | 由后端调用 Images Edits 或 Responses API 编辑图片，图片落库后返回 |

生图请求中的 API Key 仅用于本次上游请求，不会写入数据库。上游基址由当前 JWT 的 OIDC provider 配置决定，客户端不能指定任意地址。

### 回调 token 传递格式

后端在 `/auth/callback/:provider` 成功后会 302 到：

```
{server.frontend_url}/#access_token=...&refresh_token=...&token_type=Bearer
```

前端启动时调用 `consumeAuthHash()` 即可把 token 取出并存到 `localStorage`，然后清掉 URL hash。

---

## 配置说明（config.yaml）

最小可用配置见 [config/config.yaml.example](./config/config.yaml.example)。

### 关键字段

- `server.base_url` 后端对外基础地址（OIDC 回调拼接用）
- `server.frontend_url` 登录完成后回跳的前端地址
- `server.cors_origins` 允许跨域的前端来源；同源部署可留空
- `jwt.secret_key` **必须**设为长随机串，泄漏即代表所有 token 失效
- `jwt.expire_hours` access token 寿命，默认 24h
- `jwt.refresh_hours` refresh token 寿命，默认 168h（7 天）
- `oidc.providers` OIDC 提供商列表，支持任意标准 OIDC discovery 协议

### 添加 OIDC 提供商

1. 在 OIDC 提供商管理页注册一个 Web 应用，把 redirect URI 设为：
   `{server.base_url}/auth/callback/{provider.name}`
2. 拿到 `client_id` / `client_secret` / `issuer_url`
3. 复制 [`deploy/oidc-providers.example.yaml`](./deploy/oidc-providers.example.yaml) 中对应模板，填入 `oidc.providers`
4. 重启后端

---

## 部署

### 方案 A：二进制 + systemd + nginx（推荐）

1. 构建：
   ```bash
   CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o server ./cmd/server
   ```
2. 部署到 `/opt/gpt-image-backend/`：
   ```
   /opt/gpt-image-backend/
   ├── server
   └── config/config.yaml
   ```
3. 安装 systemd unit：复制 [`deploy/gpt-image-backend.service`](./deploy/gpt-image-backend.service) 到 `/etc/systemd/system/`，`systemctl enable --now gpt-image-backend`
4. nginx 配置：使用 [`deploy/nginx.conf`](./deploy/nginx.conf)（前后端同源）

### 方案 B：Docker Compose

```bash
cd backend/deploy
cp ../config/config.yaml.example config.yaml
# 修改 config.yaml 后启动
docker compose up -d
```

### 前端构建

需要为前端注入认证后端地址：

- **同源部署**（推荐）：`VITE_AUTH_BACKEND_URL=""`
- **跨域开发**：`VITE_AUTH_BACKEND_URL="http://localhost:8080"`
- **禁用认证**（兼容纯静态部署）：`VITE_AUTH_BACKEND_URL="disabled"` 或不设置

---

## 测试

```bash
go test ./...           # 全部
go test ./pkg/jwt -v    # 单包
```

包含：
- `pkg/jwt` JWT 签发/校验/refresh/过期
- `internal/auth` PKCE/State store
- `internal/middleware` AuthMiddleware 的 4 个分支
- `internal/services` OIDC 端到端集成（mock IdP + 完整流程）

---

## 故障排查

### 启动失败

| 现象 | 排查 |
|---|---|
| `config file not found` | 检查 `-config` 参数或 `BACKEND_CONFIG_PATH` 环境变量 |
| `jwt.secret_key is required` | config 缺关键字段，参考 example |
| `database.host/name/user are required` | 同上 |
| `init oidc provider xxx: oidc discovery: ...` | 检查 issuer_url 可达，且返回了合法的 `/.well-known/openid-configuration` |
| `pq: SSL is required` | 把 `database.ssl_mode` 改为 `require` 或 `disable`（按对端要求） |

### 登录失败

| 现象 | 可能原因 |
|---|---|
| 前端登录页空白 | 后端 `/auth/providers` 返回了空数组，检查 `oidc.providers` 是否配置 |
| 提供商页面报 `redirect_uri_mismatch` | OIDC 提供商注册的 redirect URI 与 config 不一致 |
| 回调 401 `invalid or expired state` | state 暂存只存 10 分钟；或后端重启清空了内存 store |
| 回调 401 `verify id_token: ...` | client_id / issuer 不匹配 |
| 前端拿到 token 但 `/auth/user` 401 | 检查浏览器是否实际带了 `Authorization` 头；同源部署需通过 nginx 转发 |

### Token 行为

- access token 默认 24h 过期；前端通过 `authFetch` 在 401 时自动用 refresh token 续期
- refresh token 不能用作 access（会被中间件 401）
- 第一期 **不维护黑名单**：服务端无法立即吊销已签发的 access token；如果需要立即生效的吊销，等任务 4.5 接入

### 健康检查

- `/health` 永远 200，用于 LB liveness
- `/health/ready` 会 ping 数据库，DB 不通时返回 503，用于 LB readiness

---

## 许可证

与主仓库一致。
