import { useStore } from '../store'
import { updateProjectUrl } from '../lib/projectRoute'
import { CloudUploadIcon } from './icons'

export default function LegacyProjectToolbar() {
  const taskCount = useStore((s) => s.tasks.filter((task) => !task.projectId).length)
  const saving = useStore((s) => s.legacyProjectSaving)
  const saveLegacyProjectOnline = useStore((s) => s.saveLegacyProjectOnline)

  const saveOnline = async () => {
    await saveLegacyProjectOnline()
    const projectId = useStore.getState().activeProjectId
    if (projectId) updateProjectUrl(projectId, true)
  }

  return (
    <div data-no-drag-select className="mb-6 flex items-center justify-between gap-4 border-b border-gray-200 pb-4 dark:border-white/[0.08]">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold text-gray-900 dark:text-gray-100">本地数据</h2>
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">{taskCount} 个作品</p>
      </div>
      <button
        type="button"
        onClick={() => void saveOnline()}
        disabled={saving || taskCount === 0}
        className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-gray-950 px-4 text-sm font-medium text-white transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-55 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-200"
      >
        <CloudUploadIcon className={`h-4 w-4 ${saving ? 'animate-pulse' : ''}`} />
        {saving ? '保存中...' : '保存为在线项目'}
      </button>
    </div>
  )
}
