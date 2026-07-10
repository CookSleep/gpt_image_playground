# 极简图片生成站

基于 `CookSleep/gpt_image_playground` 改造的一个小型图片生成站。

目标很简单：只做图片生成，不做聊天、Agent、知识库、插件市场或大而全 AI 平台。

## 功能

- 中文界面
- 使用 sub2api 账号登录、退出
- 读取用户在 sub2api 中已创建的 API Key
- 用户手动选择 API Key 后生成图片
- 前端不展示 API Key 明文
- 登录用户生成图片、查看自己的历史记录和下载图片
- 账号、Key 分组、计费和额度由 sub2api 统一处理
- 后端统一通过 sub2api 的 OpenAI-compatible 网关生成图片
- 默认模型：`gpt-image-2`
- 图片存储使用 S3 兼容对象存储，例如 MinIO、Cloudflare R2
- 支持 Docker 部署和 nginx 反向代理

## 技术栈

- 前端：Vite + React + TypeScript
- 后端：Node.js + Fastify
- 数据库：PostgreSQL
- 对象存储：S3 compatible
- 部署：Docker Compose + nginx

## 本地开发

安装前端依赖：

```bash
npm install
```

安装后端依赖：

```bash
cd backend
npm install
```

如果暂时没有 PostgreSQL / MinIO，可以先用内存联调服务：

```bash
cd backend
npm run dev:memory
```

另开一个终端启动前端：

```bash
npm run dev -- --port 5178
```

访问：

```text
http://localhost:5178
```

内存联调账号：

```text
邮箱：任意邮箱
密码：任意非空密码
```

## Docker 本地联调

Docker Desktop 正常启动后执行：

```bash
docker compose -f docker-compose.local.yml up --build
```

访问：

```text
http://localhost:8088
```

本地 compose 会启动：

- frontend
- backend
- PostgreSQL
- MinIO
- mock sub2api / OpenAI-compatible API

## 服务器部署

复制环境变量模板：

```bash
cp .env.example .env
```

按实际服务器配置填写：

```env
DATABASE_URL=
SESSION_SECRET=
SUB2API_BASE_URL=http://host.docker.internal:8080
SUB2API_TIMEOUT_MS=30000
OPENAI_BASE_URL=
OPENAI_API_KEY=
DEFAULT_IMAGE_MODEL=gpt-image-2
S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=true
FRONTEND_PORT=8088
```

启动：

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

更详细的部署说明见：

[DEPLOYMENT.md](./DEPLOYMENT.md)

## 验证

```bash
npm run build
npm test

cd backend
npm test
```

当前已验证：

- 前端构建通过
- 前端测试通过
- 后端核心测试通过
- sub2api 登录、Key 脱敏列表、选择 Key 生图、历史、图片代理下载流程通过

## 说明

本项目是个人用途的极简改造版，保留原项目的图片生成基础能力，但产品方向已收敛为“接入 sub2api 账号体系的小型生图站”。

原项目地址：

```text
https://github.com/CookSleep/gpt_image_playground
```
