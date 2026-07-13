# Aurora Asset Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 Aurora Studio 增加双 Key 设置、提示词优化、图片独立命名、搜索、一级文件夹、批量归类以及图片/任务/文件夹安全删除。

**Architecture:** 延续现有 Fastify route -> store -> PostgreSQL/S3 结构，不引入新的分层框架。设置和资产元数据由 PostgreSQL 持久化，Key 明文每次通过当前 sub2api 会话解析；外部对象先幂等删除，再清理数据库记录。前端从现有大 `App.tsx` 中拆出设置、资产和确认交互组件，所有 API 请求继续 `cache: 'no-store'`。

**Tech Stack:** React 19、TypeScript、Vite、Vitest、Fastify 5、PostgreSQL、AWS SDK S3、OpenAI-compatible Responses API

---

> 本任务已明确“提交、推送和部署待用户要求”，因此以下步骤不创建 Git commit；每个阶段改为更新 `.codex/sessions/2026-07-11_aurora-asset-management-settings.md`。

### Task 1: 数据库迁移与 store 资产模型

**Files:**
- Modify: `backend/test/schema.test.js`
- Modify: `backend/src/schema.sql`
- Modify: `backend/src/pgStore.js`
- Modify: `backend/src/memoryStore.js`
- Modify: `backend/test/app.test.js`

**Step 1: 写失败测试**

在 schema 测试中断言存在 `user_settings`、`asset_folders`、`generation_images.name`、`generation_images.folder_id`、用户级文件夹唯一索引和旧图片名称回填语句。在 app 测试中先用期望中的 store API 创建文件夹、列出资产、重命名和移动图片。

**Step 2: 验证红灯**

Run: `cd backend; npm test -- --run test/schema.test.js test/app.test.js`

Expected: FAIL，原因是迁移和 store 方法尚不存在。

**Step 3: 最小实现**

新增关系：

```sql
create table if not exists user_settings (
  user_id bigint primary key references users(id) on delete cascade,
  image_api_key_id text,
  prompt_api_key_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists asset_folders (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

为 `generation_images` 增加 `name` 和 `folder_id`；回填后把 `name` 设为非空。store 增加设置、文件夹、资产分页、重命名、移动和删除前查询方法。内存 store 与 PostgreSQL store 保持同一行为。

**Step 4: 验证绿灯**

Run: `cd backend; npm test -- --run test/schema.test.js test/app.test.js`

Expected: PASS。

### Task 2: 双 Key 设置与生成门禁

**Files:**
- Modify: `backend/test/app.test.js`
- Modify: `backend/src/app.js`
- Modify: `backend/src/pgStore.js`
- Modify: `backend/src/memoryStore.js`

**Step 1: 写失败测试**

覆盖：

- `GET /api/settings` 初始返回两个空 Key。
- `PUT /api/settings` 只接受当前账号 active Key。
- 响应和 store 中不出现 Key 明文。
- 两个 Key 未完整配置时生成返回 409。
- 完整配置后生成忽略客户端 `apiKeyId`，只使用设置中的图片 Key。

**Step 2: 验证红灯**

Run: `cd backend; npm test -- --run test/app.test.js`

Expected: FAIL，设置路由和门禁不存在。

**Step 3: 最小实现**

在 `app.js` 增加设置公开模型、Key 状态解析和两个 route。生成 route 读取设置，解析 `imageApiKeyId`，并要求 `promptApiKeyId` 同时存在。前端请求体中的 `apiKeyId` 不再参与生成。

**Step 4: 验证绿灯**

Run: `cd backend; npm test -- --run test/app.test.js`

Expected: PASS。

### Task 3: `gpt-5.5` 提示词优化客户端

**Files:**
- Create: `backend/src/textClient.js`
- Create: `backend/test/textClient.test.js`
- Modify: `backend/src/index.js`
- Modify: `backend/src/app.js`
- Modify: `backend/test/app.test.js`
- Modify: `.env.example`
- Modify: `docker-compose.local.yml`
- Modify: `docker-compose.prod.yml`

**Step 1: 写失败测试**

客户端测试断言请求发送到 `/responses`，使用传入的提示词 Key、`gpt-5.5`、固定优化 instructions，并能从 `output_text` 或 Responses output items 读取正文。route 测试断言使用保存的提示词 Key，空提示词返回 400，上游错误不修改设置。

**Step 2: 验证红灯**

Run: `cd backend; npm test -- --run test/textClient.test.js test/app.test.js`

Expected: FAIL，客户端和 route 尚不存在。

**Step 3: 最小实现**

实现：

```js
textClient.optimize({ prompt, apiKey, model: options.defaultTextModel })
```

`index.js` 复用 `OPENAI_BASE_URL`，增加 `DEFAULT_TEXT_MODEL`，默认 `gpt-5.5`。新增 `POST /api/prompts/optimize`，只返回 `{ optimizedPrompt }`。

**Step 4: 验证绿灯**

Run: `cd backend; npm test -- --run test/textClient.test.js test/app.test.js`

Expected: PASS。

### Task 4: S3 删除与资产/文件夹 API

**Files:**
- Modify: `backend/src/s3Storage.js`
- Modify: `backend/src/app.js`
- Modify: `backend/src/pgStore.js`
- Modify: `backend/src/memoryStore.js`
- Modify: `backend/test/app.test.js`
- Create: `backend/test/s3Storage.test.js`

**Step 1: 写失败测试**

覆盖：资产名称/提示词搜索、文件夹创建/重命名/同名冲突、单张和批量移动、未分类、用户隔离、单图删除、任务多图删除、生成中任务拒绝、文件夹两种删除方式、对象不存在幂等成功、对象删除失败时保留数据库记录。

**Step 2: 验证红灯**

Run: `cd backend; npm test -- --run test/app.test.js test/s3Storage.test.js`

Expected: FAIL，删除适配器和 route 不存在。

**Step 3: 最小实现**

S3 适配器增加 `DeleteObjectCommand`。route 增加：

```text
GET    /api/folders
POST   /api/folders
PATCH  /api/folders/:id
DELETE /api/folders/:id?deleteImages=true|false
GET    /api/assets?q=&folderId=&cursor=&limit=
PATCH  /api/images/:id
POST   /api/images/move
DELETE /api/images/:id
DELETE /api/generations/:id
```

所有 route 先校验当前用户所有权。名称 trim 后校验长度。对象清理成功后才删除元数据。

**Step 4: 验证绿灯**

Run: `cd backend; npm test -- --run test/app.test.js test/s3Storage.test.js`

Expected: PASS。

### Task 5: 前端 API 类型与纯状态逻辑

**Files:**
- Modify: `src/lib/minimalApi.ts`
- Create: `src/lib/assetLibrary.ts`
- Create: `src/lib/assetLibrary.test.ts`
- Create: `src/lib/auroraSettings.ts`
- Create: `src/lib/auroraSettings.test.ts`

**Step 1: 写失败测试**

测试资产查询参数、未分类编码、选择集切换、批量移动后的本地状态合并、双 Key 完整状态、默认图片名展示回退和优化结果应用。

**Step 2: 验证红灯**

Run: `npm test -- --run src/lib/assetLibrary.test.ts src/lib/auroraSettings.test.ts`

Expected: FAIL，新模块不存在。

**Step 3: 最小实现**

在 `minimalApi.ts` 增加 `ApiSettings`、`ApiAssetFolder`、`ApiAsset` 以及 generation image 的 `name/folderId`。纯函数负责 URL 查询、选择状态和配置完整性，组件只处理交互。

**Step 4: 验证绿灯**

Run: `npm test -- --run src/lib/assetLibrary.test.ts src/lib/auroraSettings.test.ts`

Expected: PASS。

### Task 6: Aurora 设置中心、品牌入口与创作门禁

**Files:**
- Create: `src/components/AuroraSettingsModal.tsx`
- Create: `src/components/PromptOptimizerDialog.tsx`
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Modify: `src/components/icons.tsx`
- Modify: `src/lib/studioView.test.ts`

**Step 1: 写失败测试**

先为可提取的设置状态和提示词应用逻辑补测试，确认未配置时生成门禁、取消优化不覆盖、应用优化替换草稿。

**Step 2: 验证红灯**

Run: `npm test -- --run src/lib/auroraSettings.test.ts src/lib/studioView.test.ts`

Expected: FAIL，新增行为尚未实现。

**Step 3: 最小实现**

修改登录文案和两个 Aurora 控制台链接。顶栏增加设置图标按钮和 tooltip。设置弹窗加载 Key/设置、保存两个 Key，并展示失效状态。移除工作台 Key 下拉框；未配置时显示引导并禁用生成。提示词优化按钮调用后端并展示原文/结果对比。

**Step 4: 验证绿灯与构建**

Run: `npm test -- --run src/lib/auroraSettings.test.ts src/lib/studioView.test.ts`

Run: `npm run build`

Expected: PASS。

### Task 7: 图片资产文件夹、搜索与批量归类 UI

**Files:**
- Create: `src/components/AssetLibrary.tsx`
- Create: `src/components/AuroraConfirmDialog.tsx`
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Modify: `src/components/icons.tsx`
- Modify: `src/lib/assetLibrary.test.ts`

**Step 1: 写失败测试**

覆盖搜索参数、分页游标重置、单选/多选、移动后文件夹归属、删除后本地集合更新和最后一张图片删除后的任务空状态。

**Step 2: 验证红灯**

Run: `npm test -- --run src/lib/assetLibrary.test.ts`

Expected: FAIL，新增资产行为尚未实现。

**Step 3: 最小实现**

资产页实现桌面文件夹侧栏、移动端文件夹选择器、搜索、分页加载、创建/重命名/删除文件夹、图片独立名称、单图菜单和多选批量移动。确认弹窗使用三按钮文件夹删除和标准危险操作确认。所有按钮使用现有图标并提供可访问名称。

**Step 4: 验证绿灯与构建**

Run: `npm test -- --run src/lib/assetLibrary.test.ts`

Run: `npm run build`

Expected: PASS。

### Task 8: 任务删除、完整回归与视觉验证

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Modify: `.codex/sessions/2026-07-11_aurora-asset-management-settings.md`

**Step 1: 接入任务删除**

已完成/失败任务详情增加删除动作和确认弹窗；生成中任务不显示可用删除。删除后清理当前选中项、URL generationId 和轮播索引。

**Step 2: 运行后端完整测试**

Run: `cd backend; npm test`

Expected: 全部 PASS，无未处理 rejection。

**Step 3: 运行前端完整测试与构建**

Run: `npm test -- --run`

Run: `npm run build`

Expected: 全部 PASS，TypeScript 和 Vite 构建成功。

**Step 4: 本地联调与视觉检查**

启动 `backend npm run dev:memory` 和 Vite 非占用端口，使用 mock Key/图片结果验证登录、设置门禁、优化预览、文件夹、搜索、移动、重命名及各类确认删除。检查桌面和移动视口、明暗主题、键盘焦点、文本溢出和弹窗遮挡。

不调用线上生成接口。

**Step 5: 更新状态锚点**

记录修改文件、测试命令、结果、未验证的生产 PostgreSQL/S3 风险，以及后续部署所需精确备份清单。
