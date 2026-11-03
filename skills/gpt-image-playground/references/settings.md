# 设置项说明

`settings --json` 输出的各部分及其修改方式。修改时只需给出要改的项。

## 生图参数（params）

首页输入框下方的参数，`generate` 给出的参数也会存到这里。修改：`settings set params.<键> <值>`。

| 键 | 取值 |
|---|---|
| `size` | 如 `1024x1024`、`1536x1024`、`1024x1536`，或 `auto` |
| `quality` | `auto`、`low`、`medium`、`high`、`xhigh`、`max`；`xhigh`、`max` 只在支持的模型上有效，其他模型降为 `high` |
| `output_format` | `png`、`jpeg`、`webp` |
| `output_compression` | 0–100，jpeg、webp 的压缩质量；`null` 为不指定 |
| `moderation` | `auto`、`low` |
| `n` | 每个任务生成的张数，上限取决于当前配置 |
| `transparent_output` | 透明背景，需要 png 或 webp |

## 偏好设置（settings）

修改：`settings set <键> <值>`。

| 键 | 含义 |
|---|---|
| `showBatchPrompt` | 在首页提供多提示词批量提交 |
| `batchPromptEnabled` | 开启批量提交：输入框中以空两行分隔的提示词拆成多个任务 |
| `batchPromptMode` | `queue` 逐条提交、`concurrent` 同时提交 |
| `batchPromptConcurrencyLimited`、`batchPromptConcurrency` | 同时提交时是否限制并发数、并发数 |
| `clearInputAfterSubmit` | 提交任务后清空输入框 |
| `persistInputOnRestart` | 重启后加载上次的输入框 |
| `enterSubmit` | 为真时按 Enter 提交，否则 Ctrl+Enter |
| `reuseTaskApiProfileTemporarily` | 复用某个任务的配置时，临时使用该任务的 API 配置 |
| `saveTasksToActiveFavoriteCollection` | 在收藏夹页新建或重试出的任务自动加入当前收藏夹，重试出的任务同时沿用原任务的收藏夹（总览和“全部收藏”中新建的任务加入默认收藏夹） |
| `alwaysShowRetryButton` | 成功的任务也显示重试按钮 |
| `retryMode` | 重试时 `new` 新建任务、`overwriteFailed` 覆盖失败的任务、`overwriteAll` 覆盖任何任务（需开启 `alwaysShowRetryButton`） |
| `allowPromptRewrite` | 允许模型改写优化提示词 |
| `referenceImageEditAction` | 参考图预览中“编辑图片”的默认行为：`ask` 每次询问、`sketch` 画板、`mask` 遮罩 |
| `taskCompletionNotification` | 任务完成或失败时发送系统通知 |
| `autoCheckUpdate` | 启动时检查新版本 |
| `writeLogFile` | 把警告和错误写入日志文件 |
| `saveLocationMode` | 下载时 `ask` 每次询问保存位置、`default` 直接保存到默认保存地址 |
| `zipDownloadRoutes` | 用压缩包批量下载的途径：`task-selection`（任务多选）、`favorite-collection-selection`（收藏夹多选）、`image-context-menu-all`（图片右键“下载全部”）、`task-detail-all`（任务详情“下载全部”）、`task-detail-partial`（任务详情中间步骤图）、`agent-round-all`（Agent 对话一轮的全部图片） |
| `privacyModeShortcut` | 切换隐私模式的快捷键，如 `Ctrl+Shift+H`；空字符串为禁用 |
| `colorMode` | `system`、`light`、`dark` |
| `uiFont`、`monoFont` | 界面、代码字体：`default`、`builtin`、`system`、`custom`；`custom` 时字体名写在 `uiFontName`、`monoFontName` |
| `providerOrder` | 服务商下拉列表的顺序（服务商 id 数组） |
| `agentApiConfigMode` | 应用内 Agent 对话使用的 API 配置：`off` 用当前配置、`native` 用独立的 Responses API 配置、`hybrid` 文本模型与图像模型分开 |
| `agentTextProfileId`、`agentImageProfileId` | Agent 对话的文本模型、图像模型所用的 API 配置 id |
| `agentWebSearch` | Agent 对话允许网络搜索 |
| `agentMaxToolRounds` | Agent 对话每轮最多调用工具的次数 |
| `agentMathFormattingPrompt` | Agent 对话附带公式输出提示 |
| `agentScrollToBottomAfterSubmit` | Agent 对话发送后滚动到底部 |

## API 配置（profiles）

修改：`profile save <JSON> --id <配置 ID>`，只写要改的字段。

| 字段 | 含义 |
|---|---|
| `name` | 配置名称 |
| `provider` | `openai`（OpenAI 兼容接口）、`sb2api-async`（sub2api 异步）、`fal`（fal.ai），或自定义服务商的 id。改服务商时，应用会恢复该配置在这个服务商下保存过的地址和模型 |
| `baseUrl` | API 地址，如 `https://api.openai.com/v1`。末尾带 `/` 时直接在该地址后拼接口路径，不补 `/v1` |
| `apiKey` | API Key，只能写入 |
| `model` | 模型 ID 列表，多个以 `, ` 分隔 |
| `selectedModel` | 首页选中的模型，必须在 `model` 列表中 |
| `apiMode` | `images`（Images API）或 `responses`（Responses API，需要支持 `image_generation` 工具的文本模型） |
| `imageGenerationModel` | Responses API 下 `image_generation` 工具使用的图像模型 |
| `reasoningEffort` | Responses API 的推理强度：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `timeout` | 请求超时（秒） |
| `streamImages`、`streamPartialImages` | 流式传输，及请求的中间步骤图数（0–3），仅 OpenAI 兼容接口 |
| `responseFormatB64Json` | 要求接口返回 Base64 图片数据 |
| `codexCli` | Codex CLI 兼容模式 |
| `apiProxy` | 使用部署端的 API 代理（网页版功能，客户端不使用） |
| `transparentBackgroundMethod` | 透明背景：`api` 接口原生、`local` 本地后处理 |

输出中每个配置另有只读的 `id`、`apiKeySet`（是否已填 API Key）、`models`（模型列表）、`active`（是否启用）、`preset`（是否预置）、`locked`（预置且锁定）。

## 网络代理（proxy）

- `mode`：`system` 跟随系统、`none` 不使用、`custom` 自定义。
- `url`：自定义时的代理地址，如 `http://127.0.0.1:7890`。

改为自定义时先 `settings set proxy.url <地址>`，再 `settings set proxy.mode custom`。

## 自定义服务商（custom_providers）

用 `provider save`、`provider delete` 修改，格式见 [custom-provider.md](custom-provider.md)。
