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
      // 任务读写包含参数清洗，单独测试
      if (name === 'getAllTasks' || name === 'putTask') continue
      expect(db[name as keyof typeof db], name).toBe(fn)
    }
  })

  it('读取任务时补全旧记录缺少的 GPT Image 2.6 参数', async () => {
    const oldParams = { ...DEFAULT_PARAMS, complexity: undefined, frame_count: null, frame_duration_ms: 120 }
    vi.spyOn(indexedDbBackend, 'getAllTasks').mockResolvedValue([{ id: 'old', params: oldParams } as unknown as TaskRecord])
    const [task] = await db.getAllTasks()
    expect(task.params).toMatchObject({ complexity: 'auto', frame_count: 9, frame_duration_ms: 120 })
  })

  it('写入任务时清理尺寸类响应参数，保留请求和其他响应属性', async () => {
    const put = vi.spyOn(indexedDbBackend, 'putTask').mockResolvedValue('old')
    const source: TaskRecord = {
      id: 'old', params: DEFAULT_PARAMS,
      prompt: '', inputImageIds: [], outputImages: ['image'], status: 'done', error: null, createdAt: 0, finishedAt: 1, elapsed: 1,
      actualParams: { size: '2K', resolution: '2K', quality: 'high' },
      actualParamsByImage: { image: { size: '1024x1024', aspect_ratio: '1:1', output_format: 'png' } },
    }
    await db.putTask(source)
    expect(put).toHaveBeenCalledWith({
      ...source,
      actualParams: { quality: 'high' },
      actualParamsByImage: { image: { output_format: 'png' } },
    })
    expect(source.actualParams?.size).toBe('2K')
  })
})
