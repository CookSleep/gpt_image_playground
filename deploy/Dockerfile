# syntax=docker/dockerfile:1

# ---- Stage 1: 构建前端 ----
# 不再注入占位符 env：运行时配置由 Go 后端在返回 index.html 时注入 window.__APP_CONFIG__。
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Stage 2: 编译后端并嵌入前端产物 ----
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS backend

WORKDIR /src
# 先拉依赖，利用层缓存
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# 后端源码 + 前端产物（go:embed 只能嵌入模块目录内文件，故拷入 internal/web/dist）
COPY backend/ ./
COPY --from=frontend /app/dist ./internal/web/dist

ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -tags embed -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# ---- Stage 3: 运行时（单二进制）----
FROM alpine:3.20

RUN apk add --no-cache ca-certificates 
WORKDIR /app
COPY --from=backend /out/server /app/server

# 监听端口（config 默认 8080）
EXPOSE 8080

# 运行时仍需外挂配置与外部 PostgreSQL：
#   - 挂载 config.yaml 到 /app/config.yaml 或 /app/config/config.yaml，或设置 BACKEND_CONFIG_PATH
#   - 前端运行时配置通过环境变量注入：DEFAULT_API_URL / SHOW_DEFAULT_CONFIG_ONLY /
#     DOCKER_DEPLOYMENT / DOCKER_LEGACY_API_URL_USED / AUTH_BACKEND_URL
#     （API_PROXY_AVAILABLE / API_PROXY_LOCKED 在单镜像形态恒为 false，不提供同源代理）
ENTRYPOINT ["/app/server"]
