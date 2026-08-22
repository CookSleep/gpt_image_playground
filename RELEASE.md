## v0.7.6（2026-08-22）

### 新增
- 新增透明背景双模式：每个 API 配置可独立选择“API 原生”或“本地后处理”。API 原生模式会请求接口直接返回透明通道，本地后处理模式会生成纯色背景并在浏览器中去除。
- 新增 API 原生透明背景请求：支持 OpenAI 兼容的 Images 生成与编辑接口、Responses 图像工具，以及通过 Manifest 映射 `$params.background` 的自定义服务商。
- 新增 WebP 透明背景输出：画廊模式下 PNG 和 WebP 均可启用透明背景，本地后处理会按所选格式保存透明结果。
- 新增 `transparentBackgroundMethod` URL 参数和预置配置字段，支持通过分享链接和部署配置指定透明背景实现方式。
- 自定义服务商 Manifest 新增 `$params.background` 模板变量，映射后可使用 API 原生透明背景；未映射时仅可使用本地后处理。
