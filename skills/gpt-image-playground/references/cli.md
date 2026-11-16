# gpt-image-playground CLI 参考

只有安装时勾选了“添加到 PATH”才能直接输入 `gpt-image-playground`（改了 PATH 后要重新打开终端），否则用完整路径，默认是 `%LOCALAPPDATA%\GPT Image Playground\bin\gpt-image-playground.exe`。

每条命令都交给正在运行的应用执行，应用需要保持打开。`-h` / `--help` 显示用法，`--version` 显示版本。

## parameters

```
gpt-image-playground parameters [--profile <配置 ID>] [--model <模型 ID>] [--all]
                                [--format <格式>] [--with-images] [--json]
```

查询与应用参数面板共用的选项。默认查询 `generate` 使用的当前配置和模型；`--profile` 查询指定配置，`--model` 查询该配置中的指定模型（省略时查询已选中的模型），`--all` 列出全部配置及其全部模型。`--all` 不与 `--profile`、`--model` 同用。

可用参数、可选值和数量上限会随配置、模型、是否带参考图及输出格式变化。例如，fal.ai 的参考图编辑不能选择 SVG，JPEG 输出不能开启透明背景。

默认按“无参考图、使用已保存的输出格式”查询。准备带参考图生成时，加 `--with-images`；准备使用其他输出格式时，加 `--format <格式>`，两项可以同时使用。返回的是这些条件下的参数选项，查询本身不修改设置。

JSON 的 `profiles[].models[]` 包含：

- `model`、`size_mode`：模型和尺寸选择方式。`pixels` 使用具体宽高，`aspect-ratio` 分别选择比例与档位，`seedream` 还支持自动比例和自定义宽高；各模式的设置方法见 [生图参数](settings.md#生图参数params)。
- `parameters`：按参数名列出的描述。`value` 是已保存的参数按目标配置和查询条件调整后的值，例如目标配置不支持已保存的 SVG 格式时，会返回 PNG。`visible` 表示界面是否展示该项，`enabled` 表示当前条件下是否可设置，`disabled_reason` 说明禁用原因。
- 枚举参数的 `options` 含各项 `value`、`label`、`enabled` 和必要的 `disabled_reason`。数值参数有 `min`、`max`；`nullable` 表示可以传 `null`；`hint` 提供填写说明。`size.options` 是常用尺寸，仍可输入自定义宽高。
- `reference_images.max` 是参考图上限；`mask` 表示界面的遮罩可用状态，CLI 暂无上传遮罩的参数。

**查询结果示例**：配置使用字节跳动供应商（`provider: "bytedance"`）的 Seedream 5.5，当前选择 2K、1 张 PNG，不带参考图。执行 `parameters --json` 后，模型信息片段如下：

```json
{
  "model": "doubao-seedream-5-5-261028",
  "size_mode": "seedream",
  "parameters": {
    "resolution": {
      "type": "enum",
      "value": "2K",
      "visible": true,
      "enabled": true,
      "options": [
        { "value": "1K", "label": "1K", "enabled": true },
        { "value": "1.5K", "label": "1.5K", "enabled": true },
        { "value": "2K", "label": "2K", "enabled": true }
      ]
    },
    "n": {
      "type": "integer",
      "value": 1,
      "visible": true,
      "enabled": true,
      "min": 1,
      "max": 10
    }
  }
}
```

这份示例结果中，`value` 表示当前选择了 2K、1 张；`options` 给出了该配置的三个可选档位，`min`、`max` 给出了生成数量范围。

## generate

```
gpt-image-playground generate <提示词> [--prompt <提示词>]… [--image <图片>]… [--size <尺寸>]
                              [--aspect-ratio <比例>] [--resolution <档位>]
                              [--quality <质量>] [--complexity auto|low|medium|high] [-n <数量>]
                              [--format png|jpeg|webp|svg|gif] [--frames <2-16>] [--frame-duration <20-2000>]
                              [--compression <0-100>] [--moderation auto|low] [--transparent] [--output <目录>] [--json]
```

以下说明参数写法；当前配置的可选值用 `parameters --json` 查询，其他生图参数可通过 `settings set params.<键> <值>` 设置，见 [设置项说明](settings.md)。

| 参数 | 说明 |
|---|---|
| `<提示词>` | 可以不加引号直接写多个词 |
| `--prompt` | 再加一条提示词，可重复；多条按应用的批量方式提交，一条失败不影响其他 |
| `--image` | 参考图，可重复：本机图片（png、jpg、webp、gif，相对路径按当前目录）或历史记录中的图片 ID；数量上限按当前启用的模型确定，超限时返回错误，不创建任务 |
| `--size` | 具体宽高，如 `1536x1024`，或 `auto`；内置 Seedream 尺寸模式还可填写档位。自定义比例与档位模式应使用下方两个参数 |
| `--aspect-ratio`、`--resolution` | 比例与分辨率档位，如 `16:9`、`2K`，取值以当前模型或自定义服务商的尺寸选项为准；不与 `--size` 同时使用 |
| `--quality` | 质量档位，取 `parameters.quality.options` 中可用的值 |
| `--complexity` | 模型渲染前的规划程度，是否可用见 `parameters.complexity` |
| `-n` | 每个任务的张数 |
| `--format`、`--compression` | 输出格式及压缩质量，取值见 `parameters.output_format`、`parameters.output_compression` |
| `--frames`、`--frame-duration` | GIF 的帧数和每帧毫秒数，默认 9 帧、200 ms |
| `--moderation` | `auto` 或 `low` |
| `--transparent` | 透明背景，不支持 `jpeg`；自定义供应商未映射 `$params.background` 时 `svg`、`gif` 也不支持 |
| `--output` | 把结果图片另外复制到这个目录，不存在时创建；文件名为 `task-<任务 ID>`，一个任务有多张时加 `-01`、`-02` |

省略的生图参数沿用应用已保存的值；命令中给出的生图参数会保存，供后续生成使用。批量任务进行中时应用不接受新的生图。

**查询与生成示例**：假设当前配置支持参考图编辑和 JPEG 输出，先查询这两个条件下的可用参数，再提交生成：

```
gpt-image-playground parameters --with-images --format jpeg --json
gpt-image-playground generate 把背景换成海边 --image D:\图片\猫.png --format jpeg
```

提交成功后先在 stderr 输出一行 `已提交任务：<任务 ID>、…`，全部任务结束后输出每个任务的结果和图片路径。图片路径指向应用数据目录中的文件（文件名是图片 ID），只读，不要改动、移动或删除。

JSON：

```json
{"tasks":[{"task_id":"…","status":"done","image_ids":["…"],"files":["…"],"failed_images":0}],"submitted":1,"requested":1,"files":["…"]}
```

- `status` 为 `done`、`error`（另有 `error` 写明原因）或 `deleted`（完成前被用户删除）。
- `submitted` 小于 `requested` 表示批量提交中途被停止。
- 加了 `--output` 时另有 `copied`，为复制后的路径。
- 每个成功任务另有 `outputs`，逐项尺寸及失败记录的格式见下方 `history`。
- 全部任务失败时按出错处理。

## history

```
gpt-image-playground history [<任务 ID>…] [--limit <数量>] [--offset <数量>] [--json]
```

按时间倒序列出任务：任务 ID、状态、提示词、参数、API 配置、模型、创建时间、参考图与结果的图片 ID、图片路径、失败原因。`--limit` 为 1–50，默认 10；`--offset` 跳过前面的任务，用于翻页。给出任务 ID 时只列出这些任务，不受 `--limit` 限制，找不到的列在 `missing` 中。

`params` 是请求参数；`outputs` 按结果顺序列出图片和失败记录，`index` 从 1 开始：

```json
[{"index":1,"image_id":"…","width":1024,"height":1024,"aspect_ratio":"1:1","resolution":"1K"},{"index":2,"error":"生成失败"}]
```

成功项包含 `image_id`、`width`、`height`、`aspect_ratio` 和 `resolution`；失败项包含 `error`。图片宽高来自保存的文件，比例和档位据此推算；无法读取图片尺寸时，成功项的四个尺寸字段为 `null`。

## result delete

```
gpt-image-playground result delete <任务 ID> <结果序号> [--json]
```

删除已完成任务中的一张图片或一项失败记录，序号取自 `history` 的 `outputs[].index`。最后一项不能单独删除，需要在应用中删除整个任务。删除后序号会变化，再次删除前应重新读取 `history`。

删除这项结果后，如果图片仍被其他任务或对话使用，图片文件会保留。JSON：`{"task_id":"…","deleted_index":2}`。

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

- `use` 切换启用的 API 配置，并使用该配置已选中的模型。
- `save` 不带 `--id` 时新建，新配置默认启用（`--no-activate` 不启用）；带 `--id` 时只改给出的字段，`--activate` 同时启用它。字段见 [settings.md](settings.md)，另可写 `apiKey`。
- `<JSON>` 写 `-` 时从标准输入读取，内容较长或带引号时更稳妥：

```
echo '{"name":"我的配置","baseUrl":"https://api.example.com/v1","apiKey":"…","model":"gpt-image-2"}' | gpt-image-playground profile save -
```

要切换配置中的模型，修改 `selectedModel`，值取自该配置的模型列表；加 `--activate` 可同时启用配置：

```
echo '{"selectedModel":"<模型 ID>"}' | gpt-image-playground profile save - --id <配置 ID> --activate
```

## provider

```
gpt-image-playground provider save <JSON> [--id <服务商 ID>] [--json]
gpt-image-playground provider delete <服务商 ID> [--json]
```

`<JSON>` 为服务商的 Manifest，见 [custom-provider.md](custom-provider.md)，同样可以写 `-` 从标准输入读取。带 `--id` 时用提交的完整 Manifest 替换原定义；修改前可用 `settings --json` 读取 `custom_providers` 中的原定义。删除后，使用它的 API 配置切回 OpenAI 兼容接口。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 出错：应用没有运行，或应用返回错误（如参数不合法、生图全部失败）；原因写在 stderr |
| 2 | 参数不对；原因写在 stderr |

中断命令（Ctrl+C，或被 AI 工具终止）不会取消应用里已开始的任务。
