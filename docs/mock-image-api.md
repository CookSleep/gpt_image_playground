# 本地故障模拟 API

这个脚本用于复现浏览器环境里的图片接口异常，重点覆盖跨域、响应结构异常、原始响应查看、原始图片 URL 复制等场景。

## 启动

```powershell
npm run mock:api
```

默认监听：`http://127.0.0.1:8787`。

如需修改端口：

```powershell
$env:MOCK_IMAGE_API_PORT="8788"; npm run mock:api
```

## OpenAI 兼容配置

在应用设置里创建普通 OpenAI 兼容配置：

- 服务商类型：OpenAI 兼容
- API 地址：按下方模式填写，例如 `http://127.0.0.1:8787/url-cors-block`
- API Key：任意非空字符串，例如 `mock`
- API 模式：`Images API`
- 模型：任意值，例如 `mock`

模拟服务会读取请求体里的 `n`，最多返回 10 条结果。把应用里的图片数量调到 2 或更多后，`url-cors-block` 这类模式会一次返回多个图片 URL，可用于测试“原始图片链接”弹窗。

可用模式：

- `http://127.0.0.1:8787/url-cors-block`：API 请求成功，但返回的图片 URL 没有 CORS 头，浏览器下载图片时失败。
- `http://127.0.0.1:8787/url-ok`：API 请求成功，图片 URL 有 CORS 头，应该生成成功。
- `http://127.0.0.1:8787/b64`：API 直接返回 `b64_json`，应该生成成功。
- `http://127.0.0.1:8787/wrong-shape`：返回类似 `data.url` 的非 OpenAI JSON，不符合 OpenAI `data[]` 结构，应显示“查看原始响应内容”。
- `http://127.0.0.1:8787/no-recognizable`：返回 `data[]`，但没有 `url` 或 `b64_json`，应显示“查看原始响应内容”。
- `http://127.0.0.1:8787/empty`：返回空 `data[]`，应显示“查看原始响应内容”。
- `http://127.0.0.1:8787/url-404`：返回图片 URL，但图片下载 HTTP 404。
- `http://127.0.0.1:8787/url-redirect-cors-block`：返回重定向图片 URL，最终图片没有 CORS 头。
- `http://127.0.0.1:8787/http-error`：API 返回 HTTP 500 和错误消息。
- `http://127.0.0.1:8787/invalid-json`：API 返回非法 JSON。
- `http://127.0.0.1:8787/slow`：API 延迟返回，可把配置里的超时时间调低来测试超时。
- `http://127.0.0.1:8787/api-no-cors`：API 本身不返回 CORS 头，浏览器应在 API 请求阶段失败。
- `http://127.0.0.1:8787/alternating-http-error`：每隔一次请求返回 HTTP 500，可配合多图并发测试“部分失败”。

流式传输相关模式需要在配置里开启“流式传输”：

- `http://127.0.0.1:8787/stream-unsupported`：流式请求返回 HTTP 400 文本错误，应提示关闭流式传输。
- `http://127.0.0.1:8787/stream-invalid-json`：SSE `data:` 事件不是合法 JSON，应提示流式数据格式无法解析。
- `http://127.0.0.1:8787/stream-no-data`：返回 `text/event-stream`，但没有有效 `data:` 事件。
- `http://127.0.0.1:8787/stream-failed-event`：SSE 返回 `*.failed` 事件。
- `http://127.0.0.1:8787/stream-error-object`：SSE 返回 `{ "error": { "message": ... } }`。
- `http://127.0.0.1:8787/stream-no-final`：SSE 只返回中间图，不返回最终图片。
- `http://127.0.0.1:8787/stream-no-usable`：SSE 返回完成事件，但没有可用图片数据。

如果使用 `Responses API` 模式，同样可以使用上面的路径。`empty`、`no-recognizable`、`wrong-shape` 会返回无法提取图片的 Responses 结构。

## 自定义服务商配置

可以导入下面的自定义服务商，用于模拟非 OpenAI 结构的图片 JSON：

```json
{
  "id": "mock-failure-api",
  "name": "本地故障模拟",
  "template": "http-image",
  "submit": {
    "path": "custom/random-image",
    "method": "POST",
    "contentType": "json",
    "body": {
      "model": "$profile.model",
      "prompt": "$prompt",
      "size": "$params.size",
      "quality": "$params.quality",
      "output_format": "$params.output_format",
      "n": "$params.n"
    },
    "result": {
      "imageUrlPaths": ["data.url", "data.images.*.url"],
      "b64JsonPaths": []
    }
  }
}
```

导入后创建 API 配置：

- 服务商类型：`本地故障模拟`
- API 地址：`http://127.0.0.1:8787`
- API Key：任意非空字符串，例如 `mock`
- 模型：可填 `mock:url-cors-block`、`mock:url-ok`、`mock:no-recognizable` 或 `mock:http-error`

测试重点：

- `mock:url-cors-block`：自定义服务商能提取 `data.url`，但图片下载因跨域失败，应显示原始图片 URL 操作。
- `mock:url-cors-block` 且图片数量大于 1：自定义服务商会返回 `data.images[]`，应显示包含多个 URL 的弹窗。
- `mock:url-ok`：自定义服务商能提取 `data.url`，图片可下载，应该生成成功。
- `mock:no-recognizable`：响应没有可提取图片，应显示“查看原始响应内容”。
- `mock:http-error`：接口直接返回服务端错误。

## 自定义异步服务商配置

可以导入下面的自定义服务商，用于模拟提交后轮询的任务接口：

```json
{
  "id": "mock-async-failure-api",
  "name": "本地异步故障模拟",
  "template": "http-image",
  "submit": {
    "path": "custom/async-submit",
    "method": "POST",
    "contentType": "json",
    "body": {
      "model": "$profile.model",
      "prompt": "$prompt",
      "size": "$params.size",
      "quality": "$params.quality",
      "n": "$params.n"
    },
    "taskIdPath": "data"
  },
  "poll": {
    "path": "custom/tasks/{task_id}",
    "method": "GET",
    "intervalSeconds": 1,
    "statusPath": "data.status",
    "successValues": ["SUCCESS"],
    "failureValues": ["FAILURE"],
    "errorPath": "data.fail_reason",
    "result": {
      "imageUrlPaths": ["data.data.data.*.url"],
      "b64JsonPaths": ["data.data.data.*.b64_json"]
    }
  }
}
```

导入后创建 API 配置：

- 服务商类型：`本地异步故障模拟`
- API 地址：`http://127.0.0.1:8787`
- API Key：任意非空字符串，例如 `mock`
- 模型：可填 `mock:url-cors-block`、`mock:url-ok`、`mock:b64`、`mock:async-failure`、`mock:async-no-task-id` 或 `mock:async-empty`

测试重点：

- `mock:url-ok`：提交返回任务 ID，轮询成功并返回可下载图片。
- `mock:b64`：提交返回任务 ID，轮询成功并返回 `b64_json`。
- `mock:async-failure`：轮询返回失败状态，并从 `data.fail_reason` 取错误消息。
- `mock:async-no-task-id`：提交成功但缺少任务 ID，应显示原始响应内容。
- `mock:async-empty`：轮询成功但没有可提取图片，应显示原始响应内容。
