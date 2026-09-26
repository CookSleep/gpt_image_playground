import { describe, expect, it } from 'vitest'
import { buildShotProjectFiles, groupTasksByProject, sanitizeProjectFolderName, selectShotProjectTasks, shotFolderName } from './shotProjectExport'

const task = (patch: {
  shotBatchId: string
  shotIndex: number
  shotProjectName: string
  createdAt: number
  outputImages?: string[]
}) => ({
  outputImages: [],
  ...patch,
})

describe('groupTasksByProject', () => {
  it('wraps one project together and keeps loose tasks separate', () => {
    const groups = groupTasksByProject([
      { shotProjectName: '河流', shotIndex: 2, createdAt: 3 },
      { shotProjectName: '', shotIndex: 1, createdAt: 2 },
      { shotProjectName: '河流', shotIndex: 1, createdAt: 1 },
    ])
    expect(groups.map((group) => group.name)).toEqual(['河流', null])
    expect(groups[0].tasks.map((task) => task.shotIndex)).toEqual([1, 2])
  })
})

describe('shot project export paths', () => {
  it('names folders 镜头1 through 镜头13 without padding', () => {
    expect(shotFolderName(1)).toBe('镜头1')
    expect(shotFolderName(13)).toBe('镜头13')
    expect(buildShotProjectFiles([
      task({ shotBatchId: 'a', shotIndex: 1, shotProjectName: '河流', createdAt: 2, outputImages: ['img-1'] }),
      task({ shotBatchId: 'a', shotIndex: 13, shotProjectName: '河流', createdAt: 1, outputImages: ['img-13'] }),
    ]).map((file) => file.pathBase)).toEqual([
      '镜头1/镜头1',
      '镜头13/镜头13',
    ])
  })

  it('puts several images from one shot in the same folder', () => {
    expect(buildShotProjectFiles([
      task({ shotBatchId: 'a', shotIndex: 2, shotProjectName: '河流', createdAt: 1, outputImages: ['a', 'b'] }),
    ]).map((file) => file.pathBase)).toEqual([
      '镜头2/镜头2-1',
      '镜头2/镜头2-2',
    ])
  })

  it('exports the selected batch and ignores shots without images', () => {
    const tasks = [
      task({ shotBatchId: 'old', shotIndex: 1, shotProjectName: '河流', createdAt: 1, outputImages: ['old'] }),
      task({ shotBatchId: 'new', shotIndex: 1, shotProjectName: '河流', createdAt: 3, outputImages: ['new-1'] }),
      task({ shotBatchId: 'new', shotIndex: 2, shotProjectName: '河流', createdAt: 2 }),
    ]

    const selected = selectShotProjectTasks(tasks, 'new', '河流')
    expect(selected.map((item) => item.shotIndex)).toEqual([1, 2])
    expect(buildShotProjectFiles(selected)).toEqual([{ imageId: 'new-1', pathBase: '镜头1/镜头1' }])
  })

  it('falls back to the latest batch of the typed project name', () => {
    const tasks = [
      task({ shotBatchId: 'old', shotIndex: 1, shotProjectName: '河流', createdAt: 1, outputImages: ['old'] }),
      task({ shotBatchId: 'new', shotIndex: 1, shotProjectName: '河流', createdAt: 4, outputImages: ['new'] }),
      task({ shotBatchId: 'other', shotIndex: 1, shotProjectName: '别的项目', createdAt: 9, outputImages: ['other'] }),
    ]

    expect(selectShotProjectTasks(tasks, null, '河流').map((item) => item.shotBatchId)).toEqual(['new'])
    expect(sanitizeProjectFolderName(' 河流/城市 ')).toBe('河流-城市')
    expect(sanitizeProjectFolderName('   ')).toBe('未命名项目')
  })
})
