import type { Project, TaskRecord } from '../types'

export function createLegacyProject(tasks: TaskRecord[], id: string): Project | null {
  if (tasks.length === 0) return null
  const createdAt = Math.min(...tasks.map((task) => task.createdAt))
  const updatedAt = Math.max(...tasks.map((task) => task.createdAt))
  return {
    id,
    title: '本地数据',
    initialPrompt: '',
    storage: 'local',
    createdAt,
    updatedAt,
  }
}
