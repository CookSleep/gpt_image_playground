---
name: gpt-image-playground
description: Generate and edit images with the user's GPT Image Playground app on this Windows PC through its `gpt-image-playground` CLI, and read or change everything in the app's settings (API profiles and keys, models, providers, custom providers, image parameters, batch prompts, proxy and other preferences). Use when the user asks to draw, generate, edit or restyle an image, e.g. "画一张……", "生成一张图", "把这张图改成……", "用 GPT Image Playground 出图", or to look up past results in its history; also when they want to add or switch an API profile, set an API key, change the model, size, quality or other parameters, or configure a custom image API provider in the app.
---

# 用 GPT Image Playground 生图与修改设置

GPT Image Playground 是用户电脑上的生图应用。它的 CLI `gpt-image-playground` 操作的就是正在运行的应用：生图用应用里启用的 API 配置和参数，结果会出现在应用的历史记录中；修改设置与在设置页里操作一样，界面会立即更新。

## 调用方式

- 安装时勾选了“添加到 PATH”可以直接调用，否则写完整路径，默认是 `%LOCALAPPDATA%\GPT Image Playground\bin\gpt-image-playground.exe`。参数与 JSON 字段见 [references/cli.md](references/cli.md)。
- 应用需要保持打开。提示应用没有运行时，请用户打开后再试。

## 生图

```
gpt-image-playground generate 一只趴在键盘上的橘猫 --quality low
gpt-image-playground generate 把背景换成海边 --image D:\图片\猫.png --size 1536x1024
gpt-image-playground generate --prompt 春天的森林 --prompt 冬天的森林 -n 2
```

- `generate` 要等全部图片生成完才返回，常常需要几分钟，**一律放到后台运行**，结束后再读输出。
- 提交后先输出任务 ID，结束时输出每张图片的路径，可以直接打开查看。这些是应用数据目录里的文件，只读，不要改动、移动或删除；要另存一份，加 `--output <目录>`。
- 多个 `--prompt` 会按应用的批量方式一起提交。批量任务进行中时应用不接受新的生图，需要等它结束。
- `--image` 是参考图：本机图片的路径，或历史记录中的图片 ID，可以给多张。数量上限按当前启用的模型确定；超限时返回错误，不创建任务。
- `--size`、`--quality`、`-n` 等参数会保存为应用的参数，之后的生图都沿用；只想用一次时，生成后再改回去。
- 失败时输出原因。鉴权、额度、内容审核这类错误重试也没用，直接告诉用户。
- 命令被中断时，应用里的生成会继续：用 `history <任务 ID>…` 查看结果，不要重新生成。

## 历史记录

- `history` 按时间倒序列出任务，包括任务 ID、提示词、参数、图片 ID 和图片路径；`history <任务 ID>…` 只看这几个任务。
- `image <图片 ID 或任务 ID>` 输出图片的路径。
- 用户可以在应用的任务详情里复制任务 ID 和图片 ID 给你。

## 查看与修改设置

只在用户要求时修改，改之前说明要改什么；删除不能撤销，先确认。先用 `settings --json` 看当前值，各项含义见 [references/settings.md](references/settings.md)。

| 要做的事 | 命令 |
|---|---|
| 改偏好设置、生图参数、网络代理 | `settings set <键> <值>` |
| 切换启用的 API 配置 | `profile use <配置 ID>` |
| 新建 API 配置、修改配置或换模型、填写 API Key | `profile save <JSON>`（修改时加 `--id <配置 ID>`） |
| 删除 API 配置 | `profile delete <配置 ID>` |
| 接入第三方图像 API | 先 `provider save <JSON>`，再新建一个使用它的 API 配置，见 [references/custom-provider.md](references/custom-provider.md) |
| 删除自定义服务商 | `provider delete <服务商 ID>` |

- API Key 只能写入，读不到原值；不要在回复里复述用户给的 Key。
- 预置配置标有 `locked` 时只能改 API Key 和选中的模型。
- 应用会纠正不合法的值，以输出中实际保存的值为准。
- 清空数据、导入导出备份、更改数据目录只能在应用里操作。

## 须知

- 要解析结果时加 `--json`，非 ASCII 字符会转义为 `\uXXXX`，任何代码页下都能正确解析。
- Windows PowerShell 5.1 直接读取文本输出前，先执行 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`，否则中文会乱码。
- 退出码：0 成功，1 出错（应用没有运行、应用返回错误），2 参数不对；原因写在 stderr。
