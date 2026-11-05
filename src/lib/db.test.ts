import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }))

import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import * as db from './db'
import * as indexedDbBackend from './dbIndexedDb'

describe('db 门面（网页版）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('底层存取全部使用 IndexedDB 实现', () => {
    for (const [name, fn] of Object.entries(indexedDbBackend)) {
      // 读取任务时会补全旧记录的参数，单独测试
      if (name === 'getAllTasks') continue
      expect(db[name as keyof typeof db], name).toBe(fn)
    }
  })

  it('读取任务时补全旧记录缺少的 GPT Image 2.6 参数', async () => {
    const oldParams = { ...DEFAULT_PARAMS, complexity: undefined, frame_count: null, frame_duration_ms: 120 }
    vi.spyOn(indexedDbBackend, 'getAllTasks').mockResolvedValue([{ id: 'old', params: oldParams } as unknown as TaskRecord])
    const [task] = await db.getAllTasks()
    expect(task.params).toMatchObject({ complexity: 'auto', frame_count: 9, frame_duration_ms: 120 })
  })
})
