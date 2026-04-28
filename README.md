# GPT Image Playground

基于 OpenAI 图像生成接口的图片生成与编辑工具。提供简洁的 Web UI，支持文本生成图片、参考图编辑、可视化参数调节、历史记录管理与本地数据导入导出。


> 如有调用非本地的 HTTP API 的需求，请使用 GitHub Pages 版本或自行部署，因为 `.dev` 域名要求页面本身及其加载的资源（的来源）均为 HTTPS。

**Vercel 部署版本在线体验：** 
https://gpt-image-playground.cooksleep.dev

**GitHub Pages 部署版本在线体验：**
https://cooksleep.github.io/gpt_image_playground

---

## 📸 示例截图

<div align="center">
  <b>桌面端主界面</b><br>
  <img src="docs/images/example_pc_1.png" alt="桌面端主界面" />
</div>

<br>

<div align="center">
  <b>任务详情与实际参数</b><br>
  <img src="docs/images/example_pc_2.png" alt="任务详情与实际参数" />
</div>

<br>

<div align="center">
  <b>桌面端批量选择</b><br>
  <img src="docs/images/example_pc_3.png" alt="桌面端批量选择" />
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

---

## ✨ 功能特性

### 🎨 核心能力
- **文本生图**：输入提示词，可调用 `images/generations` 或 Responses API 的 `image_generation` 工具生成图片。
- **参考图编辑**：支持上传最多 16 张参考图，可调用 `images/edits` 或 Responses API 多模态输入进行图片编辑。支持文件选择、粘贴和拖拽三种方式。
- **遮罩编辑**：支持在参考图上绘制遮罩后进行局部编辑。遮罩主图会按官方接口限制预处理为安全工作图，避免高分辨率图片导致提交失败。需要注意的是，根据官方文档说明，遮罩编辑仍基于提示词引导模型，无法完全控制模型实际编辑区域。
- **接口模式切换**：支持在设置中选择 Images API (`/v1/images`) 或 Responses API (`/v1/responses`)。
- **批量生成**：单次可设置生成多张图片。
- **Codex CLI 兼容模式**：可在设置中开启 Codex CLI 模式。开启后根据 Codex CLI 中的实际可用能力，将质量参数固定为 `auto` 且不会发送 `quality` 字段；Images API 的多图生成会拆分为多个并发请求完成，解决该 API 数量参数无效的问题；提示词文本开头会加入简短的不改写要求，避免模型重写提示词，偏离原意。

### ⚙️ 精细化参数控制
- **智能尺寸选择器**：支持 `auto`、按 `1K / 2K / 4K` 结合常用比例自动计算分辨率，同时也支持手动输入自定义宽高。
- **自动规整**：为了兼容模型限制，自定义尺寸会自动规整到合法范围：宽高均为 16 的倍数，最大边长 `3840px`，宽高比不超过 `3:1`，总像素限制为 `655360` 到 `8294400`。
- **预设反推**：打开尺寸选择弹窗时，会自动根据当前尺寸匹配对应的预设比例。
- **其他选项**：支持调整质量 (`low`, `medium`, `high`)、输出格式 (`PNG`, `JPEG`, `WebP`)、压缩率 (0-100) 以及审核强度。
- **实际参数追踪**：会记录 API 返回的实际尺寸、质量、格式、数量与改写提示词，并在与请求值不一致时高亮展示。

### 📁 历史记录与工作流
- **瀑布流任务卡片**：直观展示生成缩略图、提示词、参数和耗时。支持按状态筛选与关键词搜索。
- **收藏与筛选**：支持收藏常用记录，并可一键只看收藏内容。
- **多选批量操作**：桌面端支持拖拽框选和 Ctrl/⌘ 点击多选，移动端支持左右侧滑选择；选中后可批量收藏、删除或全选当前可见记录。
- **快速复用**：一键将历史记录的配置与提示词回填到输入框。
- **迭代生成**：支持将生成的输出结果直接添加到参考图列表中，进行下一轮迭代编辑。
- **画廊与详情**：点击任务卡片可查看完整输入输出，支持大图浏览。
- **快捷操作**：支持图片右键或移动端长按唤出自定义菜单，快速复制、下载图片，或将图片加入参考图后继续编辑。

### 📱 体验优化
- **响应式布局**：桌面端提供更高效的批量选择与底部输入栏，移动端输入栏可折叠，并针对侧滑、多选和弹窗交互做了适配。
- **PWA 支持**：支持渐进式 Web 应用（PWA），可将网页作为独立应用安装到桌面或移动设备主屏幕，提供类似原生 App 的沉浸式体验，并适配 iOS PWA 顶部安全区。

### 💾 本地数据优先
- **IndexedDB 存储**：所有任务记录与图片数据均存储在浏览器的 IndexedDB 中，数据绝不离开本地。
- **性能优化**：参考图采用内存缓存与延迟存储机制，图片采用 SHA-256 哈希自动去重，并在每次启动时自动清理孤立的图片碎片。
- **导入与导出**：支持将完整数据打包为 ZIP 导出。导出的 ZIP 内包含原始图片文件（非 base64）和记录图片元数据的 `manifest.json`，方便备份与迁移。

---

## 🚀 部署与使用

支持多种部署与使用方式，推荐使用 Vercel 一键部署。

<details>
<summary><strong>▲ 方式一：Vercel 一键部署 (推荐)</strong></summary>

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FCookSleep%2Fgpt_image_playground&project-name=gpt-image-playground&repository-name=gpt-image-playground)

点击上方按钮后，按 Vercel 页面提示导入仓库即可。项目已包含 `vercel.json`，Vercel 会自动执行 `npm install`、`npm run build`，并将 `dist/` 作为静态输出目录。

如需预置默认 API 节点，可在 Vercel 项目的 **Settings → Environment Variables** 中添加：

```bash
VITE_DEFAULT_API_URL=https://api.openai.com/v1
```

部署完成后，打开 Vercel 分配的域名，在页面右上角设置中填入 API Key 即可使用。

**更新说明：**

- 如果你是通过一键按钮部署，Vercel 通常会为你创建一份自己的 Git 仓库，并从该仓库自动部署。
- 后续想更新到本项目最新版时，请先将你的仓库同步到本仓库最新代码，再让 Vercel 重新部署。
- 如果你的仓库是 Fork，可以在 GitHub 仓库页面点击 **Sync fork** 同步；同步后，Vercel 会按你的项目设置自动部署。
- 如果你关闭了 Vercel 自动部署，也可以在 Vercel 项目的 **Deployments** 页面手动 Redeploy 最新提交。

</details>

<details>
<summary><strong>🐳 方式二：Docker 部署</strong></summary>

项目已将镜像发布至 GitHub Container Registry。你可以通过环境变量 `API_URL` 注入默认的 API 节点，也可以通过 `HOST`、`PORT` 指定容器内 nginx 的监听地址，默认值为 `0.0.0.0:80`。

**使用 Docker CLI：**

```bash
docker run -d -p 8080:80 \
  -e API_URL=https://api.openai.com/v1 \
  ghcr.io/cooksleep/gpt_image_playground:latest
```

使用 host 网络并监听宿主机 `28080` 端口：

```bash
docker run -d --network host \
  -e HOST=0.0.0.0 \
  -e PORT=28080 \
  -e API_URL=https://api.openai.com/v1 \
  ghcr.io/cooksleep/gpt_image_playground:latest
```

**使用 Docker Compose：**

```yaml
services:
  gpt-image-playground:
    image: ghcr.io/cooksleep/gpt_image_playground:latest
    environment:
      - API_URL=https://api.openai.com/v1
    ports:
      - "8080:80"
    restart: unless-stopped
```

浏览器访问 `http://localhost:8080`，在页面右上角设置中填入 API Key 即可使用。如果你的 API 节点没有放开浏览器跨域，可以在设置中开启 **API 代理**，由容器内 Nginx 将同源的 `/api-proxy/` 请求转发到 `API_URL`。

如果使用 bridge 网络并修改了容器内 `PORT`，需要同步调整端口映射，例如 `PORT=28080` 时使用 `"8080:28080"`。使用 host 网络时不要配置 `ports`。

*(注：官方镜像同时提供带版本号的标签，如 `0.1.11` 或 `0.1`)*

**更新说明：**

- 使用 `latest` 标签时，重新拉取镜像并重启容器即可更新到最新发布版本。
- 如果希望固定版本，建议使用明确版本号标签，例如 `ghcr.io/cooksleep/gpt_image_playground:0.2.3`。
- Docker Compose 更新示例：

```bash
docker compose pull
docker compose up -d
```

</details>

<details>
<summary><strong>💻 方式三：本地开发与自行构建</strong></summary>

1. **环境准备 (可选)**
   你可以在项目根目录新建 `.env.local` 文件，配置构建时的默认 API URL：
   ```bash
   VITE_DEFAULT_API_URL=https://api.openai.com/v1
   ```

2. **安装依赖与启动开发服务器**
   ```bash
   npm install
   npm run dev
   ```
   随后浏览器访问 `http://localhost:5173`。

3. **本地开发跨域代理（可选）**
   如果你的图片接口没有放开浏览器跨域，前端直接请求接口时可能会被浏览器的 CORS 策略拦截。这个可选代理用于本地开发调试：开启页面设置中的 **API 代理** 后，浏览器先请求同源的 Vite 开发服务器，再由 Vite 开发服务器转发到真实接口。

   请求链路如下：

   ```text
   浏览器页面 http://localhost:5173
     -> 同源请求 http://localhost:5173/api-proxy/v1/images/generations
     -> Vite 开发服务器代理转发
     -> 真实接口 http://127.0.0.1:3000/v1/images/generations
   ```

   选择 Responses API 时，同一代理配置会将请求改写为 `/api-proxy/v1/responses`。

   这样浏览器看到的是同源请求，实际跨域请求发生在 Vite 开发服务器这一侧，从而绕开浏览器 CORS 限制。

   注意：这个开发代理只在 `npm run dev` 启动的 Vite 开发服务器中生效。它不会打包进静态产物，也不会在 Vercel、GitHub Pages 或普通 Nginx 静态部署中生效。Docker 镜像内置了 Nginx 代理，其他线上部署需要自行提供等价的服务端转发。

   先复制示例配置：
   ```bash
   cp dev-proxy.config.example.json dev-proxy.config.json
   ```
   然后修改项目根目录下的本地 `dev-proxy.config.json`：
   ```json
   {
     "enabled": true,
     "prefix": "/api-proxy",
     "target": "http://127.0.0.1:3000",
     "changeOrigin": true,
     "secure": false
   }
   ```
   配置含义：

   - `enabled`：是否启用本地开发代理。
   - `prefix`：前端同源请求使用的代理路径前缀。
   - `target`：真实图片接口地址，也就是 Vite 开发服务器要转发到的后端。
   - `changeOrigin`：转发时是否把请求头中的 `Host` 改成 `target` 的主机名，通常建议保持 `true`。
   - `secure`：当 `target` 是 HTTPS 时是否校验证书；本地自签名证书可设为 `false`。

   修改配置后需要重新启动开发服务器，并在页面设置中的 `API URL` 填入与 `target` 相同的地址，然后开启 **API 代理**。开启后，请求会改写为 `prefix` 开头的同源地址，例如 `/api-proxy/v1/images/generations` 或 `/api-proxy/v1/responses`。

   > 如果 `target` 或填入的 `API URL` 已经包含了 `/v1` 路径，则同源请求的路径将不再重复拼接 `/v1`，例如会直接变为 `/api-proxy/responses`

   如果需要在非 Docker 的线上部署中使用代理，请使用 Vercel Function、Cloudflare Worker、Nginx 反向代理或自建后端等服务端方案。

4. **构建静态产物**
   ```bash
   npm run build
   ```
   构建输出的文件会存放在 `dist/` 目录下，你可以将其部署到任何静态文件服务器（如 Nginx、Vercel、Netlify 等）。

</details>

---

## 🛠️ API 配置说明

点击页面右上角的设置图标，你可以随时更改 API 相关的配置。

- **Images API**：调用 `/v1/images/generations` 和 `/v1/images/edits`，模型需要填写 GPT Image 模型，例如 `gpt-image-2`。
- **Responses API**：调用 `/v1/responses` 并使用 `image_generation` 工具，模型需要填写支持该工具的文本模型，例如 `gpt-5.5`。
- **API 代理**：开启后，浏览器会请求同源的 `/api-proxy/` 路径，再由当前后端转发到真实 API，用于绕开浏览器 CORS 限制。代理目标由部署端配置决定，例如 Docker 中的 `API_URL` 或本地开发的 `dev-proxy.config.json`。
- **Codex CLI 模式**：如果你在使用源于 Codex CLI 的 API，可以在 `API URL` 右侧开启该模式。开启后应用不会向任何接口发送 `quality` 参数，界面中的质量选项也会固定为 `auto`；同时会在提示词文本开头加入简短的不改写要求，避免模型重写提示词，偏离原意。
- Codex CLI 模式下，Images API 的图片数量会通过并发发起多个单图请求实现；Responses API 原本也通过并发请求实现多图生成。
- 如果检测到接口返回的提示词被改写，应用会提示是否为当前 `API URL + API Key` 组合开启 Codex CLI 模式；取消后，同一组合不再重复询问。

应用支持通过 URL 查询参数快速填充配置，非常适合书签或分享给他人使用：
- `?apiUrl=https://你的代理地址.com`
- `?apiKey=sk-xxxx`
- `?apiMode=images` 或 `?apiMode=responses`，未传时默认使用 `images`
- `?codexCli=true` 或 `?codexCli=false`，未传时默认关闭，仅 `true` 会开启 Codex CLI 模式

例如：
- 接入 New API 聊天应用：
  ```
  https://gpt-image-playground.cooksleep.dev?apiUrl={address}&apiKey={key}
  ```

  ```
  https://cooksleep.github.io/gpt_image_playground?apiUrl={address}&apiKey={key}
  ```

---

## 💻 技术栈

- **框架**：[React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- **构建工具**：[Vite](https://vite.dev/)
- **样式**：[Tailwind CSS 3](https://tailwindcss.com/)
- **状态管理**：[Zustand](https://zustand.docs.pmnd.rs/)
- **数据存储**：浏览器的 IndexedDB API

## 📄 许可证

[MIT License](LICENSE)

## 🔗 致谢

[LINUX DO](https://linux.do)
