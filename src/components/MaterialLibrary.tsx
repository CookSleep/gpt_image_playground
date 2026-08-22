import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { batchDeleteMaterials, deleteMaterial, downloadMaterialFiles, getMaterialKey, listMaterials, uploadMaterialFile, type MaterialItem } from '../lib/materialApi'
import { useDragSelect } from '../hooks/useDragSelect'
import { CloseIcon, CloudUploadIcon, DownloadIcon, RefreshIcon, SearchIcon, TrashIcon } from './icons'

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '未知大小'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN')
}

function isVideo(item: MaterialItem) {
  return item.content_type.toLowerCase().startsWith('video/')
}

export default function MaterialLibrary() {
  const [items, setItems] = useState<MaterialItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const materialsRef = useRef(new Map<string, MaterialItem>())
  const suppressClickUntilRef = useRef(0)
  const pageSize = 24
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  const handleSelectionChange = useCallback((ids: string[]) => {
    setSelectedIds(ids)
    if (ids.length > 0) setBatchMode(true)
  }, [])

  const { selectionBox } = useDragSelect({
    containerSelector: '[data-material-library-root]',
    itemSelector: '.material-card-wrapper',
    getItemId: (element) => element.getAttribute('data-material-id'),
    onSelectionChange: handleSelectionChange,
    initialSelectedIds: selectedIds,
    onSuppressClick: () => {
      suppressClickUntilRef.current = Date.now() + 250
    },
  })

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const result = await listMaterials({ page, pageSize, keyword: query })
      const nextItems = result.items || []
      nextItems.forEach((item) => materialsRef.current.set(item.id, item))
      setItems(nextItems)
      setTotal(result.total || 0)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [page, query])

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (files.length === 0) return
    setUploading(true)
    setError('')
    try {
      for (const file of files) await uploadMaterialFile(file)
      setPage(1)
      if (page === 1) await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (item: MaterialItem) => {
    if (!window.confirm(`确定删除「${item.file_name}」吗？`)) return
    try {
      await deleteMaterial(item.id)
      setSelectedIds((ids) => ids.filter((id) => id !== item.id))
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleBatchDelete = async () => {
    if (selectedIds.length === 0 || !window.confirm(`确定删除选中的 ${selectedIds.length} 个素材吗？`)) return
    setDeleting(true)
    setError('')
    try {
      const result = await batchDeleteMaterials(selectedIds)
      setSelectedIds([])
      await load()
      if (result.deleted_count < selectedIds.length) {
        setError(`已删除 ${result.deleted_count} 个素材，另有 ${selectedIds.length - result.deleted_count} 个素材未删除`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  const handleDownload = async () => {
    if (selectedIds.length === 0) return
    setDownloading(true)
    setError('')
    try {
      const selectedItems = selectedIds.map((id) => materialsRef.current.get(id)).filter((item): item is MaterialItem => Boolean(item))
      const result = await downloadMaterialFiles(selectedItems)
      const missingCount = selectedIds.length - selectedItems.length
      const failCount = result.failCount + missingCount
      if (failCount > 0) setError(`已下载 ${result.successCount} 个素材，另有 ${failCount} 个素材下载失败，请检查素材域名的 CORS 配置`)
    } finally {
      setDownloading(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <main className="safe-area-x relative mx-auto min-h-[calc(100vh-4rem)] w-full max-w-7xl px-4 pb-24 pt-8 sm:px-6">
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-gray-500">Workspace</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-gray-900 dark:text-white">素材库</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">管理可用于图片编辑的参考图和遮罩素材</p>
        </div>
        <div className="flex items-center gap-2">
          <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleUpload} />
          <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading} className="inline-flex h-10 items-center gap-2 rounded-lg bg-gray-900 px-4 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
            <CloudUploadIcon className="h-4 w-4" />
            {uploading ? '上传中...' : '上传素材'}
          </button>
          <button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg border border-gray-200 p-2.5 text-gray-500 transition hover:bg-gray-50 hover:text-gray-900 disabled:opacity-50 dark:border-white/[0.1] dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-white" aria-label="刷新素材库" title="刷新素材库">
            <RefreshIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="mb-5 flex items-center gap-2">
        <form onSubmit={(event) => { event.preventDefault(); setPage(1); setQuery(keyword) }} className="flex min-w-0 max-w-xl flex-1 items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索文件名" className="h-10 w-full rounded-lg border border-gray-200 bg-white pl-9 pr-3 text-sm text-gray-900 outline-none transition focus:border-gray-400 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-white dark:focus:border-white/[0.25]" />
          </div>
          <button type="submit" className="h-10 shrink-0 rounded-lg border border-gray-200 px-4 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-white/[0.1] dark:text-gray-300 dark:hover:bg-white/[0.06]">搜索</button>
        </form>
        <button type="button" onClick={() => { setBatchMode((value) => !value); if (batchMode) setSelectedIds([]) }} aria-pressed={batchMode} className={`ml-auto h-10 shrink-0 whitespace-nowrap rounded-lg border px-4 text-sm font-medium transition ${batchMode ? 'border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900' : 'border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-white/[0.1] dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}>批量操作</button>
      </div>

      {error && <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-300">{error}</div>}
      {loading ? (
        <div className="py-20 text-center text-sm text-gray-400">加载素材中...</div>
      ) : items.length === 0 ? (
        <div className="border border-dashed border-gray-200 py-20 text-center dark:border-white/[0.12]">
          <CloudUploadIcon className="mx-auto h-8 w-8 text-gray-300 dark:text-gray-600" />
          <p className="mt-3 text-sm font-medium text-gray-600 dark:text-gray-300">暂无素材</p>
          <p className="mt-1 text-xs text-gray-400">上传图片后，它们会显示在这里</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {items.map((item, index) => (
            <article
              key={getMaterialKey(item, index)}
              data-material-id={item.id}
              className={`material-card-wrapper group relative cursor-pointer overflow-hidden rounded-lg border bg-white transition hover:shadow-md dark:bg-white/[0.03] ${selectedIds.includes(item.id) ? 'border-blue-500 ring-2 ring-blue-500/50' : 'border-gray-200 hover:border-gray-300 dark:border-white/[0.1] dark:hover:border-white/[0.2]'}`}
              onClick={(event) => {
                if (Date.now() < suppressClickUntilRef.current) {
                  event.preventDefault()
                  return
                }
                if ((event.target as HTMLElement).closest('button, video')) return
                if (batchMode || (isMac ? event.metaKey : event.ctrlKey)) {
                  event.preventDefault()
                  setBatchMode(true)
                  setSelectedIds((ids) => ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id])
                  return
                }
                window.open(item.url, '_blank', 'noopener,noreferrer')
              }}
            >
              {selectedIds.includes(item.id) && (
                <div className="pointer-events-none absolute right-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 shadow-sm">
                  <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              )}
              <div className="aspect-square bg-gray-100 dark:bg-white/[0.04]">
                {isVideo(item) ? (
                  <video data-no-drag-select src={item.url} controls preload="metadata" className="h-full w-full object-contain" />
                ) : (
                  <img src={item.url} alt={item.file_name} loading="lazy" draggable={false} className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]" />
                )}
              </div>
              <div className="p-2.5">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-xs font-medium text-gray-800 dark:text-gray-200" title={item.file_name}>{item.file_name}</p>
                  <span className="shrink-0 text-[10px] uppercase text-gray-400">{isVideo(item) ? '视频' : '图片'}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-gray-400">
                  <span>{formatBytes(item.size_bytes)}{formatDate(item.created_at) ? ` · ${formatDate(item.created_at)}` : ''}</span>
                  <button type="button" onClick={(event) => { event.stopPropagation(); void handleDelete(item) }} className="shrink-0 rounded p-1 text-gray-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-400/10 dark:hover:text-red-300" aria-label={`删除${item.file_name}`} title="删除素材"><TrashIcon className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-7 flex items-center justify-center gap-3 text-sm">
          <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page === 1} className="rounded-lg border border-gray-200 px-3 py-2 text-gray-600 disabled:opacity-40 dark:border-white/[0.1] dark:text-gray-300">上一页</button>
          <span className="tabular-nums text-gray-400">{page} / {totalPages}</span>
          <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages} className="rounded-lg border border-gray-200 px-3 py-2 text-gray-600 disabled:opacity-40 dark:border-white/[0.1] dark:text-gray-300">下一页</button>
        </div>
      )}
      {selectionBox && (
        <div
          className="pointer-events-none fixed z-[30] border border-blue-500/50 bg-blue-500/20"
          style={{
            left: Math.min(selectionBox.startPageX, selectionBox.currentPageX) - window.scrollX,
            top: Math.min(selectionBox.startPageY, selectionBox.currentPageY) - window.scrollY,
            width: Math.abs(selectionBox.currentPageX - selectionBox.startPageX),
            height: Math.abs(selectionBox.currentPageY - selectionBox.startPageY),
          }}
        />
      )}
      {batchMode && (
        <div data-no-drag-select className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          <div className="flex items-center gap-1 rounded-full border border-gray-200/70 bg-white/95 p-1 shadow-[0_8px_30px_rgb(0,0,0,0.14)] backdrop-blur dark:border-white/10 dark:bg-gray-800/95">
            <button type="button" onClick={() => { setBatchMode(false); setSelectedIds([]) }} className="rounded-full p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white" aria-label="退出批量操作" title="退出批量操作">
              <CloseIcon className="h-5 w-5" />
            </button>
            <div className="mx-1 h-5 w-px bg-gray-200 dark:bg-white/20" />
            <button type="button" onClick={() => setSelectedIds((ids) => Array.from(new Set([...ids, ...items.map((item) => item.id)])))} disabled={items.length === 0} className="rounded-full p-2 text-blue-600 transition hover:bg-blue-50 disabled:opacity-40 dark:text-blue-300 dark:hover:bg-blue-400/10" aria-label="全选本页素材" title="全选本页">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="m8 12 2.5 2.5L16 9" />
              </svg>
            </button>
            <button type="button" onClick={() => { const visibleIds = new Set(items.map((item) => item.id)); setSelectedIds((ids) => [...ids.filter((id) => !visibleIds.has(id)), ...items.filter((item) => !ids.includes(item.id)).map((item) => item.id)]) }} disabled={items.length === 0} className="rounded-full p-2 text-purple-600 transition hover:bg-purple-50 disabled:opacity-40 dark:text-purple-300 dark:hover:bg-purple-400/10" aria-label="反选本页素材" title="反选本页">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="4 4" />
                <path d="M8 12h8m-3-3 3 3-3 3" />
              </svg>
            </button>
            <div className="mx-1 h-5 w-px bg-gray-200 dark:bg-white/20" />
            <button type="button" onClick={() => void handleDownload()} disabled={downloading || selectedIds.length === 0} className="rounded-full p-2 text-green-600 transition hover:bg-green-50 disabled:opacity-40 dark:text-green-300 dark:hover:bg-green-400/10" aria-label={`下载选中的 ${selectedIds.length} 个素材`} title={downloading ? '下载中' : '下载选中'}>
              <DownloadIcon className={`h-5 w-5 ${downloading ? 'animate-pulse' : ''}`} />
            </button>
            <div className="mx-1 h-5 w-px bg-gray-200 dark:bg-white/20" />
            <button type="button" onClick={() => void handleBatchDelete()} disabled={deleting || selectedIds.length === 0} className="rounded-full p-2 text-red-600 transition hover:bg-red-50 disabled:opacity-40 dark:text-red-300 dark:hover:bg-red-400/10" aria-label={`删除选中的 ${selectedIds.length} 个素材`} title={deleting ? '删除中' : '批量删除'}>
              <TrashIcon className={`h-5 w-5 ${deleting ? 'animate-pulse' : ''}`} />
            </button>
          </div>
        </div>
      )}
    </main>
  )
}
