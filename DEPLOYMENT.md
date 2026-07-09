# 极简生图站部署说明

## 本地联调

如果 Docker Desktop Linux engine 已启动，直接执行：

```powershell
docker compose -f docker-compose.local.yml up --build
```

访问地址：

- 前端：http://localhost:8088
- 后端健康检查：http://localhost:3000/api/health
- MinIO 控制台：http://localhost:9001

本地默认管理员：

- 账号：`admin`
- 密码：`admin123456`

如果 Docker engine 暂不可用，可使用内存联调服务：

```powershell
cd D:\project\gpt-image-minimal-site\backend
npm run dev:memory

cd D:\project\gpt-image-minimal-site
npm run dev -- --port 5178
```

访问：http://localhost:5178

## 服务器部署

复制 `.env.example` 为 `.env`，填写真实环境变量：

```env
DATABASE_URL=postgres://user:password@postgres-host:5432/minimal_image_site
SESSION_SECRET=please-change-to-a-long-random-string
ADMIN_USERNAME=admin
ADMIN_PASSWORD=please-change-admin-password
OPENAI_BASE_URL=https://api.example.com/v1
OPENAI_API_KEY=sk-xxxx
DEFAULT_IMAGE_MODEL=gpt-image-2
S3_ENDPOINT=https://s3.example.com
S3_REGION=auto
S3_BUCKET=minimal-images
S3_ACCESS_KEY_ID=xxxx
S3_SECRET_ACCESS_KEY=xxxx
S3_FORCE_PATH_STYLE=true
FRONTEND_PORT=8088
```

启动：

```powershell
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

前置要求：

- PostgreSQL 数据库已创建，后端启动时会自动创建表。
- S3 兼容对象存储 bucket 已创建，建议私有桶。
- nginx 对外反代到 `frontend` 暴露端口，`/api/` 已由前端容器内部 nginx 转发到后端。

## 外层 nginx 示例

```nginx
server {
    listen 80;
    server_name image.example.com;

    client_max_body_size 80m;

    location / {
        proxy_pass http://127.0.0.1:8088;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
```

## 验证清单

- 注册账号后状态为待审核、额度为 0。
- 管理员登录后可以启用用户、禁用用户、调整额度。
- 启用且有额度的用户可以生成图片。
- 生成成功后扣 1 次额度，失败不扣。
- 用户只能看到自己的历史图片。
- 前端页面不出现上游 API Key 配置入口。
