import { useCallback, useEffect, useState } from 'react'
import { getMaterialKey, listMaterials, type MaterialItem } from '../lib/materialApi'
import { useMaterialDropUpload } from '../hooks/useMaterialDropUpload'
import { createInputImageFromUrl } from '../store'
import type { InputImage } from '../types'
import { CloseIcon, CloudUploadIcon, RefreshIcon, SearchIcon } from './icons'

function isVideo(item: MaterialItem) {
  return item.content_type.toLowerCase().startsWith('video/')
}

export default function MaterialPickerModal({ onClose, onSelect, preferRemoteUrl = false }: { onClose: () => void; onSelect: (item: MaterialItem, image: InputImage) => void; preferRemoteUrl?: boolean }) {
  const [items, setItems] = useState<MaterialItem[]>([])
  const [keyword, setKeyword] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selecting, setSelecting] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await listMaterials({ page: 1, pageSize: 100, keyword: query })
      setItems(result.items || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => { void load() }, [load])

  const refreshAfterUpload = useCallback(async () => {
    setKeyword('')
    if (query) {
      setQuery('')
      return
    }
    await load()
  }, [load, query])

  const { uploading, isDragging, dropZoneProps } = useMaterialDropUpload({
    onUploaded: refreshAfterUpload,
    onError: setError,
  })

  const select = async (item: MaterialItem) => {
    if (isVideo(item)) return
    setSelecting(item.id)
    try {
      const image = preferRemoteUrl
        ? { id: item.id.trim() ? `material-${item.id}` : `material-url-${item.url}`, dataUrl: item.url }
        : await createInputImageFromUrl(item.url)
      onSelect(item, image)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSelecting(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="relative flex max-h-[min(720px,90vh)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-white/[0.1] dark:bg-gray-900">
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-4 dark:border-white/[0.08]">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">从素材库选择</h2>
            <p className="mt-0.5 text-xs text-gray-400">{uploading ? '正在上传素材...' : '视频素材可预览，但不能作为参考图片使用'}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-white/[0.06] dark:hover:text-white" aria-label="关闭素材库选择器" title="关闭"><CloseIcon className="h-5 w-5" /></button>
        </header>
        <div className="flex items-center gap-2 border-b border-gray-200 px-5 py-3 dark:border-white/[0.08]">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') setQuery(keyword) }} placeholder="搜索文件名" className="h-9 w-full rounded-lg border border-gray-200 bg-gray-50 pl-9 pr-3 text-sm outline-none focus:border-gray-400 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-white" />
          </div>
          <button type="button" onClick={() => void load()} disabled={loading || uploading} className="rounded-lg border border-gray-200 p-2 text-gray-500 hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.1] dark:hover:bg-white/[0.06]" aria-label="刷新素材" title="刷新素材"><RefreshIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
        <div {...dropZoneProps} className="relative min-h-0 flex-1 overflow-y-auto p-5">
          {isDragging && (
            <div className="pointer-events-none absolute inset-5 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-200/80 bg-blue-400/55 text-center shadow-lg shadow-blue-500/10">
              <div>
                <CloudUploadIcon className="mx-auto h-8 w-8 text-white" />
                <p className="mt-2 text-sm font-semibold text-white">松开以上传到素材库</p>
              </div>
            </div>
          )}
          {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-400/10 dark:text-red-300">{error}</p>}
          {loading ? <p className="py-16 text-center text-sm text-gray-400">加载素材中...</p> : items.length === 0 ? <p className="py-16 text-center text-sm text-gray-400">暂无素材</p> : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {items.map((item, index) => (
                <button key={getMaterialKey(item, index)} type="button" disabled={isVideo(item) || selecting === item.id} onClick={() => void select(item)} className={`group overflow-hidden rounded-lg border border-gray-200 text-left dark:border-white/[0.1] ${isVideo(item) ? 'cursor-not-allowed opacity-65' : 'hover:border-gray-400 dark:hover:border-white/[0.3]'}`} title={isVideo(item) ? '视频不能作为参考图片' : `选择${item.file_name}`}>
                  <div className="aspect-square bg-gray-100 dark:bg-white/[0.04]">{isVideo(item) ? <video src={item.url} preload="metadata" className="h-full w-full object-contain" /> : <img src={item.url} alt={item.file_name} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.03]" />}</div>
                  <p className="truncate px-2 py-2 text-xs text-gray-700 dark:text-gray-300">{item.file_name}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
