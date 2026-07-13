# Aurora Reference Image Limits Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task.

**Goal:** Allow up to 16 reference images while limiting each decoded image to 4 MiB in both the browser and backend.

**Architecture:** A shared front-end planning helper filters each file selection before FileReader work, while a backend validation helper rejects crafted requests before generation records are created. Existing image edit forwarding remains unchanged.

**Tech Stack:** React 19, TypeScript, Fastify, Node.js, Vitest, CSS.

---

### Task 1: Front-end selection planning

**Files:**
- Create: `src/lib/referenceImages.ts`
- Create: `src/lib/referenceImages.test.ts`

1. Write failing tests for 16-image capacity, the inclusive 4 MiB boundary, oversized-file skipping, and overflow skipping.
2. Run `npm test -- --reporter=dot src/lib/referenceImages.test.ts` and verify RED because the helper does not exist.
3. Implement constants and a pure `planReferenceFileSelection` helper.
4. Re-run the focused test and verify GREEN.

### Task 2: Backend hard validation

**Files:**
- Create: `backend/src/referenceImages.js`
- Modify: `backend/src/app.js`
- Modify: `backend/test/app.test.js`
- Create: `backend/test/referenceImageLimits.test.js`
- Modify: `deploy/nginx.conf`

1. Add failing route tests for 16 accepted references, 17 rejected references, the 4 MiB boundary, oversized data, and malformed data URLs.
2. Run `npm test -- --reporter=dot test/app.test.js` in `backend` and verify RED.
3. Implement `validateReferenceImages` and call it before settings lookup or generation creation.
4. Raise the Fastify and Nginx request body limits to 92 MiB so 16 base64-encoded 4 MiB images fit end to end.
5. Re-run the backend focused tests and verify GREEN.

### Task 3: Aurora workspace integration

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/index.css`
- Create: `tests/referenceImageWorkspace.test.ts`

1. Add failing source/style contracts for 16-image text, append behavior, disabled add control, and horizontal thumbnail scrolling.
2. Run `npm test -- --reporter=dot tests/referenceImageWorkspace.test.ts` and verify RED.
3. Integrate the selection planner, append Data URLs, show skipped-file summaries, disable the add button at 16, and add horizontal scrolling CSS.
4. Re-run focused front-end tests and verify GREEN.

### Task 4: Regression and browser verification

**Files:**
- Verify only.

1. Run `npm test -- --reporter=dot` at the repository root.
2. Run `npm test -- --reporter=dot` in `backend`.
3. Run `npm run build` and `git diff --check`.
4. Start the local mock services, verify adding valid and oversized files, the 16-image cap, layout overflow, and console logs, then stop services.
5. If all checks pass, compare production target files, create an exact backup, deploy only changed runtime files, and repeat non-paid online verification.
