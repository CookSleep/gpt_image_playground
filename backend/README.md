# GPT Image Playground 后端（OIDC 账号体系）

后端提供 **OIDC 登录、在线项目持久化和图片生成**。OpenAI Images 请求由项目 generation 接口生成并落库；Agent 使用独立的 Responses 代理；Composite 使用独立的 `/api/v1/model/*` 代理，前端分别提交任务、查询状态和获取结果。

后端生图相关请求访问的上游如下：

| 上游配置组 | 包含的接口 | 固定路径 |
|---|---|---|
| `upstreams.image_api` | 文生图、图片编辑、Agent/Responses 生图、图片状态恢复 | `POST /v1/images/generations`<br>`POST /v1/images/edits`<br>`POST /v1/responses`<br>`GET /v1/images/status/` |
| `upstreams.resource_api` | API Key 列表、模型列表 | `GET /oidc/resource/api-keys`<br>`GET /v1/models` |
| `upstreams.composite_api` | Composite 生图/编辑 | `GET/POST /api/v1/model/{slug}` |
| `upstreams.file_api` | Composite 参考图上传、删除 | `POST/DELETE /api/v1/file/` |
| `inner_api_rpc` | 素材库与余额 | `inner_api_rpc.target`（trpc over TCP） |

除 OIDC 登录 discovery 外，上述 HTTP 上游默认使用当前 OIDC provider 的 `issuer_url`。可在 `config.yaml` 的 `upstreams` 段为每组接口配置 `base_url`；接口路径固定，不支持配置覆盖。也可在 provider 上设置 `resource_base_url` 覆盖资源上游基址。地址支持 `https://domain.example`、`http://10.0.0.5:8080`，以及直接填写 `10.0.0.5:8080`（按 HTTP 处理）。

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
| POST | `/auth/oidc/refresh` | 用 OIDC refresh token 刷新 OIDC access token |
| POST | `/auth/oidc/sync` | 使用当前 OIDC access token 重新读取 UserInfo 并回填本地 claims |
| GET  | `/api/v1/me` | 占位示例，演示登录后的 API 访问 |
| GET  | `/api/v1/api-keys` | 后台代理当前 OIDC 用户的可用 API Key 列表 |
| GET  | `/api/v1/balance` | 后台根据当前用户的 `account_id` 通过 Inner API 获取账户余额 |
| GET  | `/api/v1/models?scope=image\|agent` | 后台读取所选 API Key 的模型，并按对应场景白名单过滤 |
| GET/POST | `/api/v1/projects` | 查询或保存在线项目 |
| GET/PATCH/DELETE | `/api/v1/projects/:id` | 读取、重命名或删除在线项目 |
| PUT/DELETE | `/api/v1/projects/:id/tasks/:taskId` | 异步保存或删除单条生成记录，无需重新上传项目 ZIP |
| GET/POST | `/api/v1/projects/:id/images` | 查询或保存项目图片 |
| GET/DELETE | `/api/v1/projects/:id/images/:imageId` | 读取或删除项目图片 |
| POST/DELETE | `/api/v1/files` | 上传或删除 Composite 参考图，后台代理上游 File API |
| POST | `/api/v1/materials` | 上传素材库图片，后台通过 Inner API RPC 返回 `file_url` |
| POST | `/api/v1/materials/batch-delete` | 批量删除素材，JSON `ids` 最多 100 个，后台调用 `BatchDeleteMaterials` RPC |
| POST | `/api/v1/model/:slug`（支持多段 slug） | 向 Composite 上游提交异步任务 |
| GET | `/api/v1/model/:slug/requests/:requestId` | 轮询 Composite 异步任务状态和结果 |
| POST | `/api/v1/projects/:id/generations` | 由后端调用 Images 或 Responses API 生成图片，图片落库后返回 |
| POST | `/api/v1/projects/:id/edits` | 由后端调用 Images Edits 或 Responses API 编辑图片，图片落库后返回 |
| POST | `/api/v1/agent/responses` | 后台代理 Agent 的完整 Responses API 请求，支持 JSON 与 SSE 流式响应 |

生图请求中的 API Key 仅用于本次上游请求，不会写入数据库。上游基址由服务端 `upstreams.*.base_url` 或当前 JWT 绑定的 OIDC provider 资源地址决定，客户端不能指定任意地址。Composite 代理从 `X-Upstream-API-Key` 读取 Composite Key，并将其转换为上游 `Authorization: Bearer <key>`；代理只转发当前这一次请求，不在 generation 接口中提交或轮询。前端以 2 秒起始、最大 15 秒的指数退避轮询 `/requests/:requestId`，总超时 10 分钟；网络错误和 HTTP 5xx 最多重试 3 次，HTTP 4xx 直接报错。提交成功后前端会把 `request_id` 和 `status_url` 写入任务记录；页面刷新后会通过本地代理继续查询，完成响应中的图片会被保存。

Agent Responses 请求使用 `POST /api/v1/agent/responses`，请求 JSON 在顶层携带一次性 `api_key`，其余字段按 Responses API 原样传递（也兼容放在 `body` 或 `request` 字段中）。后台根据 `upstreams.image_api` 和当前 JWT 绑定的 OIDC provider 资源地址选择上游，不接受客户端指定 provider 或 URL，并原样透传上游 JSON/SSE 响应。

Composite 图片编辑会先把本地参考图和遮罩以 multipart 文件提交到 `/api/v1/files`。后台使用 `file_api.developer_key` 和 `upstreams.file_api` 代理到配置的 File API，密钥不会返回前端。前端会按 Composite API Key 的哈希把返回的 URL 缓存在本地图片记录中；同一 API Key 后续复用该图片时会直接提交 URL，不再重复上传。不同 API Key 之间不会共享缓存。为了保证缓存 URL 持续有效，前端不会在任务结束时自动删除 File API 文件；`DELETE /api/v1/files` 仍保留供显式清理使用。素材库中已有的远程 URL 也会直接复用。

素材库批量删除调用 `POST /api/v1/materials/batch-delete`，请求格式为 `{"ids":["opaque-id-1","opaque-id-2"]}`。单次最多 100 个 ID；前端选择超过 100 个素材时会自动分批请求。

后台配置文件需要加入：

```yaml
upstreams:
  image_api:
    base_url: "http://10.0.0.5:8080"
    codex_cli: false
  resource_api:
    base_url: ""
  composite_api:
    base_url: ""
  file_api:
    base_url: ""

inner_api_rpc:
  target: ip://10.0.0.5:9100
  app_token: "创建内部 API App 时获得的 token"
  timeout_seconds: 30

file_api:
  developer_key: "dev_完整开发者密钥"
  timeout_seconds: 600
```

对应的内部 API App 必须允许调用 `GetBalance`；使用素材库时还需授予 `materials:write` 权限。`inner_api_rpc` 未配置或当前用户没有 `account_id` 时，余额接口返回 `{"available":false}`，不会影响其它功能。`app_token` 与 `developer_key` 都只保存在后台配置中，不会返回前端。`developer_key` 必须填写创建时一次性展示的完整密钥，不能填写 `key_prefix`。

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
- `log.file` 日志落盘路径；留空时仅写 stdout。配置后同时写 stdout 和文件
- `log.level` 控制日志级别；`log.max_size_mb` / `max_backups` / `max_age_days` 控制日志轮转，默认 100 MB / 10 个备份 / 30 天，旧文件自动压缩
- 每个 HTTP 请求的访问日志和业务日志都包含相同的 `request_id`；前端生成 `X-Request-ID`，后端复用并转发给上游，同时通过响应头返回。没有该请求头时由后端生成
- `jwt.secret_key` **必须**设为长随机串，泄漏即代表所有 token 失效
- `jwt.expire_hours` access token 寿命，默认 24h
- `jwt.refresh_hours` refresh token 寿命，默认 168h（7 天）
- `model_whitelist.image` 生图模型白名单；后台只返回当前 API Key 可用模型与该列表的交集，留空全部放行
- `model_whitelist.agent` Agent 模型白名单；规则同上，留空全部放行
- `oidc.providers` OIDC 提供商列表，支持任意标准 OIDC discovery 协议
- `oidc.providers[].resource_base_url` 资源上游基址；为空时使用 `issuer_url`，支持域名、域名端口和 IP 端口
- `upstreams.image_api.base_url` Images/Responses 生成、编辑和状态接口的上游基址；接口路径固定，见上方接口表
- `upstreams.image_api.codex_cli` 是否为 OpenAI 平台分组启用 Codex CLI 兼容模式；开启后通过 Images Generations/Edits 的 `n > 1` 请求由后端并发拆成多个单图请求，同时不向上游发送 `n` 和 `quality`。Responses 接口始终只请求一次
- `upstreams.resource_api.base_url` API Key 列表和模型列表的上游基址；接口路径固定，见上方接口表
- `upstreams.composite_api.base_url` Composite 模型代理的上游基址；接口路径固定，见上方接口表
- `upstreams.file_api.base_url` Composite File API 的上游基址；接口路径固定，见上方接口表

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
# 修改 config.yaml，将 log.file 设为 /app/logs/backend.log 后启动
docker compose up -d
```

Compose 会把容器内 `/app/logs` 挂载到当前目录的 `logs/`。日志落盘启用后仍会同步写 stdout，因此 `docker compose logs backend` 继续可用。

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
