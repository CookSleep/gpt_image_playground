import { downloadImagePathsAsZip } from './downloadImages'
import { sanitizeFileNamePart } from './exportFileName'

export interface ShotProjectTask {
  shotBatchId?: string
  shotIndex?: number
  shotProjectName?: string
  createdAt: number
  outputImages: string[]
}

export interface ShotProjectFile {
  imageId: string
  pathBase: string
}

export function groupTasksByProject<T extends { shotProjectName?: string; shotIndex?: number; createdAt: number }>(tasks: T[]) {
  const order: { name: string | null; tasks: T[] }[] = []
  const byName = new Map<string, (typeof order)[number]>()
  for (const task of tasks) {
    const name = task.shotProjectName?.trim() || null
    if (!name) {
      order.push({ name: null, tasks: [task] })
      continue
    }
    const found = byName.get(name)
    if (found) found.tasks.push(task)
    else {
      const group = { name, tasks: [task] }
      byName.set(name, group)
      order.push(group)
    }
  }
  for (const group of order) {
    if (!group.name) continue
    group.tasks.sort((a, b) => (a.shotIndex ?? 0) - (b.shotIndex ?? 0) || a.createdAt - b.createdAt)
  }
  return order
}

export function shotFolderName(index: number) {
  return `镜头${index}`
}

export function sanitizeProjectFolderName(name: string) {
  return sanitizeFileNamePart(name).replace(/[. ]+$/g, '') || '未命名项目'
}

export function selectShotProjectTasks<T extends ShotProjectTask>(tasks: T[], batchId: string | null, projectName: string) {
  const tagged = tasks.filter((task) => task.shotBatchId && task.shotIndex)
  if (batchId) {
    const batch = tagged.filter((task) => task.shotBatchId === batchId)
    if (batch.length) return sortShotTasks(batch)
  }

  const named = tagged.filter((task) => task.shotProjectName === projectName.trim())
  if (!named.length) return []
  const latest = named.reduce((best, task) => task.createdAt > best.createdAt ? task : best)
  return sortShotTasks(named.filter((task) => task.shotBatchId === latest.shotBatchId))
}

export function buildShotProjectFiles(tasks: ShotProjectTask[]): ShotProjectFile[] {
  const imagesByShot = new Map<number, string[]>()
  for (const task of [...tasks].sort((a, b) => (a.shotIndex ?? 0) - (b.shotIndex ?? 0) || a.createdAt - b.createdAt)) {
    if (!task.shotIndex || task.shotIndex < 1 || !task.outputImages.length) continue
    const images = imagesByShot.get(task.shotIndex) ?? []
    images.push(...task.outputImages)
    imagesByShot.set(task.shotIndex, images)
  }

  const files: ShotProjectFile[] = []
  for (const [index, imageIds] of imagesByShot) {
    const folder = shotFolderName(index)
    imageIds.forEach((imageId, imageIndex) => {
      const fileName = imageIds.length > 1 ? `${folder}-${imageIndex + 1}` : folder
      files.push({ imageId, pathBase: `${folder}/${fileName}` })
    })
  }
  return files
}

export async function exportShotProject(projectName: string, tasks: ShotProjectTask[]) {
  const folderName = sanitizeProjectFolderName(projectName)
  const files = buildShotProjectFiles(tasks)
  const missingCount = tasks.filter((task) => task.shotIndex && !task.outputImages.length).length
  if (!files.length) return { folderName, written: 0, missingCount }

  const result = await downloadImagePathsAsZip(
    files.map((file) => ({ ...file, pathBase: `${folderName}/${file.pathBase}` })),
    folderName,
  )
  return { folderName, written: result.successCount, missingCount }
}

function sortShotTasks<T extends ShotProjectTask>(tasks: T[]) {
  return [...tasks].sort((a, b) => (a.shotIndex ?? 0) - (b.shotIndex ?? 0) || a.createdAt - b.createdAt)
}
