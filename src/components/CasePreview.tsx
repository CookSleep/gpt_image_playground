import { useEffect, useState, useCallback } from 'react'
import type { CaseRecord } from '../types'
import { getImageUrl } from '../data/caseData'

interface Props {
  caseItem: CaseRecord
  onClose: () => void
  onCopyPrompt: (text: string) => void
}

export default function CasePreview({ caseItem, onClose, onCopyPrompt }: Props) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const tags = [...new Set([...caseItem.styles, ...caseItem.scenes])].slice(0, 8)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (lightboxOpen) {
        if (e.key === 'Escape') setLightboxOpen(false)
        return
      }
      if (e.key === 'Escape') onClose()
    },
    [lightboxOpen, onClose],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-4 sm:p-6"
        role="presentation"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div
          className="relative w-full max-w-4xl my-8 bg-white dark:bg-gray-900 rounded-2xl shadow-2xl overflow-hidden"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
            aria-label="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {/* Clickable image */}
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="block w-full bg-gray-100 dark:bg-gray-950 cursor-zoom-in border-0 p-0"
          >
            <img
              src={getImageUrl(caseItem.image)}
              alt={caseItem.imageAlt}
              className="w-full max-h-[55vh] object-contain"
            />
          </button>

          <div className="p-5 sm:p-6">
            <div className="flex flex-wrap gap-2 text-xs font-extrabold uppercase text-cyan-600 dark:text-cyan-400 mb-3">
              <span>案例 {caseItem.id}</span>
              <span>{caseItem.category}</span>
            </div>

            <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white mb-3">
              {caseItem.title}
            </h2>

            <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed mb-4">
              {caseItem.promptPreview || caseItem.prompt.slice(0, 300)}
            </p>

            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-5">
                {tags.map((tag) => (
                  <span
                    key={`${caseItem.id}-${tag}`}
                    className="px-2.5 py-1 rounded-full text-xs bg-gray-100 dark:bg-white/[0.07] text-gray-600 dark:text-gray-400"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2 mb-6">
              <button
                type="button"
                onClick={() => onCopyPrompt(caseItem.prompt)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 dark:border-white/[0.1] bg-gray-50 dark:bg-white/[0.06] text-gray-700 dark:text-gray-300 text-sm font-bold hover:bg-gray-100 dark:hover:bg-white/[0.1] transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                复制 Prompt
              </button>
              <a
                href={caseItem.githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 dark:border-white/[0.1] bg-gray-50 dark:bg-white/[0.06] text-gray-700 dark:text-gray-300 text-sm font-bold hover:bg-gray-100 dark:hover:bg-white/[0.1] transition-colors"
              >
                GitHub 源文件
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
              {caseItem.sourceUrl && (
                <a
                  href={caseItem.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-200 dark:border-white/[0.1] bg-gray-50 dark:bg-white/[0.06] text-gray-700 dark:text-gray-300 text-sm font-bold hover:bg-gray-100 dark:hover:bg-white/[0.1] transition-colors"
                >
                  来源
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              )}
            </div>

            <div>
              <h3 className="text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">完整 Prompt</h3>
              <pre className="p-4 rounded-xl bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-white/[0.08] text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-mono leading-relaxed max-h-[400px] overflow-y-auto">
                {caseItem.prompt}
              </pre>
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox */}
      {lightboxOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/95 flex items-center justify-center p-4"
          role="presentation"
          onClick={() => setLightboxOpen(false)}
        >
          <button
            type="button"
            onClick={() => setLightboxOpen(false)}
            className="absolute top-4 right-4 z-10 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
            aria-label="关闭"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <img
            src={getImageUrl(caseItem.image)}
            alt={caseItem.imageAlt}
            className="max-w-full max-h-full object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  )
}
