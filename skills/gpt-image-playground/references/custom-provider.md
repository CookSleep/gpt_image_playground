# 自定义服务商

自定义服务商是一份 Manifest，描述应用如何调用某个第三方图像 API：提交接口、请求体模板、异步任务的查询方式和结果图片的位置。

## 流程

1. 向用户要 API 文档链接或完整文档；能读链接就自己读。没有文档时不要猜测、不要编造占位配置。
2. 按下面的格式写出 Manifest，用 `provider save -` 从标准输入保存（新建时不带 `--id`；Manifest 中的 `id` 可以省略，应用会生成不重复的 id），记下结果中的服务商 id。
3. 用 `profile save` 新建配置：`provider` 为该服务商 id，填 `baseUrl`、`model`（文档没写默认模型时用 `gpt-image-2.6-sunburst`）、`apiMode: "images"`，用户给了 API Key 时填 `apiKey`。
4. 用一次低质量、单张的 `generate` 验证；失败时按错误调整 Manifest，用 `provider save - --id <服务商 id>` 整体替换。

修改已有服务商时先用 `settings --json` 取出 `custom_providers` 中的原内容，改好后整体替换。

## Manifest 格式

每个元素的顶层字段：id、name、submit、editSubmit、poll。
id 是服务商的唯一标识，用于 profiles 中的 provider 字段引用，建议使用 custom-{英文短名} 格式。
submit 是文生图提交配置，必填。
editSubmit 是图生图或局部重绘提交配置，可选。如果文生图和图生图使用同一个 JSON 接口，可以省略 editSubmit，并在 submit.body 中加入 image_urls。
poll 是异步任务查询配置，可选；同步接口不要写 poll。

submit/editSubmit 字段：
- path：接口路径，不带开头斜杠，不带 /v1/ 前缀，例如 images/generations 或 tasks/{task_id}。
- method：GET 或 POST，默认 POST。
- contentType：json 或 multipart。
- query：提交 query 参数对象，可选，例如 {"async":"true"}。
- body：请求体模板对象。
- files：multipart 文件字段数组，仅 contentType=multipart 时使用。
- taskIdPath：提交响应里的任务 ID JSON 路径；同步接口不要写。
- result：同步响应图片提取规则。

poll 字段：
- path：任务查询路径，使用 {task_id} 占位，例如 images/tasks/{task_id} 或 tasks/{task_id}。
- method：GET 或 POST，默认 GET。
- query：查询 query 参数对象，可选。
- intervalSeconds：轮询间隔秒数。
- statusPath：查询响应状态字段路径。
- successValues：成功状态值数组。
- failureValues：失败状态值数组。
- errorPath：失败原因路径，可选。
- result：成功后图片提取规则。

result 字段：
- imageUrlPaths：图片 URL 路径数组，支持 * 通配数组。例如 data.*.url、data.result.images.*.url.*。
- b64JsonPaths：base64 图片路径数组，支持 * 通配数组。例如 data.*.b64_json。

body 模板变量：
- $profile.model：用户在设置里填写的模型 ID。
- $prompt：当前提示词。
- $params.size、$params.quality、$params.output_format、$params.output_compression、$params.moderation、$params.n：应用内参数。
- $params.complexity、$params.frame_count、$params.frame_duration_ms、$params.svg：GPT Image 2.6 参数，只在模型 ID 为 GPT Image 2.6 及以上时可用；复杂度选 auto 时省略 complexity，帧参数只在输出 GIF 时传入，svg 只在输出 SVG 时传入，值为 {"model":"SVG 编写模型 ID"}。
- $params.background：API 原生透明背景参数；启用时为 `"transparent"`，未启用时自动省略。
- $inputImages.dataUrls：参考图 data URL 数组；没有参考图时会自动省略该字段。
- $inputImages.base64：参考图 base64 数组，不含 `data:image/png;base64,` 前缀；没有参考图时会自动省略该字段。
- $inputImages.urls：参考图链接数组，只包含在输入框「+ → 添加链接」中添加的参考图；没有时会自动省略该字段。配置只用它传参考图时，如果有参考图不是通过链接添加的，提交会报错。
- $mask.dataUrl：遮罩图 data URL；没有遮罩时会自动省略该字段。

multipart files 示例：
- {"field":"image[]","source":"inputImages","array":true}
- {"field":"mask","source":"mask"}

## 示例

以下是应用导入格式的示例：`customProviders` 中的每个元素就是 `provider save` 的 `<JSON>`，`profiles` 中的字段对应 `profile save` 的 `<JSON>`。

## 同步接口示例
{"customProviders":[{"id":"custom-example-sync","name":"示例同步服务商","submit":{"path":"images/generations","method":"POST","contentType":"json","body":{"model":"$profile.model","prompt":"$prompt","size":"$params.size","quality":"$params.quality","output_format":"$params.output_format","moderation":"$params.moderation","output_compression":"$params.output_compression","n":"$params.n","background":"$params.background"},"result":{"imageUrlPaths":["data.*.url"],"b64JsonPaths":["data.*.b64_json"]}},"editSubmit":{"path":"images/edits","method":"POST","contentType":"multipart","body":{"model":"$profile.model","prompt":"$prompt","size":"$params.size","quality":"$params.quality","output_format":"$params.output_format","moderation":"$params.moderation","output_compression":"$params.output_compression","n":"$params.n","background":"$params.background"},"files":[{"field":"image[]","source":"inputImages","array":true},{"field":"mask","source":"mask"}],"result":{"imageUrlPaths":["data.*.url"],"b64JsonPaths":["data.*.b64_json"]}}}],"profiles":[{"id":"custom-example-sync-profile","name":"示例同步服务商","provider":"custom-example-sync","baseUrl":"https://api.example.com/v1","model":"gpt-image-2.6-sunburst","apiMode":"images"}]}

## 异步接口示例
{"customProviders":[{"id":"custom-example-async","name":"示例异步服务商","submit":{"path":"images/generations","method":"POST","contentType":"json","query":{"async":"true"},"body":{"model":"$profile.model","prompt":"$prompt","size":"$params.size","n":"$params.n","background":"$params.background"},"taskIdPath":"data"},"editSubmit":{"path":"images/edits","method":"POST","contentType":"multipart","query":{"async":"true"},"body":{"model":"$profile.model","prompt":"$prompt","size":"$params.size","n":"$params.n","background":"$params.background"},"files":[{"field":"image[]","source":"inputImages","array":true}],"taskIdPath":"data"},"poll":{"path":"images/tasks/{task_id}","method":"GET","intervalSeconds":5,"statusPath":"data.status","successValues":["SUCCESS"],"failureValues":["FAILURE"],"errorPath":"data.fail_reason","result":{"imageUrlPaths":["data.data.data.*.url"],"b64JsonPaths":["data.data.data.*.b64_json"]}}}],"profiles":[{"id":"custom-example-async-profile","name":"示例异步服务商","provider":"custom-example-async","baseUrl":"","model":"gpt-image-2.6-sunburst","apiMode":"images"}]}

## 统一任务接口示例
{"customProviders":[{"id":"custom-example-task","name":"示例任务服务商","submit":{"path":"images/generations","method":"POST","contentType":"json","body":{"model":"$profile.model","prompt":"$prompt","n":"$params.n","size":"$params.size","resolution":"2k","quality":"$params.quality","image_urls":"$inputImages.dataUrls"},"taskIdPath":"data.0.task_id"},"poll":{"path":"tasks/{task_id}","method":"GET","query":{"language":"zh"},"intervalSeconds":5,"statusPath":"data.status","successValues":["completed"],"failureValues":["failed","cancelled"],"errorPath":"data.error.message","result":{"imageUrlPaths":["data.result.images.*.url.*"],"b64JsonPaths":[]}}}],"profiles":[{"id":"custom-example-task-profile","name":"示例任务服务商","provider":"custom-example-task","baseUrl":"","model":"gpt-image-2.6-sunburst","apiMode":"images"}]}
