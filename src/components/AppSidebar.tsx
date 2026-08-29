import { BellIcon, ChevronLeftIcon, ChevronRightIcon, CollectionManageIcon, HomeIcon } from './icons'
import { useAuth } from '../auth/AuthContext'

export type AppView = 'workspace' | 'materials' | 'admin'

export default function AppSidebar({ view, collapsed, onChange, onCollapsedChange }: {
  view: AppView
  collapsed: boolean
  onChange: (view: AppView) => void
  onCollapsedChange: (collapsed: boolean) => void
}) {
  const { user } = useAuth()
  const isAdmin = Boolean(user?.is_admin)
  return (
    <>
      <aside className={`fixed bottom-0 left-0 top-16 z-30 hidden overflow-hidden border-r border-gray-200 bg-white/90 py-5 backdrop-blur transition-[width,padding] duration-300 ease-in-out dark:border-white/[0.08] dark:bg-gray-950/90 lg:block ${collapsed ? 'w-16 px-2' : 'w-56 px-3'}`}>
        <div className={`flex h-7 items-center ${collapsed ? 'justify-center' : 'justify-between px-3'}`}>
          <p className={`overflow-hidden whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 transition-[max-width,opacity] duration-200 ease-in-out dark:text-gray-500 ${collapsed ? 'pointer-events-none max-w-0 opacity-0' : 'max-w-32 opacity-100 delay-75'}`}>Workspace</p>
          <button
            type="button"
            onClick={() => onCollapsedChange(!collapsed)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            title={collapsed ? '展开侧边栏' : '收起侧边栏'}
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronRightIcon className="h-4 w-4" /> : <ChevronLeftIcon className="h-4 w-4" />}
          </button>
        </div>
        <nav className="mt-3 space-y-1" aria-label="主菜单">
          <button type="button" onClick={() => onChange('workspace')} className={`flex h-10 w-full items-center rounded-lg text-sm font-medium transition ${collapsed ? 'justify-center px-0' : 'gap-3 px-3 text-left'} ${view === 'workspace' ? 'bg-gray-100 text-gray-900 dark:bg-white/[0.08] dark:text-white' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.05] dark:hover:text-white'}`} title={collapsed ? '工作台' : undefined} aria-label="工作台">
            <HomeIcon className="h-[18px] w-[18px] shrink-0" />
            <span className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200 ease-in-out ${collapsed ? 'pointer-events-none max-w-0 opacity-0' : 'max-w-32 opacity-100 delay-75'}`}>工作台</span>
          </button>
          <button type="button" onClick={() => onChange('materials')} className={`flex h-10 w-full items-center rounded-lg text-sm font-medium transition ${collapsed ? 'justify-center px-0' : 'gap-3 px-3 text-left'} ${view === 'materials' ? 'bg-gray-100 text-gray-900 dark:bg-white/[0.08] dark:text-white' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.05] dark:hover:text-white'}`} title={collapsed ? '素材库' : undefined} aria-label="素材库">
            <CollectionManageIcon className="h-[18px] w-[18px] shrink-0" />
            <span className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200 ease-in-out ${collapsed ? 'pointer-events-none max-w-0 opacity-0' : 'max-w-32 opacity-100 delay-75'}`}>素材库</span>
          </button>
          {isAdmin && <>
            <div className="my-3 border-t border-gray-200 dark:border-white/[0.08]" />
            <div className={`flex h-7 items-center ${collapsed ? 'justify-center' : 'px-3'}`}>
              <p className={`overflow-hidden whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 transition-[max-width,opacity] duration-200 ease-in-out dark:text-gray-500 ${collapsed ? 'pointer-events-none max-w-0 opacity-0' : 'max-w-32 opacity-100 delay-75'}`}>管理员</p>
            </div>
            <button type="button" onClick={() => onChange('admin')} className={`flex h-10 w-full items-center rounded-lg text-sm font-medium transition ${collapsed ? 'justify-center px-0' : 'gap-3 px-3 text-left'} ${view === 'admin' ? 'bg-gray-100 text-gray-900 dark:bg-white/[0.08] dark:text-white' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.05] dark:hover:text-white'}`} title={collapsed ? '公告' : undefined} aria-label="公告">
              <BellIcon className="h-[18px] w-[18px] shrink-0" />
              <span className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200 ease-in-out ${collapsed ? 'pointer-events-none max-w-0 opacity-0' : 'max-w-32 opacity-100 delay-75'}`}>公告</span>
            </button>
          </>}
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
        {isAdmin && <>
          <div className="mx-1 h-5 border-l border-gray-200 dark:border-white/[0.08]" />
          <span className="shrink-0 px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400 dark:text-gray-500">管理员</span>
          <button type="button" onClick={() => onChange('admin')} className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium ${view === 'admin' ? 'bg-gray-100 text-gray-900 dark:bg-white/[0.08] dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>
            <BellIcon className="h-4 w-4" />
            公告
          </button>
        </>}
      </nav>
    </>
  )
}
