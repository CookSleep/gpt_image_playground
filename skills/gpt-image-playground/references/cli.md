# gpt-image-playground CLI 参考

只有安装时勾选了“添加到 PATH”才能直接输入 `gpt-image-playground`（改了 PATH 后要重新打开终端），否则用完整路径，默认是 `%LOCALAPPDATA%\GPT Image Playground\bin\gpt-image-playground.exe`。

每条命令都交给正在运行的应用执行，应用需要保持打开。`-h` / `--help` 显示用法，`--version` 显示版本。

## generate

```
gpt-image-playground generate <提示词> [--prompt <提示词>]… [--image <图片>]… [--size <尺寸>]
                              [--quality <质量>] [--complexity auto|low|medium|high] [-n <数量>]
                              [--format png|jpeg|webp|svg|gif] [--frames <2-16>] [--frame-duration <20-2000>]
                              [--compression <0-100>] [--moderation auto|low] [--transparent] [--output <目录>] [--json]
```

| 参数 | 说明 |
|---|---|
| `<提示词>` | 可以不加引号直接写多个词 |
| `--prompt` | 再加一条提示词，可重复；多条按应用的批量方式提交，一条失败不影响其他 |
| `--image` | 参考图，可重复，最多 16 张：本机图片（png、jpg、webp、gif，相对路径按当前目录）或历史记录中的图片 ID |
| `--size` | 如 `1024x1024`、`1536x1024`、`1024x1536`、`auto` |
| `--quality` | `auto`、`low`、`medium`、`high`、`xhigh`、`max`；`xhigh`、`max` 只有部分模型支持，其余按 `high` |
| `--complexity` | 模型渲染前的规划程度，只有 GPT Image 2.6 支持，其他模型按 `auto`（不发送）处理 |
| `-n` | 每个任务的张数 |
| `--format`、`--compression` | 输出格式；`jpeg`、`webp` 的压缩质量 0–100。`svg`、`gif` 只有 GPT Image 2.6 支持，`svg` 只能文生图，`gif` 也可用于参考图编辑 |
| `--frames`、`--frame-duration` | GIF 的帧数和每帧毫秒数，默认 9 帧、200 ms |
| `--moderation` | `auto` 或 `low` |
| `--transparent` | 透明背景，不支持 `jpeg`；自定义供应商未映射 `$params.background` 时 `svg`、`gif` 也不支持 |
| `--output` | 把结果图片另外复制到这个目录，不存在时创建；文件名为 `task-<任务 ID>`，一个任务有多张时加 `-01`、`-02` |

给出的参数会保存为应用的参数。批量任务进行中时应用不接受新的生图。

提交成功后先在 stderr 输出一行 `已提交任务：<任务 ID>、…`，全部任务结束后输出每个任务的结果和图片路径。图片路径指向应用数据目录中的文件（文件名是图片 ID），只读，不要改动、移动或删除。

JSON：

```json
{"tasks":[{"task_id":"…","status":"done","image_ids":["…"],"files":["…"],"failed_images":0}],"submitted":1,"requested":1,"files":["…"]}
```

- `status` 为 `done`、`error`（另有 `error` 写明原因）或 `deleted`（完成前被用户删除）。
- `submitted` 小于 `requested` 表示批量提交中途被停止。
- 加了 `--output` 时另有 `copied`，为复制后的路径。
- 全部任务失败时按出错处理。

## history

```
gpt-image-playground history [<任务 ID>…] [--limit <数量>] [--offset <数量>] [--json]
```

按时间倒序列出任务：任务 ID、状态、提示词、参数、API 配置、模型、创建时间、参考图与结果的图片 ID、图片路径、失败原因。`--limit` 为 1–50，默认 10；`--offset` 跳过前面的任务，用于翻页。给出任务 ID 时只列出这些任务，不受 `--limit` 限制，找不到的列在 `missing` 中。

## image

```
gpt-image-playground image <图片 ID 或任务 ID> [--output <目录>] [--json]
```

输出图片（给任务 ID 时为该任务的全部图片）的路径；`--output` 另外复制一份。JSON：`{"image_ids":[…],"files":[…]}`。

## settings

```
gpt-image-playground settings [--json]
gpt-image-playground settings set <键> <值> [--json]
```

`settings` 输出偏好设置、生图参数、启用的配置、API 配置（不含 API Key）、自定义服务商和代理，各项见 [settings.md](settings.md)。

`settings set` 的键有三种：

- 偏好设置直接写名称，如 `batchPromptConcurrency`。
- 生图参数加 `params.`，如 `params.quality`。
- 代理为 `proxy.mode`、`proxy.url`。

值的写法：开关写 `true` / `false`，数字直接写，列表写 JSON 数组（如 `'["a","b"]'`），其余写文字即可。要把数字当文字写入时，写成带引号的 JSON，如 `'"123"'`。

## profile

```
gpt-image-playground profile use <配置 ID> [--json]
gpt-image-playground profile save <JSON> [--id <配置 ID>] [--activate | --no-activate] [--json]
gpt-image-playground profile delete <配置 ID> [--json]
```

- `use` 切换启用的 API 配置。
- `save` 不带 `--id` 时新建，新配置默认启用（`--no-activate` 不启用）；带 `--id` 时只改给出的字段，`--activate` 同时启用它。字段见 [settings.md](settings.md)，另可写 `apiKey`。
- `<JSON>` 写 `-` 时从标准输入读取，内容较长或带引号时更稳妥：

```
echo '{"name":"我的配置","baseUrl":"https://api.example.com/v1","apiKey":"…","model":"gpt-image-2"}' | gpt-image-playground profile save -
```

## provider

```
gpt-image-playground provider save <JSON> [--id <服务商 ID>] [--json]
gpt-image-playground provider delete <服务商 ID> [--json]
```

`<JSON>` 为服务商的 Manifest，见 [custom-provider.md](custom-provider.md)，同样可以写 `-` 从标准输入读取。带 `--id` 时整体替换该服务商。删除后，使用它的 API 配置切回 OpenAI 兼容接口。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 出错：应用没有运行，或应用返回错误（如参数不合法、生图全部失败）；原因写在 stderr |
| 2 | 参数不对；原因写在 stderr |

中断命令（Ctrl+C，或被 AI 工具终止）不会取消应用里已开始的任务。
