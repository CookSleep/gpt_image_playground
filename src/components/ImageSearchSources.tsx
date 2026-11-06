import { useLayoutEffect, useRef, useState } from 'react'
import type { ImageSearchGrounding } from '../types'
import { useTooltip } from '../hooks/useTooltip'
import { openExternal } from '../lib/platform'
import { LinkIcon } from './icons'
import ViewportTooltip from './ViewportTooltip'

function SourceLink({ source }: { source: ImageSearchGrounding['sources'][number] }) {
  const tooltip = useTooltip()
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [ratio, setRatio] = useState(4 / 3)
  // 按原图比例定框：宽图限宽 192，竖图限高 256，短边不小于 96；超出范围的极端比例居中裁切
  const box = ratio >= 0.75
    ? { width: 192, height: Math.max(192 / ratio, 96) }
    : { width: Math.max(256 * ratio, 96), height: 256 }
  return (
    <div className="relative min-w-0">
      <a
        href={source.uri}
        target="_blank"
        rel="noopener noreferrer"
        {...(source.imageUri ? tooltip.handlers : {})}
        onClick={(e) => {
          e.preventDefault()
          tooltip.handlers.onClick()
          void openExternal(source.uri)
        }}
        onContextMenu={source.imageUri ? (e) => e.preventDefault() : undefined}
        className="flex min-w-0 select-none items-center gap-1.5 rounded-lg bg-gray-50 px-3 py-2 text-gray-700 transition [-webkit-touch-callout:none] hover:bg-gray-100 dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06]"
      >
        <LinkIcon className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
        <span className="min-w-0 truncate font-medium">{source.title}</span>
      </a>
      {source.imageUri && (
        <ViewportTooltip visible={tooltip.visible} className="w-[216px]">
          {/* 仅作展示不读取像素，无需 CORS；不发送 Referer 以免被防盗链拦截 */}
          <div className="relative mx-auto flex items-center justify-center overflow-hidden rounded bg-white/[0.06]" style={box}>
            {status !== 'error' && (
              <img
                src={source.imageUri}
                alt=""
                referrerPolicy="no-referrer"
                decoding="async"
                onLoad={(e) => {
                  const img = e.currentTarget
                  if (img.naturalWidth && img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight)
                  setStatus('loaded')
                }}
                onError={() => setStatus('error')}
                className={`h-full w-full object-cover transition-opacity ${status === 'loaded' ? 'opacity-100' : 'opacity-0'}`}
              />
            )}
            {status !== 'loaded' && (
              <span className="absolute text-gray-400">{status === 'error' ? '预览加载失败' : '加载中'}</span>
            )}
          </div>
          <div className="mt-1.5 truncate text-gray-300">{source.domain || source.title}</div>
        </ViewportTooltip>
      )}
    </div>
  )
}

// 样式对齐详情弹窗参数卡片；Google 搜索建议需原样展示，只覆盖外观
const SEARCH_ENTRY_STYLE = `html,body{margin:0!important;padding:0!important;background:transparent!important;overflow:hidden;font-size:12px;line-height:18px;color:#9ca3af}
.container{display:flex!important;align-items:flex-start!important;gap:8px!important;background:transparent!important;box-shadow:none!important;border:none!important;border-radius:0!important;padding:0!important;margin:0!important;font-family:inherit!important;font-size:12px!important;line-height:18px!important}
.headline{display:flex!important;align-items:center!important;gap:4px!important;height:24px!important;margin:0!important;flex-shrink:0!important}
.headline-label{color:#9ca3af!important}
.headline svg,.logo{width:14px!important;height:14px!important}
.logo-light{display:block!important}
.logo-dark{display:none!important}
.gradient-container,.gradient{display:none!important}
.carousel{display:flex!important;flex-wrap:wrap!important;gap:6px!important;min-width:0!important;white-space:normal!important;margin:0!important;overflow:visible!important}
.chip{display:inline-flex!important;align-items:center!important;margin:0!important;padding:2px 10px!important;min-width:0!important;font-size:12px!important;line-height:18px!important;font-weight:500!important;border-radius:9999px!important;border:1px solid #e5e7eb!important;background-color:#fff!important;color:#4b5563!important;text-decoration:none!important;transition:background-color .15s,color .15s}
.chip:hover{background-color:#f3f4f6!important;color:#374151!important}
html.dark .logo-light{display:none!important}
html.dark .logo-dark{display:block!important}
html.dark .chip{border-color:rgba(255,255,255,0.08)!important;background-color:rgba(255,255,255,0.04)!important;color:#d1d5db!important}
html.dark .chip:hover{background-color:rgba(255,255,255,0.08)!important;color:#f3f4f6!important}`

function SearchEntry({ content, index }: { content: string; index: number }) {
  const ref = useRef<HTMLIFrameElement>(null)

  useLayoutEffect(() => {
    const iframe = ref.current
    const doc = iframe?.contentDocument
    if (!iframe || !doc) return
    // 同步填充隔离文档，在首次绘制前设置主题并测量高度，避免默认浅色和 150px 高度闪现
    doc.open()
    doc.write(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:"><base target="_blank"></head><body>${content}<style>${SEARCH_ENTRY_STYLE}</style></body></html>`)
    doc.close()
    doc.body.style.fontFamily = getComputedStyle(document.body).fontFamily
    const syncTheme = () => doc.documentElement.classList.toggle('dark', document.documentElement.classList.contains('dark'))
    syncTheme()
    const fit = () => { iframe.style.height = `${Math.ceil(doc.body.getBoundingClientRect().height)}px` }
    fit()
    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(doc.body)
    resizeObserver.observe(iframe)
    const themeObserver = new MutationObserver(syncTheme)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a')
      if (!link) return
      event.preventDefault()
      if (/^https?:\/\//i.test(link.href)) void openExternal(link.href)
    }
    doc.addEventListener('click', onClick)
    return () => {
      resizeObserver.disconnect()
      themeObserver.disconnect()
      doc.removeEventListener('click', onClick)
    }
  }, [content])

  return <iframe ref={ref} title={`Google 搜索建议 ${index + 1}`} sandbox="allow-same-origin" referrerPolicy="no-referrer" className="mt-1 block w-full border-0 bg-transparent" />
}

export default function ImageSearchSources({ grounding }: { grounding?: ImageSearchGrounding[] }) {
  const items = (grounding ?? [])
    .map((item) => ({ renderedContent: item.renderedContent, sources: item.sources.filter((source) => /^https?:\/\//i.test(source.uri)) }))
    .filter((item) => item.renderedContent || item.sources.length)
  if (!items.length) return null
  return (
    <div className="mb-4" onClick={(e) => e.stopPropagation()}>
      <h3 className="mb-2 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
        搜索来源
      </h3>
      <div className="space-y-2 text-xs">
        {items.map((item, index) => (
          <div key={index} className="space-y-2">
            {item.renderedContent && (
              <div className="min-w-0 overflow-hidden rounded-lg bg-gray-50 px-3 py-2 dark:bg-white/[0.03]">
                <span className="text-gray-400 dark:text-gray-500">搜索建议</span>
                <SearchEntry content={item.renderedContent} index={index} />
              </div>
            )}
            {item.sources.length > 0 && (
              <div className="grid min-w-0 grid-cols-2 gap-2">
                {item.sources.map((source) => <SourceLink key={source.uri} source={source} />)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
