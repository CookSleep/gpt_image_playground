import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createInputImageFromFile, submitShotBatch, useStore } from '../store'
import type { InputImage } from '../types'
import { parseShotTemplate } from '../lib/shotTemplate'
import { cacheImage } from '../lib/imageCache'
import { getImage } from '../lib/db'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { CloseIcon } from './icons'

const TEMPLATE_KEY = 'gpt-image-shot-template'
const STYLE_IDS_KEY = 'gpt-image-shot-style-ids'
const PROJECT_NAME_KEY = 'gpt-image-shot-project-name'
const SHARED_PROMPT_KEY = 'gpt-image-shot-shared-prompt'
const MAX_STYLE_IMAGES = 16

const PLACEHOLDER = `### 片段 01
镜头：一张横向工作台位于画面左侧，钥匙放在桌面中央。
声音：纸张翻开，钥匙发出短促咔哒声。

### 片段 02
镜头：钥匙沿轨道滑到画面右侧，落入一只陌生的手里。
声音：滑轨声之后是一声锁扣。`

interface ShotTemplatePanelProps {
  onClose: () => void
}

function readStyleIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STYLE_IDS_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export default function ShotTemplatePanel({ onClose }: ShotTemplatePanelProps) {
  const showToast = useStore((s) => s.showToast)
  const imageCount = useStore((s) => s.params.n)
  const modalRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [template, setTemplate] = useState(() => localStorage.getItem(TEMPLATE_KEY) || '')
  const [projectName, setProjectName] = useState(() => localStorage.getItem(PROJECT_NAME_KEY) || '')
  const [sharedPrompt, setSharedPrompt] = useState(() => localStorage.getItem(SHARED_PROMPT_KEY) || '')
  const [styleImages, setStyleImages] = useState<InputImage[]>([])
  const [stylesReady, setStylesReady] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const shots = useMemo(() => parseShotTemplate(template), [template])

  useCloseOnEscape(true, onClose)
  usePreventBackgroundScroll(true, modalRef)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const images: InputImage[] = []
      for (const id of readStyleIds()) {
        const stored = await getImage(id)
        if (!stored?.dataUrl) continue
        cacheImage(id, stored.dataUrl)
        images.push({ id, dataUrl: stored.dataUrl })
      }
      if (!cancelled) {
        setStyleImages(images.slice(0, MAX_STYLE_IMAGES))
        setStylesReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(TEMPLATE_KEY, template)
  }, [template])

  useEffect(() => {
    localStorage.setItem(PROJECT_NAME_KEY, projectName)
  }, [projectName])

  useEffect(() => {
    localStorage.setItem(SHARED_PROMPT_KEY, sharedPrompt)
  }, [sharedPrompt])

  useEffect(() => {
    if (!stylesReady) return
    localStorage.setItem(STYLE_IDS_KEY, JSON.stringify(styleImages.map((img) => img.id)))
  }, [stylesReady, styleImages])

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'))
      if (!files.length) return
      event.preventDefault()
      void addFiles(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [styleImages])

  async function addFiles(files: File[]) {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (!images.length) {
      showToast('请上传图片文件', 'error')
      return
    }
    const room = MAX_STYLE_IMAGES - styleImages.length
    if (room <= 0) {
      showToast('样式图最多 16 张', 'error')
      return
    }
    const accepted = images.slice(0, room)
    if (accepted.length < images.length) showToast('样式图最多 16 张，多出的没有加入', 'info')
    const created: InputImage[] = []
    for (const file of accepted) {
      const image = await createInputImageFromFile(file)
      if (image) created.push(image)
    }
    if (!created.length) return
    setStyleImages((prev) => {
      const seen = new Set(prev.map((img) => img.id))
      const next = [...prev]
      for (const image of created) {
        if (seen.has(image.id) || next.length >= MAX_STYLE_IMAGES) continue
        seen.add(image.id)
        next.push(image)
      }
      return next
    })
  }

  async function handleSubmit() {
    if (submitting) return
    if (!styleImages.length) {
      showToast('请先添加样式图', 'error')
      return
    }
    if (!shots.length) {
      showToast('没有解析到镜头，请按「镜头：」填写', 'error')
      return
    }
    setSubmitting(true)
    try {
      const result = await submitShotBatch(shots, styleImages, projectName.trim(), sharedPrompt)
      if (result.count > 0) onClose()
    } catch (err) {
      showToast(err instanceof Error ? err.message : '提交失败', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div data-no-drag-select className="fixed inset-0 z-[65] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" />
      <div
        ref={modalRef}
        className="relative z-10 flex max-h-[88vh] w-full max-w-3xl flex-col rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">镜头模板生图</h3>
            <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
              粘贴带「镜头：」「声音：」的模板。每个镜头会单独生图，并把样式图作为参考图提交。声音只用于核对，不会送进画面提示词。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1 custom-scrollbar">
          <section>
            <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">项目名称</h4>
            <input
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="例如：河流与城市"
              className="w-full rounded-2xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none transition placeholder:text-gray-400 focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-100"
            />
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-200">样式图</h4>
              <span className="text-xs text-gray-400">{styleImages.length}/{MAX_STYLE_IMAGES}</span>
            </div>
            <div
              className={`rounded-2xl border border-dashed p-3 transition-colors ${dragging ? 'border-blue-400 bg-blue-50/80 dark:bg-blue-500/10' : 'border-gray-200 dark:border-white/[0.08]'}`}
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                void addFiles(Array.from(event.dataTransfer.files))
              }}
            >
              <div className="flex flex-wrap gap-2">
                {styleImages.map((img, index) => (
                  <div key={img.id} className="relative h-16 w-16 overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.08]">
                    <img src={img.dataUrl} alt={`样式图 ${index + 1}`} className="h-full w-full object-cover" />
                    <button
                      type="button"
                      className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white"
                      aria-label={`移除样式图 ${index + 1}`}
                      onClick={() => setStyleImages((prev) => prev.filter((item) => item.id !== img.id))}
                    >
                      <CloseIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex h-16 w-16 flex-col items-center justify-center rounded-xl border border-gray-200 text-[11px] text-gray-500 transition hover:border-gray-300 hover:text-gray-700 dark:border-white/[0.08] dark:hover:text-gray-200"
                >
                  添加
                  <span className="text-[10px] text-gray-400">或拖入</span>
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = event.target.files ? Array.from(event.target.files) : []
                  event.target.value = ''
                  void addFiles(files)
                }}
              />
            </div>
          </section>

          <section>
            <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">统一提示词</h4>
            <textarea
              value={sharedPrompt}
              onChange={(event) => setSharedPrompt(event.target.value)}
              placeholder="所有镜头都会带上这段，例如：16:9 横屏，电影感光影，不要画面文字"
              className="h-20 w-full resize-y rounded-2xl border border-gray-200 bg-white px-3 py-2 text-sm leading-6 text-gray-800 outline-none transition placeholder:text-gray-400 focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-100"
            />
          </section>

          <section>
            <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">模板</h4>
            <textarea
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              placeholder={PLACEHOLDER}
              className="h-40 w-full resize-y rounded-2xl border border-gray-200 bg-white px-3 py-2 text-sm leading-6 text-gray-800 outline-none transition placeholder:text-gray-400 focus:border-blue-400 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-100"
            />
          </section>

          <section>
            <h4 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">
              解析结果{shots.length ? ` · ${shots.length} 个镜头` : ''}
            </h4>
            {sharedPrompt.trim() && (
              <p className="mb-2 text-xs leading-5 text-gray-500 dark:text-gray-400">每个镜头都会先带上统一提示词。</p>
            )}
            {shots.length ? (
              <div className="space-y-2">
                {shots.map((shot) => (
                  <article key={`${shot.index}-${shot.title}`} className="rounded-2xl bg-gray-50 px-3 py-2 dark:bg-white/[0.04]">
                    <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{shot.title}</div>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-gray-800 dark:text-gray-100">{shot.shot}</p>
                    {shot.action && (
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-gray-500 dark:text-gray-400">动作：{shot.action}</p>
                    )}
                    {shot.sound && (
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-gray-500 dark:text-gray-400">音频：{shot.sound}</p>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">还没有解析到镜头。</p>
            )}
          </section>
        </div>

        <div className="mt-4 flex flex-col gap-3 border-t border-gray-100 pt-4 dark:border-white/[0.06] sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-gray-400">
            使用当前 API 配置、尺寸和质量。{imageCount > 1 ? `每个镜头会生成 ${imageCount} 张。` : '每个镜头生成 1 张。'}
          </p>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || !shots.length || !styleImages.length}
            className="shrink-0 rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            {submitting ? '提交中…' : `按镜头生图${shots.length ? `（${shots.length}）` : ''}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
