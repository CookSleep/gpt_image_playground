import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { useStore } from '../store'
import { fetchCases, fetchStyleLibrary } from '../data/caseData'
import type { CaseRecord, CaseStyleLibrary } from '../types'
import CaseFilter from './CaseFilter'
import CaseCard from './CaseCard'
import CasePreview from './CasePreview'

const BATCH_SIZE = 24

type LoadState = 'loading' | 'loaded' | 'error'

export default function CaseGallery() {
  const caseSearchQuery = useStore((s) => s.caseSearchQuery)
  const setCaseSearchQuery = useStore((s) => s.setCaseSearchQuery)
  const caseFilterCategory = useStore((s) => s.caseFilterCategory)
  const setCaseFilterCategory = useStore((s) => s.setCaseFilterCategory)
  const caseFilterStyle = useStore((s) => s.caseFilterStyle)
  const setCaseFilterStyle = useStore((s) => s.setCaseFilterStyle)
  const caseFilterScene = useStore((s) => s.caseFilterScene)
  const setCaseFilterScene = useStore((s) => s.setCaseFilterScene)
  const showToast = useStore((s) => s.showToast)

  const [cases, setCases] = useState<CaseRecord[]>([])
  const [styleLib, setStyleLib] = useState<CaseStyleLibrary | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE)
  const [previewCase, setPreviewCase] = useState<CaseRecord | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoadState('loading')
      try {
        const [casesData, styleData] = await Promise.all([fetchCases(), fetchStyleLibrary()])
        if (cancelled) return
        setCases(casesData)
        setStyleLib(styleData)
        setLoadState('loaded')
      } catch (err) {
        if (cancelled) return
        setErrorMessage(err instanceof Error ? err.message : '加载失败')
        setLoadState('error')
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const filteredCases = useMemo(() => {
    let result = cases
    const q = caseSearchQuery.trim().toLowerCase()

    if (caseFilterCategory) {
      result = result.filter((c) => c.category === caseFilterCategory)
    }
    if (caseFilterStyle) {
      result = result.filter((c) => c.styles.includes(caseFilterStyle))
    }
    if (caseFilterScene) {
      result = result.filter((c) => c.scenes.includes(caseFilterScene))
    }
    if (q) {
      result = result.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.sourceLabel.toLowerCase().includes(q) ||
          c.prompt.toLowerCase().includes(q),
      )
    }
    return result
  }, [cases, caseSearchQuery, caseFilterCategory, caseFilterStyle, caseFilterScene])

  useEffect(() => {
    setVisibleCount(BATCH_SIZE)
  }, [caseSearchQuery, caseFilterCategory, caseFilterStyle, caseFilterScene])

  const visibleCases = useMemo(
    () => filteredCases.slice(0, visibleCount),
    [filteredCases, visibleCount],
  )

  const hasMore = visibleCases.length < filteredCases.length

  const loadMore = useCallback(() => {
    setVisibleCount((prev) => prev + BATCH_SIZE)
  }, [])

  useEffect(() => {
    if (!hasMore) return
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMore()
      },
      { rootMargin: '400px' },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadMore])

  const handleCopyPrompt = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => showToast('Prompt 已复制'),
      () => showToast('复制失败', 'error'),
    )
  }

  const handleOpenPreview = (caseItem: CaseRecord) => {
    setPreviewCase(caseItem)
    document.body.style.overflow = 'hidden'
  }

  const handleClosePreview = () => {
    setPreviewCase(null)
    document.body.style.overflow = ''
  }

  // 关闭弹窗的键盘事件
  useEffect(() => {
    if (!previewCase) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClosePreview()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [previewCase])

  if (loadState === 'loading') {
    return (
      <main data-home-main className="pb-48">
        <div className="safe-area-x max-w-7xl mx-auto mt-6">
          <div className="flex items-center justify-center py-20 text-gray-400">
            <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            加载案例数据...
          </div>
        </div>
      </main>
    )
  }

  if (loadState === 'error') {
    return (
      <main data-home-main className="pb-48">
        <div className="safe-area-x max-w-7xl mx-auto mt-6">
          <div className="flex flex-col items-center justify-center py-20 text-gray-400 gap-3">
            <span className="text-red-500">加载失败: {errorMessage}</span>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-blue-500 text-white text-sm hover:bg-blue-600 transition-colors"
            >
              重试
            </button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <>
      <main data-home-main className="pb-48">
        <div className="safe-area-x max-w-7xl mx-auto">
          {/* Search */}
          <div data-no-drag-select className="mt-6 mb-4 flex gap-3">
            <div className="relative flex-1 z-10">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                value={caseSearchQuery}
                onChange={(e) => setCaseSearchQuery(e.target.value)}
                type="text"
                placeholder="搜索案例、来源、Prompt..."
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
              />
            </div>
          </div>

          {/* Filters */}
          {styleLib && (
            <CaseFilter
              categories={styleLib.categories}
              styles={styleLib.styles}
              scenes={styleLib.scenes}
              activeCategory={caseFilterCategory}
              activeStyle={caseFilterStyle}
              activeScene={caseFilterScene}
              onCategoryChange={setCaseFilterCategory}
              onStyleChange={setCaseFilterStyle}
              onSceneChange={setCaseFilterScene}
            />
          )}

          {/* Result bar */}
          <div data-no-drag-select className="mb-4 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <span className="font-medium text-gray-700 dark:text-gray-300">{filteredCases.length}</span>
            <span>个匹配案例</span>
            <span className="text-xs text-gray-400">
              (已加载 {visibleCases.length} 个)
            </span>
            <a
              href="https://github.com/freestylefly/awesome-gpt-image-2"
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-xs text-blue-500 hover:underline"
            >
              GitHub 数据源
            </a>
          </div>

          {/* Grid — CSS columns for masonry-like layout */}
          <div className="columns-1 sm:columns-2 lg:columns-3 gap-4 [&>*]:break-inside-avoid [&>*]:mb-4">
            {visibleCases.map((c) => (
              <CaseCard
                key={c.id}
                caseItem={c}
                onCopyPrompt={handleCopyPrompt}
                onOpenPreview={handleOpenPreview}
              />
            ))}
          </div>

          {/* Sentinel for infinite scroll */}
          {hasMore && (
            <div ref={sentinelRef} className="flex items-center justify-center py-8 text-gray-400 text-sm">
              <svg className="w-4 h-4 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              加载更多...
            </div>
          )}

          {filteredCases.length === 0 && (
            <p className="mt-10 text-center text-sm text-gray-400">没有匹配的案例，试试调整筛选条件。</p>
          )}
        </div>
      </main>

      {/* Detail Preview Modal */}
      {previewCase && (
        <CasePreview
          caseItem={previewCase}
          onClose={handleClosePreview}
          onCopyPrompt={handleCopyPrompt}
        />
      )}
    </>
  )
}
