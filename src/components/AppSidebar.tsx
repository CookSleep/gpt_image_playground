import { CollectionManageIcon, HomeIcon } from './icons'

export type AppView = 'workspace' | 'materials'

export default function AppSidebar({ view, onChange }: { view: AppView; onChange: (view: AppView) => void }) {
  return (
    <>
      <aside className="fixed bottom-0 left-0 top-16 z-30 hidden w-56 border-r border-gray-200 bg-white/90 px-3 py-5 backdrop-blur dark:border-white/[0.08] dark:bg-gray-950/90 lg:block">
        <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-gray-500">Workspace</p>
        <nav className="mt-3 space-y-1" aria-label="主菜单">
          <button type="button" onClick={() => onChange('workspace')} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition ${view === 'workspace' ? 'bg-gray-100 text-gray-900 dark:bg-white/[0.08] dark:text-white' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.05] dark:hover:text-white'}`}>
            <HomeIcon className="h-[18px] w-[18px]" />
            工作台
          </button>
          <button type="button" onClick={() => onChange('materials')} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition ${view === 'materials' ? 'bg-gray-100 text-gray-900 dark:bg-white/[0.08] dark:text-white' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.05] dark:hover:text-white'}`}>
            <CollectionManageIcon className="h-[18px] w-[18px]" />
            素材库
          </button>
        </nav>
      </aside>
      <nav className="fixed left-0 right-0 top-16 z-30 flex h-11 items-center gap-1 border-b border-gray-200 bg-white/95 px-3 backdrop-blur dark:border-white/[0.08] dark:bg-gray-950/95 lg:hidden" aria-label="主菜单">
        <button type="button" onClick={() => onChange('workspace')} className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium ${view === 'workspace' ? 'bg-gray-100 text-gray-900 dark:bg-white/[0.08] dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>
          <HomeIcon className="h-4 w-4" />
          工作台
        </button>
        <button type="button" onClick={() => onChange('materials')} className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium ${view === 'materials' ? 'bg-gray-100 text-gray-900 dark:bg-white/[0.08] dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>
          <CollectionManageIcon className="h-4 w-4" />
          素材库
        </button>
      </nav>
    </>
  )
}
