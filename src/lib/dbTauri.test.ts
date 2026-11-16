import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type AgentConversation, type TaskRecord } from '../types'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

import { getAllTasks, getImage, getImageMeta, getStoredImageThumbnail, hashDataUrl, putImage, putImageThumbnail, storeImageWithSize, updateImageDimensions } from './db'
import { bytesToBase64 } from './dataUrl'
import { clearTasks, deleteTask, commitTaskDeletion, dataUrlToPayload, putTask, putAgentConversation, replaceAgentConversations, clearAgentConversations, getAllAgentConversations } from './dbTauri'

/** 按 Rust 侧的格式模拟 image_put / image_get：请求头带元数据，响应为长度前缀 + JSON + 文件内容 */
function fakeFileBackend() {
  const files = new Map<string, { meta: Record<string, unknown>; bytes: Uint8Array }>()
  invoke.mockImplementation(async (cmd: string, args: unknown, opts?: { headers: Record<string, string> }) => {
    if (cmd === 'image_put' || cmd === 'thumbnail_put') {
      const h = opts!.headers
      const num = (v?: string) => (v === undefined ? null : Number(v))
      files.set(`${cmd}:${decodeURIComponent(h['x-id'])}`, {
        meta: {
          mime: h['x-mime'],
          width: num(h['x-width']),
          height: num(h['x-height']),
          source: h['x-source'] ?? null,
          createdAt: num(h['x-created-at']),
          thumbnailVersion: num(h['x-thumbnail-version']),
        },
        bytes: new Uint8Array(args as Uint8Array),
      })
      return null
    }
    if (cmd === 'image_get' || cmd === 'thumbnail_get') {
      const file = files.get(`${cmd.replace('get', 'put')}:${(args as { id: string }).id}`)
      if (!file) return new ArrayBuffer(0)
      const json = new TextEncoder().encode(JSON.stringify(file.meta))
      const out = new Uint8Array(4 + json.length + file.bytes.length)
      new DataView(out.buffer).setUint32(0, json.length, true)
      out.set(json, 4)
      out.set(file.bytes, 4 + json.length)
      return out.buffer
    }
    throw new Error(`未模拟的命令：${cmd}`)
  })
  return files
}

function randomBytes(len: number) {
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536))
  return bytes
}

describe('dbTauri', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('db.ts 门面在客户端中转发到 Rust 命令', async () => {
    invoke.mockResolvedValue([{ id: 't1', params: DEFAULT_PARAMS }])
    await expect(getAllTasks()).resolves.toEqual([{ id: 't1', params: DEFAULT_PARAMS }])
    expect(invoke).toHaveBeenCalledWith('tasks_get_all', undefined, undefined)
  })

  it('大图以二进制传输并原样还原 dataUrl 和元数据', async () => {
    const files = fakeFileBackend()
    const bytes = randomBytes(6 * 1024 * 1024 + 3)
    const dataUrl = `data:image/png;base64,${bytesToBase64(bytes)}`

    await putImage({ id: 'abc123', dataUrl, createdAt: 1700000000000, source: 'generated', width: 1024, height: 1536 })

    const [, payload, opts] = invoke.mock.calls[0]
    expect(payload).toBeInstanceOf(Uint8Array)
    expect(payload.length === bytes.length && payload.every((b: number, i: number) => b === bytes[i])).toBe(true)
    expect(opts.headers).toEqual({
      'x-mime': 'image/png',
      'x-id': 'abc123',
      'x-width': '1024',
      'x-height': '1536',
      'x-source': 'generated',
      'x-created-at': '1700000000000',
    })
    expect(files.size).toBe(1)

    const image = await getImage('abc123')
    expect(image).toEqual({ id: 'abc123', dataUrl, createdAt: 1700000000000, source: 'generated', width: 1024, height: 1536 })
  })

  it('缩略图往返，缺省字段还原为 undefined', async () => {
    fakeFileBackend()
    const thumbnailDataUrl = `data:image/webp;base64,${bytesToBase64(randomBytes(1000))}`
    await putImageThumbnail({ id: 'abc123', thumbnailDataUrl, thumbnailVersion: 2 })
    expect(invoke.mock.calls[0][2].headers).toEqual({ 'x-mime': 'image/webp', 'x-id': 'abc123', 'x-thumbnail-version': '2' })
    await expect(getStoredImageThumbnail('abc123')).resolves.toEqual({
      id: 'abc123',
      thumbnailDataUrl,
      width: undefined,
      height: undefined,
      thumbnailVersion: 2,
    })
  })

  it('不存在时返回 undefined', async () => {
    fakeFileBackend()
    await expect(getImage('missing')).resolves.toBeUndefined()
    await expect(getStoredImageThumbnail('missing')).resolves.toBeUndefined()
  })

  it('非 base64 或非法 base64 的 dataUrl 按原文保存并原样返回', async () => {
    fakeFileBackend()
    for (const dataUrl of ['data:text/plain,hello%20世界', 'data:image/png;base64,@@不是base64@@']) {
      expect(dataUrlToPayload(dataUrl).mime).toBe('text/x-data-url')
      await putImage({ id: 'raw', dataUrl })
      expect((await getImage('raw'))?.dataUrl).toBe(dataUrl)
    }
  })

  it('非规范 base64 和首尾带空格的 mime 走原文兜底，读回与原串一致', async () => {
    fakeFileBackend()
    const cases = [
      'data:image/png;base64,AAAA\nAAAA', // 换行
      'data:image/png;base64,AAE', // 缺少填充
      'data:image/png;base64,AAF=', // 末尾多余比特非零
      'data:image/png;base64,AB==', // 末尾多余比特非零
      'data:image/png;base64,A=AA', // 填充出现在中间
      'data: image/png;base64,AAAA', // mime 首部空格
      'data:image/png ;base64,AAAA', // mime 尾部空格
      'data:text/x-data-url;base64,AAAA', // 与兜底标记冲突的 mime
    ]
    for (const dataUrl of cases) {
      expect(dataUrlToPayload(dataUrl).mime, dataUrl).toBe('text/x-data-url')
      await putImage({ id: 'raw', dataUrl })
      expect((await getImage('raw'))?.dataUrl).toBe(dataUrl)
    }
    for (const dataUrl of ['data:image/png;base64,AAE=', 'data:image/png;base64,AA==', 'data:image/png;base64,', 'data:image/png;base64,AAAA']) {
      expect(dataUrlToPayload(dataUrl).mime, dataUrl).toBe('image/png')
      await putImage({ id: 'canon', dataUrl })
      expect((await getImage('canon'))?.dataUrl).toBe(dataUrl)
    }
  })

  it('外部导入的非法元数据被忽略，任意 id 编码后传递', async () => {
    fakeFileBackend()
    const dataUrl = 'data:image/png;base64,AAAA'
    const id = '../奇怪 id\n'
    await putImage({ id, dataUrl, width: NaN, height: Infinity, createdAt: Number.NaN, source: 'weird' as never })
    expect(invoke.mock.calls[0][2].headers).toEqual({ 'x-id': encodeURIComponent(id), 'x-mime': 'image/png' })
    await expect(getImage(id)).resolves.toEqual({ id, dataUrl, createdAt: undefined, source: undefined, width: undefined, height: undefined })

    await putImageThumbnail({ id, thumbnailDataUrl: dataUrl, width: 10, thumbnailVersion: NaN })
    expect(invoke.mock.calls[2][2].headers).toEqual({ 'x-id': encodeURIComponent(id), 'x-mime': 'image/png', 'x-width': '10' })
  })

  it('保留 mime 参数', () => {
    const payload = dataUrlToPayload('data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+')
    expect(payload.mime).toBe('image/svg+xml;charset=utf-8')
    expect(new TextDecoder().decode(payload.bytes)).toBe('<svg/>')
  })

  it('Rust 返回的错误转换为带 code 的 Error', async () => {
    invoke.mockRejectedValue({ code: 'unavailable', message: '数据目录不可写' })
    const err = await getAllTasks().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('数据目录不可写')
    expect((err as Error & { code: string }).code).toBe('unavailable')

    invoke.mockRejectedValue('plain failure')
    await expect(getImage('x')).rejects.toThrow('plain failure')
  })

  it('任务和对话以 id + JSON 文本传给 Rust', async () => {
    invoke.mockResolvedValue(null)
    const task = { id: 't1', prompt: 'hi' } as unknown as TaskRecord
    await expect(putTask(task)).resolves.toBe('t1')
    expect(invoke).toHaveBeenLastCalledWith('task_put', { id: 't1', data: JSON.stringify(task) }, undefined)

    await commitTaskDeletion(['t0'], [task], [{ id: 'c1' } as never])
    expect(invoke).toHaveBeenLastCalledWith('tasks_commit_deletion', {
      deletedIds: ['t0'],
      tasks: [{ id: 't1', data: JSON.stringify(task) }],
      conversations: [{ id: 'c1', data: '{"id":"c1"}' }],
    }, undefined)
  })

  it.each(['delete', 'batch', 'clear'])('orders %s after pending saves and permits later recreation', async (operation) => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const stored = new Map<string, string>()
    invoke.mockImplementation(async (cmd: string, args?: { id?: string; data?: string; deletedIds?: string[] }) => {
      if (cmd === 'task_put') {
        if (args?.data?.includes('slow')) await pending
        stored.set(args!.id!, args!.data!)
      } else if (cmd === 'task_delete') stored.delete(args!.id!)
      else if (cmd === 'tasks_commit_deletion') {
        for (const id of args!.deletedIds!) stored.delete(id)
      } else if (cmd === 'tasks_clear') stored.clear()
      return null
    })
    const save = putTask({ id: 'target', prompt: 'slow' } as TaskRecord)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    const remove = operation === 'delete' ? deleteTask('target')
      : operation === 'batch' ? commitTaskDeletion(['target'], [], []) : clearTasks()
    if (operation !== 'clear') {
      await putTask({ id: 'other', prompt: 'fast' } as TaskRecord)
      expect(stored.has('other')).toBe(true)
    }
    expect(invoke.mock.calls.some(([cmd]) => ['task_delete', 'tasks_commit_deletion', 'tasks_clear'].includes(cmd))).toBe(false)
    const recreate = putTask({ id: 'target', prompt: 'new' } as TaskRecord)
    release()
    await Promise.all([save, remove, recreate])
    expect(JSON.parse(stored.get('target')!).prompt).toBe('new')
    const commands = invoke.mock.calls.filter(([, args]) => args?.id !== 'other').map(([cmd]) => cmd)
    expect(commands).toEqual(['task_put', operation === 'delete' ? 'task_delete' : operation === 'batch' ? 'tasks_commit_deletion' : 'tasks_clear', 'task_put'])
  })

  it.each(['put', 'replace', 'clear'])('keeps later conversation %s after a deletion waiting for a task save', async (operation) => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const stored = new Map<string, string>()
    invoke.mockImplementation(async (cmd: string, args?: { id?: string; data?: string; conversations?: Array<{ id: string; data: string }> }) => {
      if (cmd === 'task_put' && args?.id === 'slow') await pending
      if (cmd === 'conversations_replace' || cmd === 'conversations_clear') stored.clear()
      if (cmd === 'tasks_commit_deletion' || cmd === 'conversations_replace') {
        for (const doc of args!.conversations!) stored.set(doc.id, doc.data)
      }
      if (cmd === 'conversation_put') stored.set(args!.id!, args!.data!)
      if (cmd === 'conversations_get_all') return [...stored.values()].map((data) => JSON.parse(data))
      return null
    })
    const save = putTask({ id: 'slow' } as TaskRecord)
    const deletion = commitTaskDeletion(['slow'], [], [{ id: 'c', title: 'old' } as AgentConversation])
    const latest = { id: 'c', title: 'new' } as AgentConversation
    const update = operation === 'put' ? putAgentConversation(latest)
      : operation === 'replace' ? replaceAgentConversations([latest]) : clearAgentConversations()
    const read = getAllAgentConversations()
    await putTask({ id: 'independent' } as TaskRecord)
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(['task_put', 'task_put'])
    release()
    await Promise.all([save, deletion, update])
    await expect(read).resolves.toEqual(operation === 'clear' ? [] : [latest])
    expect(invoke.mock.calls.slice(2).map(([cmd]) => cmd)).toEqual([
      'tasks_commit_deletion',
      operation === 'put' ? 'conversation_put' : operation === 'replace' ? 'conversations_replace' : 'conversations_clear',
      'conversations_get_all',
    ])
  })

  it('waits for earlier conversation writes before deletion and releases both queues after failure', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'conversations_replace') await pending
      if (cmd === 'tasks_commit_deletion') throw new Error('delete failed')
      return null
    })
    const save = replaceAgentConversations([{ id: 'c' } as AgentConversation])
    const deletion = commitTaskDeletion(['target'], [], [{ id: 'c' } as AgentConversation])
    const failed = expect(deletion).rejects.toThrow('delete failed')
    const later = putAgentConversation({ id: 'c', title: 'new' } as AgentConversation)
    const taskSave = putTask({ id: 'target' } as TaskRecord)
    await putTask({ id: 'independent' } as TaskRecord)
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(['conversations_replace', 'task_put'])
    release()
    await Promise.all([save, failed, later, taskSave])
    expect(invoke.mock.calls.slice(2).map(([cmd]) => cmd)).toEqual(['tasks_commit_deletion', 'conversation_put', 'task_put'])
  })

  it('continues queued deletion after a failed save', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'task_put') throw new Error('disk failure')
      return null
    })
    const save = putTask({ id: 'target' } as TaskRecord)
    const failed = expect(save).rejects.toThrow('disk failure')
    const remove = deleteTask('target')
    await failed
    await expect(remove).resolves.toBeUndefined()
    expect(invoke.mock.calls.map(([cmd]) => cmd)).toEqual(['task_put', 'task_delete'])
  })

  it('storeImageWithSize 经门面写入客户端存储', async () => {
    const files = fakeFileBackend()
    const dataUrl = `data:image/png;base64,${bytesToBase64(randomBytes(64))}`
    const result = await storeImageWithSize(dataUrl, 'upload')
    expect(result.id).toBe(await hashDataUrl(dataUrl))
    expect(files.has(`image_put:${result.id}`)).toBe(true)
    expect((await getImage(result.id))?.dataUrl).toBe(dataUrl)
  })

  it('读取和补全宽高只调用元数据接口', async () => {
    invoke.mockResolvedValueOnce({ width: 2496, height: 1664, source: 'generated', createdAt: 1 })
    expect(await getImageMeta('image')).toEqual({ id: 'image', width: 2496, height: 1664, source: 'generated', createdAt: 1 })
    expect(invoke).toHaveBeenLastCalledWith('image_meta', { id: 'image' }, undefined)
    invoke.mockResolvedValueOnce(false)
    expect(await updateImageDimensions('deleted', 2496, 1664)).toBe(false)
    expect(invoke).toHaveBeenLastCalledWith('image_dimensions_update', { id: 'deleted', width: 2496, height: 1664 }, undefined)
  })
})
