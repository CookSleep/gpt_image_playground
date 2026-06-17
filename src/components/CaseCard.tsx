import { useState } from 'react'
import type { CaseRecord } from '../types'
import { getImageUrl } from '../data/caseData'

interface Props {
  caseItem: CaseRecord
  onCopyPrompt: (text: string) => void
  onOpenPreview: (item: CaseRecord) => void
}

export default function CaseCard({ caseItem, onCopyPrompt, onOpenPreview }: Props) {
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgError, setImgError] = useState(false)

  const tags = [...new Set([...caseItem.styles, ...caseItem.scenes])].slice(0, 4)

  return (
    <article
      className="rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 overflow-hidden flex flex-col hover:-translate-y-1 hover:border-cyan-400/50 hover:shadow-lg transition-all duration-200"
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 340px' }}
    >
      {/* Image */}
      <button
        type="button"
        onClick={() => onOpenPreview(caseItem)}
        className="relative block w-full overflow-hidden bg-gray-100 dark:bg-white/[0.05] cursor-pointer border-0 p-0 text-left group"
      >
        {!imgError ? (
          <img
            src={getImageUrl(caseItem.image)}
            alt={caseItem.imageAlt}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
            className={`w-full h-auto block transition-all duration-300 ${imgLoaded ? 'opacity-100' : 'opacity-0'} group-hover:scale-[1.025]`}
          />
        ) : (
          <div className="w-full aspect-[4/3] flex items-center justify-center text-gray-400 text-sm bg-gray-100 dark:bg-white/[0.05]">
            图片加载失败
          </div>
        )}
        {!imgLoaded && !imgError && (
          <div className="absolute inset-0 aspect-[4/3] animate-pulse bg-gray-200 dark:bg-white/[0.06]" />
        )}
        <span className="absolute left-2.5 top-2.5 px-2 py-1 rounded-md text-[11px] font-black bg-black/70 text-white backdrop-blur-sm">
          案例 {caseItem.id}
        </span>
        <span className="absolute right-2.5 bottom-2.5 inline-flex items-center gap-1.5 px-2 py-1.5 rounded-md border border-cyan-400/40 bg-black/70 text-cyan-50 text-xs font-black opacity-0 translate-y-1.5 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 pointer-events-none">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          查看详情
        </span>
      </button>

      <div className="flex flex-col flex-1 p-3">
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] font-extrabold uppercase tracking-wide text-cyan-600 dark:text-cyan-400 mb-1.5">
          <span>{caseItem.category}</span>
          {caseItem.sourceUrl ? (
            <a
              href={caseItem.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-600 dark:text-emerald-400 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {caseItem.sourceLabel}
            </a>
          ) : (
            <span className="text-emerald-600 dark:text-emerald-400">{caseItem.sourceLabel}</span>
          )}
        </div>

        <h3 className="text-base font-bold leading-tight text-gray-800 dark:text-gray-100 mb-1">
          {caseItem.title}
        </h3>

        <p className="text-[11px] text-gray-500 dark:text-gray-400 leading-relaxed line-clamp-2 mb-2">
          {caseItem.promptPreview || caseItem.prompt.slice(0, 200)}
        </p>

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {tags.map((tag) => (
              <span
                key={`${caseItem.id}-${tag}`}
                className="px-1.5 py-0.5 rounded-full text-[10px] bg-gray-100 dark:bg-white/[0.06] text-gray-500 dark:text-gray-400"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="grid grid-cols-3 gap-1.5 pt-2 border-t border-gray-100 dark:border-white/[0.06]">
          <button
            type="button"
            onClick={() => onCopyPrompt(caseItem.prompt)}
            className="inline-flex items-center justify-center gap-1 py-1 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.04] text-gray-600 dark:text-gray-400 text-[11px] font-bold hover:bg-gray-100 dark:hover:bg-white/[0.08] transition-colors"
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            复制
          </button>
          <button
            type="button"
            onClick={() => onOpenPreview(caseItem)}
            className="inline-flex items-center justify-center gap-1 py-1 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.04] text-gray-600 dark:text-gray-400 text-[11px] font-bold hover:bg-gray-100 dark:hover:bg-white/[0.08] transition-colors"
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            详情
          </button>
          <a
            href={caseItem.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center py-1 rounded-lg border border-gray-200 dark:border-white/[0.08] bg-gray-50 dark:bg-white/[0.04] text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-white/[0.08] transition-colors"
            onClick={(e) => e.stopPropagation()}
            title="GitHub"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      </div>
    </article>
  )
}
