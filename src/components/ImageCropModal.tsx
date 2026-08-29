import { useEffect, useState } from 'react'
import { createInputImageFromDataUrl, ensureImageCached, useStore } from '../store'
import { cropImageDataUrl, type CropAspect } from '../lib/cropImage'
import { CloseIcon, CropIcon } from './icons'

const aspectOptions: Array<{ value: CropAspect; label: string }> = [
  { value: 'original', label: '原比例' },
  { value: 'square', label: '1:1' },
  { value: 'landscape', label: '4:3' },
  { value: 'portrait', label: '3:4' },
]

export default function ImageCropModal({ imageId, onClose }: { imageId: string; onClose: () => void }) {
  const addInputImage = useStore((s) => s.addInputImage)
  const showToast = useStore((s) => s.showToast)
  const [source, setSource] = useState('')
  const [aspect, setAspect] = useState<CropAspect>('original')
  const [working, setWorking] = useState(false)

  useEffect(() => {
    let cancelled = false
    void ensureImageCached(imageId).then((value) => {
      if (!cancelled) setSource(value ?? '')
    })
    return () => {
      cancelled = true
    }
  }, [imageId])

  const handleCrop = async () => {
    if (!source || working) return
    setWorking(true)
    try {
      const dataUrl = await cropImageDataUrl(source, aspect)
      addInputImage(await createInputImageFromDataUrl(dataUrl))
      showToast('裁剪图片已加入输入区', 'success')
      onClose()
    } catch (err) {
      showToast(`裁剪失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-white/[0.1] dark:bg-gray-900">
        <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-white/[0.08]">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-white"><CropIcon className="h-4 w-4" />裁剪图片</div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-white/[0.06] dark:hover:text-white" aria-label="关闭裁剪" title="关闭"><CloseIcon className="h-4 w-4" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {source ? <img src={source} alt="待裁剪图片" className="mx-auto max-h-[60vh] max-w-full object-contain" /> : <div className="flex h-48 items-center justify-center text-sm text-gray-400">加载图片中...</div>}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 px-4 py-3 dark:border-white/[0.08]">
          <div className="flex items-center gap-1.5">
            {aspectOptions.map((option) => <button key={option.value} type="button" onClick={() => setAspect(option.value)} className={`rounded-md px-2.5 py-1.5 text-xs transition ${aspect === option.value ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.08]'}`}>{option.label}</button>)}
          </div>
          <button type="button" onClick={() => void handleCrop()} disabled={!source || working} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">{working ? '处理中...' : '裁剪并加入输入'}</button>
        </footer>
      </section>
    </div>
  )
}
