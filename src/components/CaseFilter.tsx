import type { CaseFilterDef, CaseCategoryDef } from '../types'

interface Props {
  categories: CaseCategoryDef[]
  styles: CaseFilterDef[]
  scenes: CaseFilterDef[]
  activeCategory: string | null
  activeStyle: string | null
  activeScene: string | null
  onCategoryChange: (c: string | null) => void
  onStyleChange: (s: string | null) => void
  onSceneChange: (s: string | null) => void
}

function FilterSection({
  label,
  items,
  activeValue,
  onChange,
}: {
  label: string
  items: { id: string; value: string; title: { zh: string } }[]
  activeValue: string | null
  onChange: (v: string | null) => void
}) {
  return (
    <div className="mb-3">
      <span className="text-xs font-medium text-gray-400 dark:text-gray-500 mr-2">{label}</span>
      <div className="inline-flex flex-wrap gap-1.5">
        {items.map((item) => {
          const isActive = activeValue === item.value
          return (
            <button
              key={item.id}
              onClick={() => onChange(isActive ? null : item.value)}
              className={`px-2.5 py-1 rounded-lg text-xs transition-all ${
                isActive
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'bg-gray-100 dark:bg-white/[0.06] text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-white/[0.1]'
              }`}
            >
              {item.title.zh}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function CaseFilter({
  categories,
  styles,
  scenes,
  activeCategory,
  activeStyle,
  activeScene,
  onCategoryChange,
  onStyleChange,
  onSceneChange,
}: Props) {
  return (
    <div data-no-drag-select className="mb-4 p-3 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900">
      <FilterSection label="分类" items={categories} activeValue={activeCategory} onChange={onCategoryChange} />
      <FilterSection label="风格" items={styles} activeValue={activeStyle} onChange={onStyleChange} />
      <FilterSection label="场景" items={scenes} activeValue={activeScene} onChange={onSceneChange} />
    </div>
  )
}
