# Auth Page V3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将登录页和账号停用页改造成与 V3 图片工作台一致的浅色未来感工具界面。

**Architecture:** 保留 `AuthPage` 和 `AccountDisabledPage` 的现有认证数据流，只替换 JSX 结构、中文文案和 CSS。复用项目已有 SVG 图标组件，不引入新依赖。

**Tech Stack:** React 19、TypeScript、Vite、CSS、Vitest

---

### Task 1: 重构登录页结构与文案

**Files:**
- Modify: `src/App.tsx`

1. 将登录页改为左侧创作预览、右侧登录面板。
2. 保留邮箱、密码、`submit` 和 `/api/auth/login` 调用。
3. 将按钮文案改为“登录并进入工作台”，加载状态改为“正在验证账号…”。
4. 增加账号与安全说明，不增加不可用入口。

### Task 2: 统一账号停用页面

**Files:**
- Modify: `src/App.tsx`

1. 将标题改为“当前账号不可用”。
2. 展示当前账号、账号状态和处理位置。
3. 保留重新检查状态和退出登录行为。

### Task 3: 实现浅色未来感样式

**Files:**
- Modify: `src/index.css`
- Modify: `src/components/icons.tsx`

1. 实现双栏 PC 登录布局和玻璃材质面板。
2. 实现任务预览卡、运行中进度条和专业表单样式。
3. 保证 1280 和 1600 宽度无重叠和横向溢出。

### Task 4: 验证

**Files:**
- Test: existing Vitest suite

1. 运行 `npm test`，预期全部通过。
2. 运行 `npm run build`，预期构建成功。
3. 使用浏览器验证登录失败、登录成功、账号停用和 PC 布局。
