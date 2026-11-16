# 自定义服务商

自定义服务商是一份 Manifest，描述应用如何调用某个第三方图像 API：提交接口、请求体模板、异步任务的查询方式和结果图片的位置。

## 流程

1. 获取用户提供的 API 文档链接或完整文档，读取其中的接口说明。
2. 按下面的格式写出 Manifest，用 `provider save -` 从标准输入保存（新建时不带 `--id`；Manifest 中的 `id` 可以省略，应用会生成不重复的 id），记下结果中的服务商 id。
3. 用 `profile save` 新建配置：`provider` 为该服务商 id，填 `baseUrl`、`model`（文档没写默认模型时用 `gpt-image-2.6-sunburst`）、`apiMode: "images"`，用户给了 API Key 时填 `apiKey`。
4. 按该接口文档选择可用参数，用单张 `generate` 验证。失败时按错误调整 Manifest，用 `provider save - --id <服务商 id>` 整体替换。

修改已有服务商时先用 `settings --json` 取出 `custom_providers` 中的原内容，改好后整体替换。

## Manifest 格式

每个元素的顶层字段：id、name、imageSize、submit、editSubmit、poll、modelOverrides。
id 是服务商的唯一标识，用于 profiles 中的 provider 字段引用，建议使用 custom-{英文短名} 格式。
submit 是文生图提交配置，必填。
editSubmit 是带参考图或遮罩时使用的提交配置。省略时仍使用 submit，因此共用一个接口时，应在 submit 中同时映射参考图或遮罩参数。
poll 是异步任务查询配置，可选；同步接口不要写 poll。
modelOverrides 为不同模型设置接口和尺寸选项。每项包含 models（模型 ID 数组，支持 * 通配符）、submit，以及可选的 editSubmit、poll、imageSize。
- 按顺序使用首个匹配项；没有匹配项时使用顶层配置。
- 匹配项的 submit 和 editSubmit 替换顶层提交配置。该项省略 editSubmit 时，参考图编辑也使用该项的 submit。
- 匹配项省略 poll 或 imageSize 时，沿用顶层对应字段。

imageSize 设置用户在生图参数栏中如何选择图片尺寸，可写在供应商顶层，也可在 modelOverrides 中为不同模型分别设置。不写时保留该模型原有的尺寸选择方式。比例和档位选项按接口文档填写。
- {"mode":"pixels"}：让用户选择或输入具体宽高，例如 1536x1024。
- {"mode":"aspect-ratio","ratios":["auto","1:1","16:9"],"resolutions":["1K","2K","4K"]}：显示“比例”和“分辨率”两个下拉框。此例允许选择自动、1:1 或 16:9，以及 1K、2K 或 4K；两个数组均须非空，第一项为默认选项。
- 用户选择 16:9 和 2K 后，$params.aspect_ratio 为 "16:9"，$params.resolution 为 "2K"；在 body 中将它们映射到接口要求的字段，例如 {"aspect_ratio":"$params.aspect_ratio","resolution":"$resolution.lower"} 会发送 {"aspect_ratio":"16:9","resolution":"2k"}。
- 档位名称统一保存为大写；切换配置后，原值不在新选项中时使用第一项。imageSize 只决定尺寸选项，质量等参数仍按模型原有规则处理。

submit/editSubmit 字段：
- path：接口路径，不带开头斜杠，不带 /v1/ 前缀，支持 {model} 占位符，例如 images/generations 或 generateTask/{model}。任务查询路径如 tasks/{task_id} 配置在 poll.path。
- method：GET 或 POST，默认 POST。
- contentType：json 或 multipart。
- query：提交 query 参数对象，可选，例如 {"async":"true"}。
- body：请求体模板对象。
- omitValues：键是模板变量名，值是要省略的取值列表；变量命中列表时，省略引用它的字段或数组元素。例如 body 为 {"quality":"$params.quality"}，omitValues 为 {"$params.quality":["auto"]} 时，选择 auto 不发送 quality 字段，使用接口默认质量；选择 high 则发送 {"quality":"high"}。
- 省略规则只作用于同一个 submit 或 editSubmit 的 body 和 query，支持 JSON 和 multipart。只省略与列表中值及类型均相同的变量值（例如数字 0 与字符串 "0" 不同）；直接写在模板里的固定值不受影响。不配置 omitValues 时，按模板原样发送。
- files：multipart 文件字段数组，仅 contentType=multipart 时使用。
- taskIdPath：提交响应里的任务 ID JSON 路径；同步接口不要写。
- result：同步响应图片提取规则。

poll 字段：
- path：接口路径，不带开头斜杠，不带 /v1/ 前缀，支持 {task_id}、{taskId} 和 {model} 占位符，例如 images/tasks/{task_id}、tasks/{task_id} 或 statusTask/{model}。
- method：GET 或 POST，默认 GET。
- query：查询 query 参数对象，可选，值支持 {task_id}、{taskId} 和 {model} 占位符。
- intervalSeconds：轮询间隔秒数。
- statusPath：查询响应状态字段路径。
- successValues：成功状态值数组。
- failureValues：失败状态值数组。
- errorPath：失败原因路径，可选。
- result：成功后图片提取规则。

result 字段：
- imageUrlPaths：图片 URL 路径数组，支持 * 通配数组。例如 data.*.url、data.result.images.*.url.*。
- b64JsonPaths：base64 图片路径数组，支持 * 通配数组。例如 data.*.b64_json。
- 路径经过 JSON 字符串时自动解析，例如 data.resultJson.resultUrls.*。

body 与提交 query 可用的模板变量：
- $profile.model：用户在设置里填写的模型 ID。
- $prompt：当前提示词。
- $mode：没有参考图时为 text-to-image，有参考图时为 image-to-image。
- $params.aspect_ratio：用户选择的比例，例如 "16:9" 或 "auto"，用于支持比例选择的模型或自定义尺寸配置。
- $params.resolution：用户选择的分辨率档位，例如 "2K"。
- $params.size：模型原有的尺寸参数。普通宽高模式下为 "1536x1024" 或 "auto"；Gemini、Grok 等比例模式下可能为 "16:9"；Seedream 5.5 为 "2K" 等档位或 "2048x1152" 等具体宽高。接口只接受具体宽高时使用 $size.pixels。
- $params.watermark：Seedream 5.5 的水印开关，布尔值，默认为 false。
- $params.google_search、$params.image_search：Google Search、Image Search 开关（布尔值）；映射后可在 Gemini 模型的“搜索”参数中切换。
- $params.thinking_level：Gemini 的思考等级，默认不发送；映射后可在参数栏中选择。
- $resolution.upper、$resolution.lower：同一个分辨率档位的大小写形式。用户选择 2K 时，分别得到 "2K"、"2k"，按接口要求选用。
- $size.pixels：请求中已确定的具体宽高，格式为“宽x高”。模板 {"size":"$size.pixels"} 在尺寸为 2048x1152 时发送 {"size":"2048x1152"}；只有档位或比例、尚无具体宽高时，不发送 size 字段。Seedream 固定比例计算出的宽高也可通过此变量发送，其他已映射的参数照常发送。
- $params.quality：应用处理后的质量值，例如 "auto"、"high"；应用对 Grok Imagine Image 2.0 提供 auto、low 或 medium，对 Gemini、Seedream 5.5 和其余 Grok 图像模型省略此值。
- $params.output_format、$params.output_compression、$params.moderation：用户选择的输出格式、压缩质量与审核等级。
- $params.n：用户选择的生成数量。
- $params.complexity、$params.frame_count、$params.frame_duration_ms、$params.svg：GPT Image 2.6 参数，只在模型 ID 为 GPT Image 2.6 及以上时可用；复杂度选 auto 时省略 complexity，帧参数只在输出 GIF 时传入，svg 只在输出 SVG 时传入，值为 {"model":"SVG 编写模型 ID"}；配置了 SVG 推理强度时另含 "reasoning":{"effort":"推理强度"}。
- $params.background：Seedream 5.5 为 auto（默认）、transparent 或 opaque；选择本地后处理且开启透明背景时为 opaque。其他模型仅在启用 API 原生透明背景时为 transparent，否则省略。
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
