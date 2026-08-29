## ADDED Requirements

### Requirement: Project workspace uses an infinite image canvas
项目工作区左侧 SHALL 使用可裁剪的无限画布展示当前筛选范围内的图片节点，同时保留搜索、状态筛选、收藏筛选、Agent 面板和底部输入流程。

#### Scenario: Open a project with completed outputs
- **WHEN** 用户打开包含已完成输出的项目
- **THEN** 工作区显示无限画布，并将每张输出图渲染为独立图片节点
- **AND** 右侧 Agent 面板和现有项目控制区保持可用

#### Scenario: Apply existing search or status filters
- **WHEN** 用户修改搜索词、状态筛选或收藏筛选
- **THEN** 画布只显示匹配的图片节点
- **AND** 未匹配节点的已保存位置不会被重置

### Requirement: Canvas nodes represent individual outputs and statuses
每张 `outputImages` 输出 SHALL 作为独立节点派生；生成中或失败的输出 SHALL 以独立状态节点显示；参考图 SHALL 仅在图片信息中显示，不得自动生成画布节点。

#### Scenario: A task returns multiple images
- **WHEN** 一个多图任务完成并包含多张输出
- **THEN** 画布显示多个互相独立的节点
- **AND** 每个节点都有稳定的 `imageId` 和所属父任务标识

#### Scenario: A task is running or partially failed
- **WHEN** 任务仍在生成或部分输出失败
- **THEN** 每个预期输出位置显示独立的加载或失败状态
- **AND** 已完成的输出仍可单独选择和操作

#### Scenario: Show references in image information
- **WHEN** 用户打开图片详情
- **THEN** 详情显示该图片所属任务的参考图
- **AND** 参考图不会出现在画布平铺列表中

### Requirement: Canvas supports pan, zoom, node movement, and selection
画布 SHALL 支持背景平移、围绕指针的滚轮缩放、双指缩放/平移、拖动图片节点，以及单击选择和点击空白取消选择。

#### Scenario: Pan the canvas background
- **WHEN** 用户在空白画布区域拖动
- **THEN** 画布视口随指针移动
- **AND** 图片节点之间的世界坐标关系保持不变

#### Scenario: Zoom around the pointer
- **WHEN** 用户在画布上滚轮缩放
- **THEN** 缩放中心保持在滚轮指针附近
- **AND** 已选图片的工具条仍定位在图片上方

#### Scenario: Move an image node
- **WHEN** 用户拖动图片节点
- **THEN** 只有该图片节点移动到新的世界坐标
- **AND** 松开指针后新位置被标记为待持久化

#### Scenario: Select and clear selection
- **WHEN** 用户单击图片节点
- **THEN** 该图片成为唯一选中对象并显示工具条
- **WHEN** 用户单击空白区域
- **THEN** 当前选中状态被清除

### Requirement: Selected-image toolbar remains usable at every zoom
选中图片的工具条 SHALL 固定为屏幕像素尺寸，显示在图片上方，并在图片靠近视口边缘时自动调整位置以保持可见。

#### Scenario: Select a zoomed image
- **WHEN** 用户在任意缩放比例下选中图片
- **THEN** 工具条以可读的固定尺寸显示在图片上方
- **AND** 工具条不会随世界缩放而缩小到不可操作

#### Scenario: Selected image is near an edge
- **WHEN** 图片上方空间不足或图片靠近视口边缘
- **THEN** 工具条在不遮挡主要图片内容的前提下调整到可见区域

### Requirement: Canvas state is persisted per project
项目 SHALL 持久化画布视口、图片节点位置/宽度和单图操作状态；旧项目或缺少布局的图片 SHALL 使用默认视口和确定性自动布局。

#### Scenario: Reopen a project
- **WHEN** 用户离开项目后再次打开
- **THEN** 画布恢复上次保存的视口和图片位置
- **AND** 已移动图片不会因为重新筛选或刷新而自动排列

#### Scenario: Load a legacy project
- **WHEN** 项目记录没有画布字段
- **THEN** 系统使用默认视口并按确定性网格排列图片
- **AND** 项目其余任务、收藏和 Agent 数据保持不变

#### Scenario: Export and import a project
- **WHEN** 用户导出后重新导入包含画布状态的项目
- **THEN** 视口、节点布局和单图状态一并恢复

### Requirement: Prompt text area uses compact default height
项目页纯文本提示输入区域 SHALL 使用比当前默认高度更紧凑的最小高度，同时允许多行输入和自动增长，不得遮挡附件或提交控件。

#### Scenario: Open the project input area
- **WHEN** 用户打开项目页输入区域
- **THEN** 纯文本区域以紧凑高度显示
- **AND** 输入框、附件和提交控件在桌面端及移动端均保持可见

#### Scenario: Enter multiline prompt
- **WHEN** 用户输入多行提示词
- **THEN** 输入区域按既有逻辑自动增长并显示完整文本
- **AND** 紧凑默认高度不会截断已输入内容
