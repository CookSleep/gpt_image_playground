<div align="center">

# 🎨 GPT Image Playground

[![GitHub Repo stars](https://img.shields.io/github/stars/CookSleep/gpt_image_playground?style=flat-square&color=eab308)](https://github.com/CookSleep/gpt_image_playground/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/CookSleep/gpt_image_playground?style=flat-square&color=3b82f6)](https://github.com/CookSleep/gpt_image_playground/network/members)
[![License](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)](https://github.com/CookSleep/gpt_image_playground/blob/main/LICENSE)
[![React](https://img.shields.io/badge/React-19-20232A?style=flat-square&logo=react&logoColor=61DAFB)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**基于 OpenAI gpt-image-2 API 的图片生成与编辑工具**

提供简洁精美的 Web UI，支持 OpenAI / OpenAI 兼容接口、fal.ai 与可导入的自定义 HTTP 服务商。<br>
支持文本生图、参考图与遮罩编辑，数据纯本地化存储，带来流畅的历史记录与参数管理体验。

<br>

[![Vercel 在线体验](https://img.shields.io/badge/Vercel-%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-black?style=for-the-badge&logo=vercel&logoColor=white)](https://gpt-image-playground.cooksleep.dev)
&nbsp;&nbsp;&nbsp;
[![GitHub Pages 在线体验](https://img.shields.io/badge/GitHub%20Pages-%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-222222?style=for-the-badge&logo=github&logoColor=white)](https://cooksleep.github.io/gpt_image_playground)

</div>

<br>

> 💡 **提示**：若需调用非 HTTPS 的内网或本地 HTTP API，请使用 GitHub Pages 版本或自行部署，Vercel 部署的体验版绑定的 `.dev` 域名因安全策略通常要求接口必须为 HTTPS。

---

## ❤️ 赞助商

<table>
<tr>
<td width="180" align="center" valign="middle">
  <a href="https://www.5cookie.cc"><img src="https://github.com/user-attachments/assets/c2a1e98e-c172-49ff-b361-60bb32601daa" alt="5Cookie Code" width="150"></a>
</td>
<td valign="middle"><b><a href="https://www.5cookie.cc">5Cookie Code</a></b>&nbsp;是一家稳定高速的 API 中继服务提供商，为 Image-2、Claude Code、Codex 等平台或模型提供 API 中继服务。面向个人、团队和企业用户提供 AI 编码服务和 AI 生图服务。</td>
</tr>
<tr>
<td width="180" align="center" valign="middle">
  <a href="https://9527code.com/"><img src="https://github.com/user-attachments/assets/29eba620-e902-42f9-9c3b-2fb2d7b2e310" alt="9527 CODE" width="150"></a>
</td>
<td valign="middle"><b><a href="https://9527code.com/">9527 CODE</a></b>&nbsp;是企业级满血 AI 中转服务平台，专注提供 Claude Code、Codex 等主流模型的高稳定中转能力，为企业级 AI 使用提供稳定、合规、高效的一站式解决方案。</td>
</tr>
<tr>
<td width="180" align="center" valign="middle">
  <a href="https://code0.ai/?source=cooksleep"><img src="https://github.com/user-attachments/assets/515dc874-3b2b-4355-aeae-04eba6e6505d" alt="Code0" width="150"></a>
</td>
<td valign="middle"><b><a href="https://code0.ai/?source=cooksleep">Code0</a></b>&nbsp;是一家稳定高速的 AI API 中转服务商，支持 gpt-image、Claude Code、Codex 等主流模型，提供即充即用的 AI 生图与编码能力，面向个人、团队与企业用户。<a href="https://gpt-image-playground.cooksleep.dev/?apiUrl=https%3A%2F%2Fcode0.ai%2Fv1&apiMode=images&profileName=Code0">点此导入配置</a></td>
</tr>
</table>

---

## 📸 界面预览

<details>
<summary><b>点击展开截图展示</b></summary>
<br>

<div align="center">
  <b>桌面端主界面</b><br>
  <img src="docs/images/example_pc_1.jpg" alt="桌面端主界面" />
</div>

<br>

<div align="center">
  <b>任务详情与实际参数</b><br>
  <img src="docs/images/example_pc_2.jpg" alt="任务详情与实际参数" />
</div>

<br>

<div align="center">
  <b>桌面端批量选择</b><br>
  <img src="docs/images/example_pc_3.jpg" alt="桌面端批量选择" />
</div>

<br>

<div align="center">
  <b>桌面端 Agent 模式</b><br>
  <img src="docs/images/example_pc_4.jpg" alt="桌面端 Agent 模式" />
</div>

<br>

<div align="center">
  <b>移动端主界面</b><br>
  <img src="docs/images/example_mb_1.jpg" alt="移动端主界面" width="420" />
</div>

<br>

<div align="center">
  <b>移动端侧滑多选</b><br>
  <img src="docs/images/example_mb_2.jpg" alt="移动端侧滑多选" width="420" />
</div>

</details>

---

## ✨ 核心特性

### 🎨 强大的图像生成与编辑
- **参考图与遮罩**：支持上传最多 16 张参考图（支持剪贴板和拖拽）。内置可视化遮罩编辑器，自动预处理以符合官方分辨率限制。
- **批量与迭代**：支持单次多图生成；一键将满意结果转为参考图，无缝开启下一轮修改。
- **流式生成预览**：`Images API` 与 `Responses API` 模式均支持流式接收中间步骤图像，缓解连接超时问题。
- **透明背景后处理**：画廊模式下选择 PNG 格式后可开启透明背景功能，自动在提示词末尾追加工作流说明，要求模型使用纯绿色或纯洋红色背景，并在结果返回后本地去除原图中的背景色，保存为带透明通道的 PNG。

  > 透明背景后处理功能为本地后处理流程，适用于图标、贴纸、单主体素材等场景，并非 API 原生透明通道（GPT-Image-2 不支持）。若主体边缘存在复杂发丝、半透明材质、强反光或与背景色接近的颜色，可能出现边缘残留或误抠。

### 🤖 Agent 多轮对话模式
- **多轮对话与上下文记忆**：基于 Responses API 的对话式生成，Agent 会理解上下文并按需调用图像工具；支持 `@` 引用参考图或前面轮次生成的图片，并自动识别上下文中的图片。
- **并发批量生成**：内置 `generate_image_batch` 工具，让 Agent 在一次轮次中并发生成多张关联图像，并通过 `continue_generation` 自动追加新一轮以处理依赖关系。
- **分支与重新生成**：编辑某轮消息重新发送或重新生成某轮消息会产生可切换的分支，引用解析严格限定在当前分支路径内，避免误用其他分支的图片。
- **画廊同步与隔离删除**：Agent 生成的图片会同步到画廊；删除对话默认保留画廊记录，删除画廊任务时也会自动清理对话中残留的图片引用。
- **可选 Web 搜索**：可开启 `web_search` 工具，Agent 会在需要时搜索网络信息并附带引用链接。

### ⚙️ 精细化参数追踪
- **智能尺寸控制**：提供 1K/2K/4K 快速预设，自定义宽高时会自动规整至模型安全范围（16 的倍数、总像素校验等）。
- **实际参数对比**：自动提取 API 响应中真实生效的尺寸、质量、耗时以及**模型改写后的提示词**，与你的请求参数高亮对比。支持定制化的参数列表横向平滑滚动体验。

### 📁 高效历史管理 (纯本地)
- **瀑布流与画廊**：历史任务自动保存，支持按状态过滤、全屏大图预览与快捷下载。
- **多收藏夹管理**：支持创建多个命名收藏夹，同一任务可归入多个收藏夹。提供独立的收藏夹概览视图（展示封面缩略图与任务数量），点击进入具体收藏夹后仍可叠加搜索与状态筛选。收藏夹支持拖拽排序、重命名、设置默认收藏夹，以及按收藏夹为单位批量打包下载 ZIP。
- **快捷批量操作**：桌面端支持鼠标拖拽框选、Ctrl/⌘ 连选，移动端支持顺滑侧滑多选；轻松实现批量收藏与清理。
- **优化的图片查看与下载**：大图预览支持左右滑动切换、移动端长按弹出操作菜单，支持快捷下载与批量下载。
- **极致性能与隐私**：所有记录与图片均存放在浏览器 IndexedDB 中（采用 SHA-256 去重压缩），不经过任何第三方服务器。支持一键打包导出 ZIP 备份。

### 🔌 多配置与服务商增强
- **多配置管理**：支持创建并保存多个 API 配置（包含服务商、API Key、模型等），按需快速切换；支持一键复制当前配置到列表底部，并通过拖拽对配置列表与服务商列表进行自定义排序。
- **多服务商接入**：内置 OpenAI 兼容接口（含 `Images API` 和 `Responses API`）、fal.ai（支持队列），并支持通过 JSON 导入自定义 HTTP 服务商配置（兼容同步/异步任务）。
- **API 代理**：OpenAI 兼容接口与 fal.ai 均可配置自定义代理。其中 OpenAI 兼容接口可开启同源 `/api-proxy/` 代理，交由 Docker 或本地开发环境转发至真实 API，绕开浏览器 CORS 限制。
- **Codex CLI 兼容模式**：对上游为 Codex CLI 的 API，开启后应用 Codex CLI 实际支持的参数，并将多图生成拆分为并发单图。
- **提示词防改写**：Responses API 会始终在请求文本前加入强制指令防止提示词被改写；开启 Codex CLI 模式后，Images API 也会获得同等保护。
- **智能诊断提示**：当检测到接口异常改写行为或缺少常规参数时，自动提示开启相应的兼容模式。
- **习惯配置**：支持设置提交后清空输入、重启后保留历史输入、临时复用历史任务 API 配置等。

---

## 🚀 部署与使用

支持多种部署与开发方式。无论使用哪种方式，你都可以预设默认的 API 节点。

<details>
<summary><strong>▲ 方式一：Vercel 一键部署 (推荐)</strong></summary>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FCookSleep%2Fgpt_image_playground&project-name=gpt-image-playground&repository-name=gpt-image-playground)

点击上方按钮导入仓库即可，Vercel 会自动执行构建并部署静态文件。

**配置默认 API URL**：在 Vercel 项目的 **Settings → Environment Variables** 中添加 `VITE_DEFAULT_API_URL`（如 `https://api.openai.com/v1`），然后重新部署即可生效。

**导入自定义服务商配置**：`VITE_DEFAULT_API_URL` 除了填写普通 API 地址外，也支持直接填写 `.json` 配置 URL 或带 `settings` 参数的分享 URL。设为配置 URL 时，页面启动后会自动导入其中的自定义服务商和 API 配置，设置页显示的是配置 JSON 中 profile 定义的 `baseUrl`（而非配置 URL 本身）。

**仅展示默认配置**：设置 `VITE_SHOW_DEFAULT_CONFIG_ONLY=true` 后，如果已配置默认 API URL 或默认代理，前端会禁用“当前配置”和“服务商类型”的下拉切换，只允许使用默认配置和默认服务商类型。通过页面 URL 参数传入的配置只会覆盖当前配置字段，不会新建配置、切换服务商类型或导入自定义服务商；`VITE_DEFAULT_API_URL` 本身仍可使用配置 URL 来定义部署端默认服务商。

**绑定自定义域名 (国内直连)**：Vercel 默认分配的 `.vercel.app` 域名在国内通常无法直接访问。如果你希望在国内直连访问，请在 Vercel 项目的 **Settings → Domains** 中绑定你自己的域名。

**配置自动更新**：

本项目已在 `vercel.json` 中关闭了默认的自动部署。若需在同步 GitHub 上游代码后自动更新 Vercel 部署：

1. 在 Vercel 项目设置 **Settings -> Git** 的 **Deploy Hooks** 中创建一个名为 `Release` 的 Hook（Branch 填 `main`）并复制生成的 URL。
2. 在你 Fork 的 GitHub 仓库设置 **Settings -> Secrets and variables -> Actions** 中，新建 Secret `VERCEL_DEPLOY_HOOK`，填入刚才的 URL。

此后，每次在 GitHub 点击 **Sync fork** 同步上游，都会自动触发 Vercel 构建部署最新版。

</details>

<details>
<summary><strong>☁️ 方式二：Cloudflare Workers 部署</strong></summary>

项目已内置 Wrangler 配置，可将 Vite 构建产物作为 Cloudflare Workers 静态资源部署。

**1. 登录 Cloudflare**

```bash
npx wrangler login
```

**2. 部署到 Workers**

```bash
npm run deploy:cf
```

部署脚本会先执行 `npm run build`，再通过 `wrangler deploy` 上传 `dist/` 目录。

**配置默认 API URL**：Cloudflare Workers 的环境变量不会自动改写已经构建好的静态文件。若需预设默认 API 地址，请在构建前设置 `VITE_DEFAULT_API_URL` 后再部署。

```bash
VITE_DEFAULT_API_URL=https://api.openai.com/v1 npm run deploy:cf
```

PowerShell 示例：

```powershell
$env:VITE_DEFAULT_API_URL="https://api.openai.com/v1"; npm run deploy:cf
```

**导入自定义服务商配置**：`VITE_DEFAULT_API_URL` 除了填写普通 API 地址外，也支持直接填写 `.json` 配置 URL 或带 `settings` 参数的分享 URL。设为配置 URL 时，页面启动后会自动导入其中的自定义服务商和 API 配置，设置页显示的是配置 JSON 中 profile 定义的 `baseUrl`（而非配置 URL 本身）。

**仅展示默认配置**：构建前设置 `VITE_SHOW_DEFAULT_CONFIG_ONLY=true` 后，如果已配置默认 API URL 或默认代理，前端会禁用“当前配置”和“服务商类型”的下拉切换。通过页面 URL 参数传入的配置只会覆盖当前配置字段，不会新建配置、切换服务商类型或导入自定义服务商；`VITE_DEFAULT_API_URL` 本身仍可使用配置 URL 来定义部署端默认服务商。

</details>

<details>
<summary><strong>🐳 方式三：Docker 部署</strong></summary>

官方镜像已发布至 GitHub Container Registry。该镜像为**单镜像形态**：Go 后端内嵌前端静态产物，并在返回 `index.html` 时把运行时配置注入到 `window.__APP_CONFIG__`，无需再在构建期写入 `VITE_*`。

> ⚠️ 该镜像内置强制登录后端，**运行时需要外挂 `config.yaml` 并连接一个外部 PostgreSQL 数据库**（后端启动会自动执行数据库迁移）。后端配置项（`server` / `database` / `jwt` / `oidc`）与 OIDC 提供商说明详见 [`backend/README.md`](backend/README.md)。容器默认监听 `8080`（可在 `config.yaml` 的 `server.port` 调整）。

**前端运行时环境变量（注入到 `window.__APP_CONFIG__`）：**

- `DEFAULT_API_URL`：设置页面上默认显示的 API 地址（如 `https://api.openai.com/v1`）。也支持填写 `.json` 配置 URL 或带 `settings` 参数的分享 URL 来导入自定义服务商配置（详见下方说明）。
- `SHOW_DEFAULT_CONFIG_ONLY`：设为 `true` 后，如果已配置默认 API URL，前端会禁用“当前配置”和“服务商类型”的下拉切换，只允许使用默认配置和默认服务商类型。通过页面 URL 参数传入的配置只会覆盖当前配置字段，不会新建配置、切换服务商类型或导入自定义服务商；`DEFAULT_API_URL` 本身仍可使用配置 URL 来定义部署端默认服务商。
- `AUTH_BACKEND_URL`：控制前端认证行为的三态开关——不设置该变量则禁用登录；设为 `disabled` 显式禁用；设为空串（`AUTH_BACKEND_URL=`）则启用登录并调用同源后端（单镜像形态推荐值）。

> ⚠️ **同源代理已移除**：单镜像不再提供容器内置的同源 API 代理，`API_PROXY_AVAILABLE` / `API_PROXY_LOCKED` 恒为 `false`。旧版本的 `ENABLE_API_PROXY` / `LOCK_API_PROXY` / `API_PROXY_URL` / `API_URL` 等 nginx 代理相关变量均已不再支持。如需绕开浏览器 CORS，请在 API 上游侧自建代理，或使用自定义服务商配置指向已支持 CORS 的地址。

> 💡 **导入自定义服务商配置**：`DEFAULT_API_URL` 除了填写普通 API 地址外，也支持直接填写 `.json` 配置 URL 或带 `settings` 参数的分享 URL。设为配置 URL 时，页面启动后会自动导入其中的自定义服务商和 API 配置，设置页显示的是配置 JSON 中 profile 定义的 `baseUrl`（而非配置 URL 本身）。

**1. Docker CLI 示例**

```bash
docker run -d -p 8080:8080 \
  -v /path/to/config.yaml:/app/config.yaml \
  -e DEFAULT_API_URL=https://api.openai.com/v1 \
  -e AUTH_BACKEND_URL= \
  ghcr.io/cooksleep/gpt_image_playground:latest
```

> `config.yaml` 需包含数据库连接与 JWT/OIDC 配置，`database.host` 指向可连通的 PostgreSQL。若不需要登录，可省略 `-e AUTH_BACKEND_URL=`（或设为 `disabled`），此时无需配置 OIDC 提供商。

**2. Docker Compose 示例（含 PostgreSQL）**

```yaml
services:
  gpt-image-playground:
    image: ghcr.io/cooksleep/gpt_image_playground:latest
    environment:
      - DEFAULT_API_URL=https://api.openai.com/v1
      - AUTH_BACKEND_URL=
    volumes:
      - ./config.yaml:/app/config.yaml:ro
    ports:
      - "8080:8080"
    depends_on:
      - db
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=change-me
      - POSTGRES_DB=gpt_image
    volumes:
      - pgdata:/var/lib/postgresql/data
    restart: unless-stopped

volumes:
  pgdata:
```

> 上例中 `config.yaml` 的 `database.host` 应填 compose 服务名 `db`。后端配置文件的完整字段说明见 [`backend/README.md`](backend/README.md)。

**更新说明：**

使用 `latest` 标签时，重新拉取镜像并重启即可更新（如 `docker compose pull && docker compose up -d`）。若需固定版本可使用官方提供的版本号标签。

</details>

<details>
<summary><strong>💻 方式四：本地开发与静态构建</strong></summary>

**1. 环境准备与启动**

你可以在项目根目录新建 `.env.local` 文件配置默认 API URL（如 `VITE_DEFAULT_API_URL=https://api.openai.com/v1`）。可参考根目录的 `.env.example`（含全部可用变量及说明），复制为 `.env.local` 后按需修改。然后安装依赖并启动：

**导入自定义服务商配置**：`VITE_DEFAULT_API_URL` 除了填写普通 API 地址外，也支持直接填写 `.json` 配置 URL 或带 `settings` 参数的分享 URL。设为配置 URL 时，页面启动后会自动导入其中的自定义服务商和 API 配置，设置页显示的是配置 JSON 中 profile 定义的 `baseUrl`（而非配置 URL 本身）。

**仅展示默认配置**：在 `.env.local` 中加入 `VITE_SHOW_DEFAULT_CONFIG_ONLY=true` 后，如果已配置默认 API URL 或默认代理，前端会禁用“当前配置”和“服务商类型”的下拉切换。通过页面 URL 参数传入的配置只会覆盖当前配置字段，不会新建配置、切换服务商类型或导入自定义服务商；`VITE_DEFAULT_API_URL` 本身仍可使用配置 URL 来定义部署端默认服务商。

**登录认证（可选）**：通过 `VITE_AUTH_BACKEND_URL` 控制是否启用 OIDC 登录。启用后进入首页时若无有效登录态，会在首页之上弹出登录弹窗强制登录。取值规则：

- 不设置该变量：禁用认证，直接进入首页（纯静态部署默认行为）。
- `VITE_AUTH_BACKEND_URL=disabled`：显式禁用认证。
- `VITE_AUTH_BACKEND_URL=`（空串）：启用认证并使用同源后端（推荐生产部署，由 Nginx 反代 `/auth`、`/api/v1`）。
- `VITE_AUTH_BACKEND_URL=https://your-backend`：启用认证并跨域调用指定后端（开发环境常用）。

> 认证后端的部署与 OIDC 提供商配置见 `backend/README.md`。

```bash
npm install
npm run dev
```

**2. 本地开发跨域代理 (可选)**

如果在本地开发时遇到浏览器的 CORS 限制，可开启本地代理转发：

```bash
cp dev-proxy.config.example.json dev-proxy.config.json
```

修改 `dev-proxy.config.json`，将 `target` 设置为真实的完整 API 基础地址。代理不会自动补 `/v1`，OpenAI 兼容接口通常必须填写到版本前缀，如 `https://api.example.com/v1`。重启开发服务器后，在页面设置中开启 **API 代理** 即可（请求将被转发如 `http://localhost:5173/api-proxy/... -> target/...`）。此功能仅在 `npm run dev` 阶段生效，不会影响打包产物。

**3. 本地故障模拟 API (可选)**

如果需要复现图片 URL 跨域、接口返回结构异常、原始响应查看等问题，可启动内置模拟服务：

```powershell
npm run mock:api
```

使用方式见 [本地故障模拟 API](docs/mock-image-api.md)。

**4. 构建静态产物**

```bash
npm run build
```

构建输出的文件位于 `dist/` 目录下，可将其部署至任何静态文件服务器（如普通 Nginx、GitHub Pages、Netlify 等）。

</details>

---

## 🛠️ URL 传参快速填充

应用支持通过 URL 查询参数快速填入配置，非常适合创建书签或集成分享。根据你的服务商类型，选择对应的方式：

**方式一：标准 OpenAI 兼容服务商**
直接使用简短的查询参数配置：
- `?apiUrl=https://你的代理地址.com`
- `?apiKey=sk-xxxx`
- `?apiMode=images` 或 `?apiMode=responses`（未传时默认为 `images`）
- `?model=gpt-image-2`（未传时按 `apiMode` 使用默认模型）
- `?profileName=我的配置`（设置配置名称，未传时默认为 `URL 参数配置`）
- `?codexCli=true`（开启 Codex CLI 兼容模式）
- `?streamImages=true`（开启流式传输）
- `?streamPartialImages=2`（请求中间步骤图像数，需配合 `streamImages=true` 使用）

例如，集成到 New API 的聊天系统：

```text
https://gpt-image-playground.cooksleep.dev?apiUrl={address}&apiKey={key}&model={model}
```

```text
https://cooksleep.github.io/gpt_image_playground?apiUrl={address}&apiKey={key}&model={model}
```

**方式二：自定义格式服务商**
如果需要导入自定义格式的 API 配置，请使用 `settings` 参数并传入 URL 编码后的完整 JSON：
- `?settings={URL编码后的JSON}`（只读取 `customProviders` 和 `profiles` 列表）

> 推荐先在项目内完成配置生成与导入：
>
> **设置 - API 配置 - 服务商类型 - 创建自定义服务商 - AI 一键生成与导入**
>
> 完成后可在 **API 配置 - 当前配置** 使用右侧快捷按钮：
>
> - **链接按钮**：复制可导入配置的 URL。复制时可选择不包含 API Key，并使用 `{address}`、`{key}`、`{model}` 等变量，便于在 New API 等平台中集成分享。
> - **复制按钮**：将当前配置复制一份到配置列表底部，新配置名称会追加“（复制）”。

JSON 结构示例：

```json
{
  "customProviders": [
    {
      "id": "custom-example-task",
      "name": "示例异步任务服务商",
      "submit": {
        "path": "images/generations",
        "method": "POST",
        "contentType": "json",
        "body": {
          "model": "$profile.model",
          "prompt": "$prompt",
          "size": "$params.size",
          "quality": "$params.quality",
          "output_format": "$params.output_format",
          "output_compression": "$params.output_compression",
          "n": "$params.n",
          "image_urls": "$inputImages.dataUrls"
        },
        "taskIdPath": "data.0.task_id"
      },
      "poll": {
        "path": "tasks/{task_id}",
        "method": "GET",
        "intervalSeconds": 5,
        "statusPath": "data.status",
        "successValues": ["completed"],
        "failureValues": ["failed", "cancelled"],
        "errorPath": "data.error.message",
        "result": {
          "imageUrlPaths": ["data.result.images.*.url.*"],
          "b64JsonPaths": []
        }
      }
    }
  ],
  "profiles": [
    {
      "name": "示例异步任务服务商",
      "provider": "custom-example-task",
      "baseUrl": "https://api.example.com/v1",
      "model": "example-image-model",
      "apiMode": "images"
    }
  ]
}
```

第三方服务商可以参考 [自定义服务商 LLM 提示词](docs/custom-provider-llm-prompt.md)，让 LLM 根据自己的 API 文档生成可导入的完整配置。导入后只需要在设置里补充 API Key。

Composite 图生图/图片编辑的配置示例见 [`docs/composite-image-edit-settings.json`](docs/composite-image-edit-settings.json)。导入后填写 Composite API Key；`baseUrl` 默认对应文档中的 `https://localhost:8443/api`，可按实际网关地址调整。该配置提交任务后会轮询 `IN_QUEUE`/`IN_PROGRESS`，在 `COMPLETED` 后再请求最终结果接口并读取 `images[*].url`。文生图提交配置暂待对应接口文档补充。

---

## 💻 技术栈

<div align="center">
  <br>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React_19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB" alt="React 19" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-B73BFE?style=for-the-badge&logo=vite&logoColor=FFD62E" alt="Vite" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwind_CSS_3-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white" alt="Tailwind CSS 3" /></a>
  <a href="https://zustand.docs.pmnd.rs/"><img src="https://img.shields.io/badge/Zustand-764ABC?style=for-the-badge&logo=react&logoColor=white" alt="Zustand" /></a>
  <br>
  <br>
</div>

## 📄 许可证 & 致谢

本项目基于 [MIT License](LICENSE) 开源。

特别致谢：[LINUX DO](https://linux.do)

## 💜 赞助支持

<div align="center">

如果这个项目对你有帮助，欢迎通过爱发电赞助支持，你的每一份鼓励都是持续更新的动力！

<br>
<br>

<a href="https://www.ifdian.net/a/cooksleep">
  <img src="https://img.shields.io/badge/%E7%88%B1%E5%8F%91%E7%94%B5-%E8%B5%9E%E5%8A%A9%E4%BD%9C%E8%80%85-946ce6?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyMS4zNWwtMS40NS0xLjMyQzUuNCAxNS4zNiAyIDEyLjI4IDIgOC41IDIgNS40MiA0LjQyIDMgNy41IDNjMS43NCAwIDMuNDEuODEgNC41IDIuMDlDMTMuMDkgMy44MSAxNC43NiAzIDE2LjUgMyAxOS41OCAzIDIyIDUuNDIgMjIgOC41YzAgMy43OC0zLjQgNi44Ni04LjU1IDExLjU0TDEyIDIxLjM1eiIvPjwvc3ZnPg==&logoColor=white" alt="爱发电赞助" />
</a>

<br>
<br>

</div>

## ⭐ Star History

<div align="center">
  <a href="https://www.star-history.com/#CookSleep/gpt_image_playground&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=CookSleep/gpt_image_playground&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=CookSleep/gpt_image_playground&type=Date" />
      <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=CookSleep/gpt_image_playground&type=Date" />
    </picture>
  </a>
</div>
