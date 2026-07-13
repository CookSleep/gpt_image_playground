# Aurora Visual System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 统一 Aurora 登录后全站控件高度、间距和垂直对齐，并消除已确认的按钮内容裁切。

**Architecture:** 在现有 `src/index.css` 的 Visual rhythm normalization 区域新增少量共享令牌，再对顶部工具区、创作设置入口和任务行做精确覆盖。保持 JSX、业务状态和 API 不变，用 CSS 视觉契约测试锁定规范。

**Tech Stack:** React 19、TypeScript、CSS、Vitest、Chrome 真实页面验证

---

### Task 1: 固化全站视觉令牌

**Files:**
- Create: `tests/studioVisualSystem.test.ts`
- Modify: `src/index.css`

**Step 1: Write the failing test**

新增测试，断言 `.immersive-studio, .immersive-auth` 定义 `28/36/40/44px` 控件高度和 `8/12/16px` 间距令牌。

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/studioVisualSystem.test.ts --reporter=verbose`

Expected: FAIL，提示缺少视觉令牌。

**Step 3: Write minimal implementation**

在 Visual rhythm normalization 变量区增加七个 `--ui-*` 变量，不改颜色、字体和页面宽度。

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/studioVisualSystem.test.ts --reporter=verbose`

Expected: 视觉令牌用例 PASS。

### Task 2: 统一顶部工具区

**Files:**
- Modify: `tests/studioVisualSystem.test.ts`
- Modify: `src/index.css`

**Step 1: Write the failing test**

断言 `.immersive-account` 使用 `8px` 间距，额度文字、主题容器、设置和退出按钮均使用 `36px` 标准高度。

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/studioVisualSystem.test.ts --reporter=verbose`

Expected: FAIL，现有工具区仍混用 `34/36px` 和 `10px` 间距。

**Step 3: Write minimal implementation**

仅覆盖顶部工具区相关选择器，统一高度、垂直居中和间距，不改变 DOM。

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/studioVisualSystem.test.ts --reporter=verbose`

Expected: 顶部工具区用例 PASS。

### Task 3: 修复创作入口和任务行裁切

**Files:**
- Modify: `tests/workspaceSettingsPlacement.test.ts`
- Modify: `tests/studioVisualSystem.test.ts`
- Modify: `src/index.css`

**Step 1: Write the failing test**

断言创作设置入口使用 `height: auto`、最小高度 `58px`、下边距 `12px`，任务行使用 `height: auto` 和最小高度 `82px`。

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/workspaceSettingsPlacement.test.ts tests/studioVisualSystem.test.ts --reporter=verbose`

Expected: FAIL，入口仍为全局 `38px`，任务行仍可能裁切。

**Step 3: Write minimal implementation**

覆盖 `.workspace-config-required` 与 `.version-list > button` 的高度和排版规则，保持交互与文案不变。

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/workspaceSettingsPlacement.test.ts tests/studioVisualSystem.test.ts --reporter=verbose`

Expected: 两个视觉契约测试文件全部 PASS。

### Task 4: 全量验证与上线

**Files:**
- Modify: `.codex/sessions/2026-07-11_aurora-asset-management-settings.md`

**Step 1: Run full verification**

Run: `npm test -- --reporter=dot`

Run: `npm run build`

Run: `git diff --check`

Expected: 全部命令退出码为 0；仅允许既有测试环境和换行提示。

**Step 2: Verify production source identity**

逐字比较服务器 `src/index.css` 与本地本次改动前版本，确认没有未知线上改动。

**Step 3: Back up and deploy**

精确备份服务器 `src/index.css`，仅上传该文件并执行：

`docker compose -f docker-compose.server.yml -f docker-compose.prod.yml up -d --build frontend`

**Step 4: Verify in Chrome**

验证 1536px 桌面和 390x844 移动端的顶部导航、三个主页面、设置弹窗和任务详情；检查内容溢出与控制台。

**Step 5: Record state**

将测试、备份目录、部署状态和线上验证结果写入当前 session 状态文件。遵循当前约束，不提交或推送代码。
