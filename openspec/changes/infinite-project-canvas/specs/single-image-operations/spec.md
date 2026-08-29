## ADDED Requirements

### Requirement: Toolbar actions target one image
图片工具条中的查看、收藏、下载、复制、加入参考图、编辑输出、复用配置、保存到素材库、重试和删除 SHALL 接收并处理当前选中的单个 `imageId`，不得隐式操作同一任务的其他输出。

#### Scenario: Use an image-scoped action
- **WHEN** 用户对多图任务中的一张图片执行下载、复制、加入参考图或保存素材
- **THEN** 只有当前图片被处理
- **AND** 同任务的其他图片保持不变

#### Scenario: Reuse or edit the selected image
- **WHEN** 用户对图片执行复用配置或编辑输出
- **THEN** 系统使用该图片所属任务的提示词和参数
- **AND** 只将当前图片作为参考输入，不自动加入同任务其他输出

#### Scenario: Retry a failed image
- **WHEN** 用户对失败图片执行重试
- **THEN** 系统仅为该图片创建新的重试输出流程
- **AND** 其他已完成图片不会被重新生成或替换

### Requirement: Favorite state is stored per image
系统 SHALL 为每张图片保存独立的收藏状态和收藏夹关系；旧任务级收藏数据 SHALL 在加载时兼容映射，但新操作不得修改同任务其他图片的收藏状态。

#### Scenario: Favorite one output of a multi-image task
- **WHEN** 用户收藏多图任务中的一张图片
- **THEN** 只有该图片显示为已收藏并加入选定收藏夹
- **AND** 同任务其他图片的收藏状态不变

#### Scenario: View a favorite collection
- **WHEN** 用户打开收藏夹或收藏筛选
- **THEN** 结果按单张图片展示
- **AND** 每张结果仍可打开其父任务的图片详情

### Requirement: Delete one output image without deleting siblings
系统 SHALL 支持删除父任务中的单张输出图片，并同步其单图元数据、透明背景原图和本地/在线孤立图片存储；同任务的其他输出 SHALL 保持不变。

#### Scenario: Delete one image from a multi-image task
- **WHEN** 用户确认删除多图任务中的一张图片
- **THEN** 目标图片从画布和父任务输出列表中移除
- **AND** 同任务其他图片、任务提示词和参数保持不变

#### Scenario: Delete the last output image
- **WHEN** 用户删除父任务最后一张输出图片
- **THEN** 父任务记录保留用于历史信息
- **AND** 该任务不再生成画布图片节点

#### Scenario: Image is still referenced elsewhere
- **WHEN** 被删除图片仍被输入草稿、Agent、遮罩或其他任务引用
- **THEN** 系统从当前输出中移除该图片但保留底层图片存储
- **AND** 只有所有引用消失后才删除本地或在线图片资源

### Requirement: Agent references remain stable after image deletion
删除 Agent 生成结果中的单张图片 SHALL 不得让历史图片引用指向另一张图片；被删除的引用 SHALL 显示为明确的已删除状态。

#### Scenario: Delete an intermediate Agent output
- **WHEN** 用户删除 Agent 轮次中间位置的一张输出图
- **THEN** 原有后续引用编号保持对应关系
- **AND** 被删除位置显示为已删除引用而不是后续图片

### Requirement: Image details expose parent-task context and references
单图详情 SHALL 显示当前图片的父任务提示词、参数、来源和参考图，并允许从详情打开现有 Lightbox；详情中的参考图不改变画布节点集合。

#### Scenario: Open details from the toolbar
- **WHEN** 用户点击工具条的查看或信息操作
- **THEN** 详情只聚焦当前图片
- **AND** 用户仍可查看父任务信息及其参考图
