# Aurora Asset Library Density Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the Aurora asset page as a compact, readable responsive manager and prevent stale asset requests from overwriting the latest filter.

**Architecture:** Keep all backend contracts unchanged. Add small immutable state helpers for request sequencing and prompt expansion, wire them into `AssetLibrary`, then reshape the existing split layout with two-column horizontal desktop cards and vertical mobile cards.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Vite, Fastify API already in the repository.

**Constraint:** Do not commit or push unless the user explicitly requests it. Do not trigger paid image generation during validation.

---

### Task 1: Protect asset results from stale requests

**Files:**
- Modify: `src/lib/assetLibrary.ts`
- Modify: `src/lib/assetLibrary.test.ts`

**Step 1: Write the failing tests**

Extend `src/lib/assetLibrary.test.ts` with tests for a request guard and prompt expansion helper:

```ts
it('only accepts the latest asset request', () => {
  const guard = createLatestAssetRequestGuard()
  const first = guard.begin()
  const second = guard.begin()

  expect(guard.isLatest(first)).toBe(false)
  expect(guard.isLatest(second)).toBe(true)
})

it('toggles expanded prompts without mutating the previous set', () => {
  const current = new Set(['1'])
  expect([...toggleExpandedAsset(current, '2')]).toEqual(['1', '2'])
  expect([...toggleExpandedAsset(current, '1')]).toEqual([])
  expect([...current]).toEqual(['1'])
})
```

**Step 2: Run the focused test and verify RED**

Run: `npm test -- src/lib/assetLibrary.test.ts --reporter=dot`

Expected: FAIL because `createLatestAssetRequestGuard` and `toggleExpandedAsset` are not exported.

**Step 3: Implement the minimal helpers**

Add to `src/lib/assetLibrary.ts`:

```ts
export function createLatestAssetRequestGuard() {
  let latest = 0
  return {
    begin() {
      latest += 1
      return latest
    },
    isLatest(requestId: number) {
      return requestId === latest
    },
  }
}

export function toggleExpandedAsset(current: Set<string>, id: string) {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
```

**Step 4: Run the focused test and verify GREEN**

Run: `npm test -- src/lib/assetLibrary.test.ts --reporter=dot`

Expected: all tests in the file pass.

**Step 5: Review the diff**

Run: `git diff -- src/lib/assetLibrary.ts src/lib/assetLibrary.test.ts`

Do not commit without explicit user authorization.

### Task 2: Rebuild asset component structure and interactions

**Files:**
- Modify: `src/components/AssetLibrary.tsx`
- Create: `tests/assetLibraryInteraction.test.ts`

**Step 1: Write the failing component contract tests**

Create `tests/assetLibraryInteraction.test.ts` that reads `AssetLibrary.tsx` and asserts:

```ts
expect(source).toContain('createLatestAssetRequestGuard')
expect(source).toContain('toggleExpandedAsset')
expect(source).toContain('className="asset-folders-head"')
expect(source).toContain('className="asset-results-toolbar"')
expect(source).toContain('className="asset-card-body"')
expect(source).toContain('className={`asset-prompt ${expanded ? \'expanded\' : \'\'}`}')
expect(source).toContain('aria-expanded={expanded}')
```

Also assert that folder loading and asset loading use separate effects so search changes do not reload folders.

**Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/assetLibraryInteraction.test.ts --reporter=dot`

Expected: FAIL because the new structure and request guard wiring do not exist.

**Step 3: Wire the request guard**

- Import `useRef`, `createLatestAssetRequestGuard`, and `toggleExpandedAsset`.
- Initialize one guard per component instance with `useRef`.
- Call `begin()` at the start of every `loadAssets` invocation.
- Apply list, error, selection, and loading updates only when `isLatest(requestId)` is true.
- Split folder loading and asset loading into separate effects.
- Keep explicit refresh loading both folders and assets.

**Step 4: Add prompt expansion state**

- Maintain `expandedAssetIds` as a `Set<string>`.
- Give each prompt a stable DOM id.
- Render an expand/collapse control for prompts long enough to require disclosure.
- Set `aria-expanded` and `aria-controls` on the control.

**Step 5: Restructure the JSX**

- Move folder creation into `.asset-folders-head`.
- Move search and result status into `.asset-results-toolbar`.
- Wrap card text and actions in `.asset-card-body`.
- Add full names via the `title` attribute.
- Preserve existing click, select, move, rename, delete, pagination, and bulk selection handlers.

**Step 6: Run the focused component contract test**

Run: `npm test -- tests/assetLibraryInteraction.test.ts --reporter=dot`

Expected: PASS.

**Step 7: Run state and component tests together**

Run: `npm test -- src/lib/assetLibrary.test.ts tests/assetLibraryInteraction.test.ts --reporter=dot`

Expected: PASS with no failures.

### Task 3: Implement the compact responsive visual system

**Files:**
- Modify: `src/index.css`
- Modify: `tests/assetLibraryStyles.test.ts`
- Modify: `tests/studioVisualSystem.test.ts` only if the shared icon selector changes.

**Step 1: Replace the old visual expectations with failing tests**

Update `tests/assetLibraryStyles.test.ts` to require:

- Compact asset page padding and header height.
- A 188-200px desktop folder column.
- Search toolbar inside the results column.
- Two desktop columns using horizontal card layout.
- One horizontal column at 1100px and below.
- Vertical card layout at 760px and below.
- Two-line names and three-line collapsed prompts.
- Expanded prompts with no line clamp.
- Mobile card/footer buttons at least 40px.

**Step 2: Run the CSS contract and verify RED**

Run: `npm test -- tests/assetLibraryStyles.test.ts --reporter=dot`

Expected: FAIL against the current three-column vertical card CSS.

**Step 3: Implement desktop layout**

- Reduce asset page padding and remove the 112px minimum header height.
- Use a 188-200px folder column.
- Style `.asset-folders-head` and its icon action.
- Make `.asset-results-toolbar` a compact search/status row.
- Set the asset grid to two columns.
- Make each card a horizontal grid with a 180-200px image and flexible body.
- Keep `object-fit: contain` so generated images are not cropped.

**Step 4: Implement text and control behavior**

- Clamp names to two lines.
- Clamp `.asset-prompt` to three lines.
- Remove the clamp in `.asset-prompt.expanded`.
- Keep the prompt toggle visually quiet and keyboard focusable.
- Preserve stable folder select, rename, and delete control dimensions.

**Step 5: Implement responsive layout**

- At 1100px and below, use one horizontal card column.
- At 760px and below, stack card image/body vertically.
- Keep search and folder selector compact.
- Set high-frequency mobile controls to at least 40px.
- Prevent horizontal overflow at 390px.

**Step 6: Run CSS contracts and verify GREEN**

Run: `npm test -- tests/assetLibraryStyles.test.ts tests/studioVisualSystem.test.ts --reporter=dot`

Expected: PASS.

### Task 4: Run local regression and browser acceptance

**Files:**
- Modify only if a test exposes a defect.

**Step 1: Run all frontend tests**

Run: `npm test -- --reporter=dot`

Expected: all test files and tests pass.

**Step 2: Build production assets**

Run: `npm run build`

Expected: TypeScript and Vite build exit with code 0.

**Step 3: Check patch integrity**

Run: `git diff --check`

Expected: no whitespace errors; existing LF/CRLF warnings may remain.

**Step 4: Verify in a real browser**

Check desktop widths 1536px and 1100px, then mobile widths 760px and 390px:

- Card orientation and column count.
- First card vertical position.
- Long name and prompt expand/collapse.
- Search and rapid folder switching final-state correctness.
- Rename, move, delete confirmation, and batch selection entry layout without destructive confirmation.
- No horizontal overflow or overlapping controls.

### Task 5: Back up, deploy, and verify production

**Files:**
- Update: `.codex/sessions/2026-07-11_aurora-asset-management-settings.md`

**Step 1: Identify exact deployment files**

Expected files are `src/components/AssetLibrary.tsx`, `src/lib/assetLibrary.ts`, and `src/index.css`. Test and documentation files remain local only.

**Step 2: Verify remote files before modification**

- Compute local and remote SHA256 hashes.
- Compare remote target contents against the last deployed version.
- Stop if unknown server changes are found.

**Step 3: Create an exact server backup**

Create a timestamped directory under `/opt/apps/gpt-image-minimal-site/backups/` and copy every target file before upload.

**Step 4: Upload only the reviewed files and rebuild frontend**

Run the existing production Compose command for the frontend service. If Compose recreates the backend because of dependencies, verify that no backend source changed.

**Step 5: Verify production health**

- Confirm frontend and backend containers are running with restart count 0.
- Confirm `https://image.wfjpg.cc/api/health` returns `{"ok":true}`.
- Confirm local and remote deployed file hashes match.

**Step 6: Repeat browser acceptance online**

Repeat desktop and 390px checks on `https://image.wfjpg.cc/`. Do not generate paid images or delete user data.

**Step 7: Update the session anchor**

Record root cause, modified files, RED/GREEN evidence, full verification, server backup path, hashes, online geometry results, remaining risks, and the fact that no commit or push was made.
