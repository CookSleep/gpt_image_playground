import { memo, useEffect, useState, type ComponentProps } from 'react'
import type { Components, ExtraProps, MathPlugin, StreamdownTranslations } from 'streamdown'
import type { Components as ReactMarkdownComponents } from 'react-markdown'

type MarkdownRendererProps = {
  content: string
  streaming?: boolean
  className?: string
}

type StreamdownComponent = typeof import('streamdown')['Streamdown']
type ReactMarkdownComponent = typeof import('react-markdown')['default']
type RemarkGfmPlugin = typeof import('remark-gfm')['default']
type LegacyMarkdownModule = {
  ReactMarkdown: ReactMarkdownComponent
  remarkGfm: RemarkGfmPlugin
}
type MathMarkdownModule = {
  math: MathPlugin
}
type MarkdownRendererState =
  | { type: 'loading' }
  | { type: 'modern'; Component: StreamdownComponent; math: MathMarkdownModule }
  | { type: 'legacy'; module: LegacyMarkdownModule }
  | { type: 'plain' }

const allowedUrlProtocols = new Set(['http:', 'https:', 'mailto:', 'tel:'])

// streamdown 2.5 的图片组件自带下载按钮且没有关闭选项，这里渲染为普通图片；src 已经过 urlTransform 与 sanitize 处理
function MarkdownImage({ node: _node, src, onError, ...props }: ComponentProps<'img'> & ExtraProps) {
  const [failedSrc, setFailedSrc] = useState<typeof src>()
  if (!src) return null
  if (failedSrc === src) return <span className="text-muted-foreground text-xs italic">图片不可用</span>
  return (
    <img
      {...props}
      src={src}
      onError={(event) => {
        setFailedSrc(src)
        onError?.(event)
      }}
    />
  )
}

function safeUrl(url: string) {
  try {
    const parsed = new URL(url, window.location.origin)
    return allowedUrlProtocols.has(parsed.protocol) ? url : '#blocked'
  } catch {
    return '#blocked'
  }
}

const markdownComponents: Components = {
  a({ children, href, node: _node, ...props }) {
    const shouldOpenBlank = Boolean(href && href !== '#blocked')
    return (
      <a
        {...props}
        href={href}
        rel={shouldOpenBlank ? 'noreferrer' : undefined}
        target={shouldOpenBlank ? '_blank' : undefined}
      >
        {children}
      </a>
    )
  },
  img: MarkdownImage,
}

const legacyMarkdownComponents: ReactMarkdownComponents = {
  a({ children, href, ...props }) {
    const safeHref = safeUrl(href ?? '')
    const shouldOpenBlank = safeHref !== '#blocked'
    return (
      <a
        {...props}
        href={safeHref}
        rel={shouldOpenBlank ? 'noreferrer' : undefined}
        target={shouldOpenBlank ? '_blank' : undefined}
      >
        {children}
      </a>
    )
  },
}

const translations: Partial<StreamdownTranslations> = {
  copied: '已复制',
  copyCode: '复制代码',
  copyLink: '复制链接',
  copyTable: '复制表格',
  copyTableAsCsv: '复制为 CSV',
  copyTableAsMarkdown: '复制为 Markdown',
  copyTableAsTsv: '复制为 TSV',
  downloadFile: '下载文件',
  downloadImage: '下载图片',
  downloadTable: '下载表格',
  downloadTableAsCsv: '下载为 CSV',
  downloadTableAsMarkdown: '下载为 Markdown',
  externalLinkWarning: '即将打开外部链接',
  imageNotAvailable: '图片不可用',
  openExternalLink: '打开外部链接',
  openLink: '打开链接',
  tableFormatCsv: 'CSV',
  tableFormatMarkdown: 'Markdown',
  tableFormatTsv: 'TSV',
  viewFullscreen: '全屏查看',
}

const canLoadStreamdown = (() => {
  try {
    new RegExp('(?<=a)b')
    return typeof (Array.prototype as { at?: unknown }).at === 'function'
  } catch {
    return false
  }
})()

let streamdownPromise: Promise<MarkdownRendererState> | null = null
let legacyMarkdownPromise: Promise<MarkdownRendererState> | null = null
// 加载完成后新挂载的组件直接用它渲染，不再先显示一帧原文
let loadedRenderer: MarkdownRendererState | null = null

function loadLegacyMarkdown() {
  legacyMarkdownPromise ??= Promise.all([import('react-markdown'), import('remark-gfm')])
    .then(([reactMarkdown, remarkGfm]) => ({
      type: 'legacy' as const,
      module: {
        ReactMarkdown: reactMarkdown.default,
        remarkGfm: remarkGfm.default,
      },
    }))
    .catch((error) => {
      console.error('Legacy markdown renderer failed to load:', error)
      return { type: 'plain' as const }
    })

  return legacyMarkdownPromise
}

function loadMarkdownRenderer() {
  return (canLoadStreamdown ? loadStreamdown() : loadLegacyMarkdown()).then((next) => (loadedRenderer = next))
}

/** 渲染库较大，不放进首屏；页面空闲时预加载，打开公告、更新日志或 Agent 对话时可以直接渲染 */
export function preloadMarkdownRenderer() {
  void loadMarkdownRenderer()
}

function loadStreamdown() {
  streamdownPromise ??= Promise.all([
    import('streamdown'),
    import('@streamdown/math'),
  ])
    .then(([streamdown, math]) => ({
      type: 'modern' as const,
      Component: streamdown.Streamdown,
      math: {
        math: math.createMathPlugin({
          errorColor: 'var(--muted-foreground)',
          singleDollarTextMath: true,
        }),
      },
    }))
    .catch((error) => {
      console.error('Streamdown failed to load:', error)
      return loadLegacyMarkdown()
    })

  return streamdownPromise!
}

function PlainTextMarkdown({ content, className = '', hidden = false }: MarkdownRendererProps & { hidden?: boolean }) {
  return (
    <div
      className={`markdown-renderer ${className}`.trim()}
      dir="auto"
      style={{ whiteSpace: 'pre-wrap', visibility: hidden ? 'hidden' : undefined }}
    >
      {content}
    </div>
  )
}

const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  streaming = false,
  className = '',
}: MarkdownRendererProps) {
  const [renderer, setRenderer] = useState<MarkdownRendererState>(() => loadedRenderer ?? { type: 'loading' })
  const [showRawText, setShowRawText] = useState(false)

  useEffect(() => {
    if (renderer.type !== 'loading') return
    let disposed = false
    // 渲染库通常很快就能加载完，先隐藏原文并保留占位，加载较慢时再显示原文
    const timer = setTimeout(() => setShowRawText(true), 300)

    loadMarkdownRenderer().then((nextRenderer) => {
      if (!disposed) setRenderer(nextRenderer)
    })

    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [renderer.type])

  if (renderer.type === 'legacy') {
    const { ReactMarkdown, remarkGfm } = renderer.module
    return (
      <div className={`markdown-renderer ${className}`.trim()} dir="auto">
        <ReactMarkdown
          components={legacyMarkdownComponents}
          remarkPlugins={[remarkGfm]}
          urlTransform={safeUrl}
        >
          {content}
        </ReactMarkdown>
      </div>
    )
  }

  if (renderer.type !== 'modern') {
    return <PlainTextMarkdown content={content} className={className} hidden={renderer.type === 'loading' && !showRawText} />
  }

  const StreamdownComponent = renderer.Component

  // 原始 HTML 由 streamdown 默认的 rehype 链（raw → sanitize → harden）清洗，skipHtml 对已解析的 HTML 不起作用。
  // 不要传入自定义 rehypePlugins（会替换默认链，sanitize 随之失效）或 allowedTags（会放宽 sanitize 白名单）。
  return (
    <StreamdownComponent
      className={`markdown-renderer ${className}`.trim()}
      components={markdownComponents}
      controls={{
        code: { copy: true, download: false },
        mermaid: false,
        table: { copy: true, download: false, fullscreen: true },
      }}
      dir="auto"
      isAnimating={streaming}
      lineNumbers={false}
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      plugins={{ math: renderer.math.math }}
      translations={translations}
      urlTransform={safeUrl}
    >
      {content}
    </StreamdownComponent>
  )
})

export default MarkdownRenderer
