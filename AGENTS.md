# Agent Instructions for gpt-image-playground

本文件定义 AI 编码助手在此仓库中应遵循的工作方式。

## 项目概况

- React 19 + Vite + TypeScript 前端应用，使用 Zustand 状态管理、Tailwind CSS 样式。
- 源码在 `src/`，构建产物由 Vite 生成，不要手动编辑 `dist/`。
- 包管理器为 npm（有 `package-lock.json`），不要使用 yarn 或 pnpm。

## 常用命令

| 操作 | 命令 |
|------|------|
| 安装依赖 | `npm install` |
| 开发服务器 | `npm run dev` |
| 构建 | `npm run build` |
| 运行测试 | `npm test` |
| 监听测试 | `npm run test:watch` |
| 生成第三方许可清单（需要先安装 cargo-about：`cargo install cargo-about --version 0.9.2 --locked --features cli`） | `npm run notices` |

- 测试使用 Vitest，已有多个 `*.test.ts` 文件。
- 不要新增 lint/formatter 配置文件，除非明确要求。
- 测试在本地运行，不添加 push 或 PR 触发的 CI 测试工作流。
- 换行遵循 `.gitattributes`：通常使用 LF，PowerShell 脚本使用 CRLF。Rust 使用 `cargo fmt`。

## 代码风格（强制）

### 简单优先

写出能工作的**最简代码**。少抽象、少包装。有疑问就内联。

- 不要为单次使用的 1-5 行逻辑创建独立函数，直接内联。
- 函数只有在**多处调用**且**逻辑非平凡**时才值得提取。
- 不要引入项目中不存在的设计模式或架构层。

### 完整实现

- 不要留 `// TODO: implement later`、`// ...` 或 stub 函数。
- 如果不确定某个细节，给出完整的最佳猜测实现。错误但完整的代码优于正确但残缺的骨架。

### 跟随现有风格

这是最高优先级规则。修改文件时，遵循该文件及周围代码的已有风格。

### 格式

- **2 空格缩进**。
- **单引号**（`'hello'`）。
- **无分号**。
- 箭头函数始终加括号：`(x) => x`。
- 行宽不做硬性限制，但尽量保持可读。

### TypeScript

- 使用 ESM import，`const` 优先，永远不用 `var`。
- Target `ES2020`（见 `tsconfig.json`）。
- 优先早返回，避免深层嵌套和 `else` 链。
- 尽量避免 `any`；需要时保持局部化。
- 利用类型推断，不写多余的类型注解。
- 共享类型放 `src/types.ts`，局部类型放文件顶部。

### 命名

- **PascalCase**：组件、类型、接口。
- **camelCase**：函数、变量、参数。
- **UPPER_SNAKE_CASE**：模块级常量。
- 文件名小写驼峰：`apiProfiles.ts`、`maskPreprocess.ts`。
- 局部变量优先短名：`ctx`、`el`、`msg`、`idx`、`opts`、`err`。多词名仅在单词不够清晰时使用。

### 解构

避免无必要的解构。优先点号访问以保留上下文。

```ts
// 好
profile.baseUrl
opts.settings

// 避免
const { baseUrl } = profile
const { settings } = opts
```

例外：React 组件 props、hooks 返回值、函数参数解构是可以的。

### 控制流

```ts
// 好：早返回
function getPreset(name: string) {
  if (!name) return defaultPreset
  return presets.find((p) => p.name === name)
}

// 避免：多余的 else
function getPreset(name: string) {
  if (!name) return defaultPreset
  else return presets.find((p) => p.name === name)
}
```

### 变量

优先 `const`，用三元或早返回代替 `let` 重赋值。

```ts
// 好
const params = hasInputImages
  ? { ...baseParams, image: inputImages }
  : baseParams

// 避免
let params
if (hasInputImages) params = { ...baseParams, image: inputImages }
else params = baseParams
```

### 常量提取

不要为一次性使用的字面量定义命名常量。只有满足以下条件之一才提取：
1. 多处使用，或
2. 含义不一目了然，或
3. 是需要调优的关键参数。

### 防御性代码

本项目涉及外部 API 响应、URL 参数、IndexedDB 持久化数据——对这些**外部输入**保留必要的校验和兼容处理（`normalize*`、`ensure*` 等函数在本项目中是合理的）。

但不要对已声明为非可选的内部类型加投机性空检查。

## Import 顺序

大致分组：
1. React / React DOM
2. 第三方包（zustand、fflate、react-markdown 等）
3. 本地类型（`../types`、`./types`）
4. 本地模块（`./lib/*`、`./hooks/*`、`./components/*`）

## React 组件

- 函数组件 + hooks，不使用 class 组件。
- 组件文件放 `src/components/`，hooks 放 `src/hooks/`，工具函数放 `src/lib/`。
- 复杂 UI 逻辑可以拆成独立组件或 hook，不必强行内联。
- Tailwind 类名不强制排序，但同类属性（布局、间距、颜色、交互）尽量分组书写，保持可读。

## 错误处理

- 对网络请求和文件 I/O 使用 `try/catch`，用 `console.warn` 或 `console.error` 记录。
- 不要对没有证据会失败的路径加投机性错误处理。

## 注释与语言

- 代码注释使用**中文**，与项目现有风格保持一致。
- UI 文案默认中文。
- 注释应简洁，说明“为什么”而非“做了什么”——除非逻辑复杂不易一眼看出。代码本身能说清的不写注释。
- 注释只描述代码现在的样子，读者是以后看代码的人，不是这次的审查者。不要写：
  - 开发过程：改动前是什么样、修了什么问题、哪轮审查发现的、“新增”“改为”“不再”“之前”这类相对说法；
  - 提交号、Issue / PR 编号及其讨论过程、会话或报告；
  - 复述函数名、参数名或下一行代码，以及“注意”“重要”之类没有信息量的提示；
  - 对不会发生的情况的辩解，或已删除代码的去向。
- 涉及实测数据的取舍（例如某个供应商接口的兼容处理、超时或并发数的取值），注释只写结论和关键数字，不写测试经过。

## 界面与文案

- 文案简短、书面、自然，同一概念使用同一名称，保留常见专业术语。引导优先放在占位符或示例中。
- README、发布说明和界面文案只写功能及必要配置，避免长篇解释、内部实现和免责声明。
- 简短单句通知、空状态、状态行和气泡提示省略末尾句号；多句文本、弹窗正文和设置描述保留句号。
- 界面入口使用「设置 → 高级」这类格式；GitHub 模板中加粗入口使用 `<b>「设置 → 高级」</b>`。
- 提示使用 `ViewportTooltip` 等已有气泡组件，不使用原生 `title`。设置说明直接放在标签下，描述数值时使用“此值”。
- 数字输入越界时显示气泡，失焦恢复已保存值。
- 弹窗正文分成短段落；内容增长时用 `scrollbar-gutter: stable` 避免布局跳动。
- 沿用 SVG 图标、紧凑对齐的列、统一按钮颜色和卡片布局，短标签避免无意义的省略号。
- 错误提示保持中性，简洁说明情况和解决办法。
- AI 品牌图标使用 lobe-icons 技能，优先复用现有 SVG 图标并保留许可说明。

## 发布版本升级

- 准备新版本时，先检查当前分支相对远端的全部未推送提交和未提交修改，再据此编写 `RELEASE.md`。
- `RELEASE.md` 只保留最新一个版本：写新版本时替换掉上一版本的段落，不要追加在其上方。
- `RELEASE.md` 使用实际发布日期，只记录最终面向用户的新增、变更和修复；不要记录开发新内容时产生的中间调整或配套修复。
- `RELEASE.md` 格式：
  - 标题使用 `## v版本号（YYYY-MM-DD）`，日期括号使用中文全角括号。
  - 内容按需使用 `### 新增`、`### 变更`、`### 修复`、`### 贡献` 分类，没有内容的分类不要保留。
  - 每项使用 `- ` 开头，以完整中文句子概括用户可感知的结果，句末使用中文句号。
  - 较大的功能先用一条主条目概括，再用缩进两个空格的 `  - ` 子条目分点说明入口、主要能力和细节；子条目同样是以中文句号结尾的完整句子，每条只讲一件事。小改动保持单条，不必拆分。
  - 相关 PR 或 Issue 编号放在条目末尾，格式为 `（PR #42）` 或 `（Issue #42）`，与已有发布记录保持一致；有子条目时只标在主条目末尾。
  - 外部贡献在 `### 贡献` 中使用 `- @用户名 通过 PR #编号 贡献了……，特此感谢。` 格式致谢。
- 提升版本号时必须同步更新以下位置：
  - `package.json` 的 `version`。
  - `package-lock.json` 顶层及根包的 `version`。
  - `public/sw.js` 的 `CACHE_NAME` 版本，确保旧缓存能够在 Service Worker 激活时清理。
  - `RELEASE.md` 标题中的版本号和日期。
  - `src-tauri/Cargo.toml` 的 `version`，以及 `src-tauri/Cargo.lock` 中 `gpt-image-playground` 包的 `version`（`tauri.conf.json` 直接引用 `package.json`，无需修改）。
- 客户端更新包由 `tauri build` 用私钥签名（`TAURI_SIGNING_PRIVATE_KEY`，私钥设有密码，需同时提供 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；GitHub Secrets 中两者都要设置，本机打包时以环境变量传入，密码不得写进任何文件或提交），发布的 Release 中必须包含安装包、对应的 `.sig` 和 `latest.json`，否则客户端的应用内更新会提示找不到更新包；私钥不得提交进仓库。
- 推送 `v版本号` tag 会触发 `.github/workflows/tauri-release.yml`（只由推送 tag 触发，不提供为已有 tag 手动重新构建的入口；已发布版本有问题时发布新版本修复）：校验 tag 与 `package.json`、`Cargo.toml` 的版本一致，在 Windows 上构建 NSIS 安装包，并把安装包、`.sig` 和 `latest.json` 上传到该 tag 的 Release。工作流最后用 `gh release edit` 把 Release 的标题设为 tag、正文设为 `RELEASE.md` 中对应版本的段落，并设为正式版（非草稿、非预发布）；手动创建的 Release 也会被覆盖。因此先在 `RELEASE.md` 写好该版本再打 tag，正文以 `RELEASE.md` 为准；不要预先手动创建草稿 Release（tauri-action 查找已有 Release 时不匹配草稿，会另建一个），之后也不要把 Release 改为草稿或预发布，否则客户端的更新地址（`releases/latest/download/latest.json`）找不到它。
- 网页版部署（`deploy.yml` 的 GitHub Pages 和 `vercel-tag-deploy.yml` 的 Vercel）和 Docker 镜像构建（`docker.yml`）在配置了签名私钥的仓库中由该工作流成功后触发，确保它们上线时客户端 Release 已存在；未配置签名私钥时客户端构建跳过，推送 tag 后直接部署。
- 修改 `src-tauri/windows/installer.nsi`（基于 Tauri 内置模板的自定义 NSIS 模板）或升级 `@tauri-apps/cli` 时，需对照新版内置模板同步，并在本机用 `npm run tauri:build` 构建后实测安装、覆盖安装和卸载。
- 更新后全局搜索旧版本号，确认没有遗漏仍需同步的位置；历史发布记录中的旧版本号不需要修改。
- 发布前运行 `npm run build` 和 `npm test`，并复查最终差异。

## 架构约束

- **依赖协议**：只引入 MIT、Apache 2.0、BSD、ISC、Zlib、公有领域等宽松协议的依赖，**不引入 GPL / AGPL / LGPL**。新增依赖前先确认协议；第三方许可清单 `src/assets/third-party-notices.txt` 是提交进仓库的生成文件，在 **「设置 → 关于 → 第三方许可」** 中显示（Web 版与客户端相同），Rust 或前端依赖变化后运行 `npm run notices` 重新生成并一起提交；Rust 依赖中出现新的宽松协议时先确认，再加入 `src-tauri/about.toml` 的 `accepted`；npm 包中没有许可文件时生成会失败，需从上游仓库对应版本取许可原文放进 `third-party-licenses/npm/`。Tauri 等带进来的 MPL-2.0 间接依赖（未修改）可以接受，许可清单中注明其源码位置。
- 新增纯函数或工具逻辑时，放 `src/lib/` 而非 `src/store.ts`。store 文件已过大，应只包含 state 定义和 action 入口。
- 避免在多处重复定义相同工具函数（如 `blobToDataUrl`），优先复用 `src/lib/` 中已有导出。
- 新增较大功能时，优先拆成独立模块（lib 函数 + hook + 组件），而非全部塞进现有大文件。
- 组件超过 800 行时，考虑按逻辑边界拆成子组件或自定义 hook。

## 注意事项

- `src/store.ts` 是核心状态文件（5000+ 行），修改时注意：
  - 持久化逻辑和数据迁移（`persist` middleware + IndexedDB）。
  - 模块顶部的 `normalize*` 函数用于从 IndexedDB/localStorage 恢复时清洗旧格式数据，修改需保持向后兼容。
  - 新增 state 字段时，考虑是否需要持久化以及升级路径。
- `src/lib/apiProfiles.ts` 包含多供应商配置，修改时注意向后兼容。
- `src/lib/db.ts` 是 IndexedDB 封装层，修改 schema 时需升级 `DB_VERSION` 并处理 `onupgradeneeded`。
- 修改完成后优先运行 `npm run build` 验证编译，再运行 `npm test` 验证测试；依赖有变化时运行 `npm run notices`。
