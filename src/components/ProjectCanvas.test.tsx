// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type Project, type TaskRecord } from '../types'

const mocks = vi.hoisted(() => ({
  state: { current: {} as Record<string, unknown> },
  updateProjectCanvas: vi.fn(),
  openImageFavoritePicker: vi.fn(),
  setDetailImage: vi.fn(),
  setLightboxImageId: vi.fn(),
  setConfirmDialog: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('../store', () => ({
  ALL_FAVORITES_COLLECTION_ID: '__all_favorites__',
  ALL_PROJECTS_ID: '__all_projects__',
  LOCAL_PROJECT_ID: '__local_project__',
  useStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state.current),
  ensureImageCached: vi.fn(async () => 'data:image/png;base64,AA=='),
  ensureImageThumbnailCached: vi.fn(async () => null),
  subscribeImageThumbnail: vi.fn(() => () => undefined),
  getImageFavoriteCollectionIds: (imageId: string, task: TaskRecord) => {
    const projects = mocks.state.current.projects as Project[]
    return projects.find((project) => project.id === task.projectId)?.canvas?.items[imageId]?.favoriteCollectionIds ?? []
  },
  editOutputImage: vi.fn(),
  removeOutputImage: vi.fn(),
  reuseImageConfig: vi.fn(),
  retryImage: vi.fn(),
  taskMatchesFilterStatus: (task: TaskRecord, status: string) => status === 'all' || task.status === status,
  taskMatchesSearchQuery: (task: TaskRecord, query: string) => !query || task.prompt.toLowerCase().includes(query),
}))

vi.mock('../lib/clipboard', () => ({
  copyImageSourceToClipboard: vi.fn(),
  getClipboardFailureMessage: (message: string) => message,
}))

vi.mock('../lib/downloadImages', () => ({
  downloadImageIds: vi.fn(async () => ({ successCount: 1, failCount: 0 })),
}))

vi.mock('../lib/materialApi', () => ({
  uploadMaterialImage: vi.fn(),
}))

import ProjectCanvas from './ProjectCanvas'

function createTask(): TaskRecord {
  return {
    id: 'task-a',
    projectId: 'project-a',
    prompt: '测试图片',
    params: { ...DEFAULT_PARAMS, n: 1 },
    inputImageIds: [],
    outputImages: ['image-a'],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
  }
}

function createProject(): Project {
  return {
    id: 'project-a',
    title: '测试项目',
    initialPrompt: '',
    storage: 'local',
    createdAt: 1,
    updatedAt: 1,
    canvas: {
      version: 1,
      viewport: { x: 32, y: 32, scale: 1 },
      items: {
        'image-a': { x: 0, y: 0, width: 240, z: 0, favoriteCollectionIds: [] },
      },
    },
  }
}

function pointerEvent(type: string, pointerId: number, clientX: number, clientY: number, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
    ctrlKey: { value: Boolean(modifiers.ctrlKey) },
    metaKey: { value: Boolean(modifiers.metaKey) },
  })
  return event
}

describe('ProjectCanvas interactions', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.state.current = {
      tasks: [createTask()],
      projects: [createProject()],
      activeProjectId: 'project-a',
      searchQuery: '',
      filterStatus: 'all',
      filterFavorite: false,
      activeFavoriteCollectionId: null,
      agentPanelCollapsed: false,
      streamPreviewSlots: {},
      projectCanvasCache: {},
      updateProjectCanvas: mocks.updateProjectCanvas,
      setDetailImage: mocks.setDetailImage,
      setLightboxImageId: mocks.setLightboxImageId,
      openImageFavoritePicker: mocks.openImageFavoritePicker,
      setConfirmDialog: mocks.setConfirmDialog,
      showToast: mocks.showToast,
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => root.render(<ProjectCanvas />))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('selects one image, runs its toolbar action, and clears selection on blank space', () => {
    const node = host.querySelector<HTMLElement>('[data-canvas-node]')!
    const canvas = host.querySelector<HTMLElement>('[data-project-canvas]')!

    act(() => node.dispatchEvent(pointerEvent('pointerdown', 1, 80, 80)))
    const favoriteButton = host.querySelector<HTMLButtonElement>('[aria-label="收藏"]')
    expect(favoriteButton).not.toBeNull()
    act(() => favoriteButton!.click())
    expect(mocks.openImageFavoritePicker).toHaveBeenCalledWith(['image-a'])

    act(() => canvas.dispatchEvent(pointerEvent('pointerdown', 2, 700, 500)))
    expect(host.querySelector('[aria-label="收藏"]')).toBeNull()
  })

  it('does not persist when clicking blank canvas without moving it', () => {
    const canvas = host.querySelector<HTMLElement>('[data-project-canvas]')!
    mocks.updateProjectCanvas.mockClear()

    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 1, 700, 500))
      canvas.dispatchEvent(pointerEvent('pointerup', 1, 700, 500))
    })

    expect(mocks.updateProjectCanvas).not.toHaveBeenCalled()
  })

  it('does not persist when clicking an image without moving it', () => {
    const node = host.querySelector<HTMLElement>('[data-canvas-node]')!
    mocks.updateProjectCanvas.mockClear()

    act(() => {
      node.dispatchEvent(pointerEvent('pointerdown', 1, 80, 80))
      node.dispatchEvent(pointerEvent('pointerup', 1, 80, 80))
    })

    expect(mocks.updateProjectCanvas).not.toHaveBeenCalled()
  })

  it('resets the viewport to the canvas origin', () => {
    const resetButton = host.querySelector<HTMLButtonElement>('[aria-label="回到画布原点"]')!
    mocks.updateProjectCanvas.mockClear()

    act(() => resetButton.click())

    expect(mocks.updateProjectCanvas).toHaveBeenLastCalledWith('project-a', expect.objectContaining({
      viewport: { x: 400, y: 300, scale: 1 },
    }))
  })

  it('raises the selected node until it is deselected and keeps the zoom controls visible', () => {
    const node = host.querySelector<HTMLElement>('[data-canvas-node]')!
    const canvas = host.querySelector<HTMLElement>('[data-project-canvas]')!
    expect(node.style.zIndex).toBe('0')
    expect(host.querySelector('[data-canvas-zoom-controls]')).not.toBeNull()

    act(() => node.dispatchEvent(pointerEvent('pointerdown', 1, 80, 80)))
    expect(node.style.zIndex).toBe('1000')

    act(() => node.dispatchEvent(pointerEvent('pointerup', 1, 80, 80)))
    expect(node.style.zIndex).toBe('1000')

    act(() => canvas.dispatchEvent(pointerEvent('pointerdown', 2, 700, 500)))
    expect(node.style.zIndex).toBe('0')
  })

  it('does not write an empty local canvas before project records finish loading', async () => {
    const legacyTask = { ...createTask(), projectId: undefined }
    mocks.state.current = {
      ...mocks.state.current,
      activeProjectId: '__local_project__',
      projects: [],
      tasks: [legacyTask],
      projectsLoaded: false,
    }
    mocks.updateProjectCanvas.mockClear()
    await act(async () => root.render(<ProjectCanvas />))
    expect(mocks.updateProjectCanvas).not.toHaveBeenCalled()

    mocks.state.current = { ...mocks.state.current, projectsLoaded: true }
    await act(async () => root.render(<ProjectCanvas />))
    expect(mocks.updateProjectCanvas).toHaveBeenCalledWith('__local_project__', expect.anything())
  })

  it('moves every image in a Ctrl-selected group by the same offset', async () => {
    const secondTask = { ...createTask(), id: 'task-b', outputImages: ['image-b'], createdAt: 2, finishedAt: 3 }
    const project = createProject()
    project.canvas!.items['image-b'] = { x: 300, y: 0, width: 240, z: 1, favoriteCollectionIds: [] }
    mocks.state.current = { ...mocks.state.current, tasks: [createTask(), secondTask], projects: [project] }
    await act(async () => root.render(<ProjectCanvas />))
    mocks.updateProjectCanvas.mockClear()

    const canvas = host.querySelector<HTMLElement>('[data-project-canvas]')!
    const first = host.querySelector<HTMLElement>('[data-node-key="image-a"]')!
    const second = host.querySelector<HTMLElement>('[data-node-key="image-b"]')!
    act(() => first.dispatchEvent(pointerEvent('pointerdown', 1, 80, 80, { ctrlKey: true })))
    act(() => second.dispatchEvent(pointerEvent('pointerdown', 2, 380, 80, { ctrlKey: true })))
    act(() => {
      first.dispatchEvent(pointerEvent('pointerdown', 3, 80, 80))
      first.dispatchEvent(pointerEvent('pointermove', 3, 120, 100))
      first.dispatchEvent(pointerEvent('pointerup', 3, 120, 100))
    })

    expect(mocks.updateProjectCanvas).toHaveBeenLastCalledWith('project-a', expect.objectContaining({
      items: expect.objectContaining({
        'image-a': expect.objectContaining({ x: 40, y: 20 }),
        'image-b': expect.objectContaining({ x: 340, y: 20 }),
      }),
    }))
    expect(canvas.querySelectorAll('[data-canvas-node]')).toHaveLength(2)
  })

  it('moves one node and pans and zooms the viewport', () => {
    const node = host.querySelector<HTMLElement>('[data-canvas-node]')!
    const canvas = host.querySelector<HTMLElement>('[data-project-canvas]')!
    const world = canvas.firstElementChild as HTMLElement

    act(() => {
      node.dispatchEvent(pointerEvent('pointerdown', 1, 80, 80))
      node.dispatchEvent(pointerEvent('pointermove', 1, 120, 100))
      node.dispatchEvent(pointerEvent('pointerup', 1, 120, 100))
    })
    expect(mocks.updateProjectCanvas).toHaveBeenLastCalledWith('project-a', expect.objectContaining({
      items: expect.objectContaining({
        'image-a': expect.objectContaining({ x: 40, y: 20 }),
      }),
    }))

    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 2, 300, 300))
      canvas.dispatchEvent(pointerEvent('pointermove', 2, 330, 320))
      canvas.dispatchEvent(pointerEvent('pointerup', 2, 330, 320))
    })
    expect(mocks.updateProjectCanvas).toHaveBeenLastCalledWith('project-a', expect.objectContaining({
      viewport: expect.objectContaining({ x: 62, y: 52 }),
    }))

    act(() => {
      world.dispatchEvent(pointerEvent('pointerdown', 3, 500, 500))
      world.dispatchEvent(pointerEvent('pointermove', 3, 520, 510))
      world.dispatchEvent(pointerEvent('pointerup', 3, 520, 510))
    })
    expect(mocks.updateProjectCanvas).toHaveBeenLastCalledWith('project-a', expect.objectContaining({
      viewport: expect.objectContaining({ x: 82, y: 62 }),
    }))

    act(() => canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 300, clientY: 300, deltaY: -120 })))
    expect(world.style.transform).not.toContain('scale(1)')
  })

  it('prefers the persisted canvas cache over a stale project canvas snapshot', async () => {
    const project = createProject()
    mocks.state.current = {
      ...mocks.state.current,
      projects: [project],
      projectCanvasCache: {
        'project-a': {
          ...project.canvas!,
          items: {
            'image-a': { ...project.canvas!.items['image-a'], x: 420, y: 180, width: 360 },
          },
        },
      },
    }
    await act(async () => root.render(<ProjectCanvas />))

    const node = host.querySelector<HTMLElement>('[data-node-key="image-a"]')!
    expect(node.style.left).toBe('420px')
    expect(node.style.top).toBe('180px')
    expect(node.style.width).toBe('360px')
  })

  it('filters non-favorite images and supports a two-pointer pinch gesture', async () => {
    const canvas = host.querySelector<HTMLElement>('[data-project-canvas]')!
    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 1, 100, 200))
      canvas.dispatchEvent(pointerEvent('pointerdown', 2, 200, 200))
      canvas.dispatchEvent(pointerEvent('pointermove', 2, 300, 200))
    })
    const world = canvas.firstElementChild as HTMLElement
    expect(world.style.transform).toContain('scale(2)')

    mocks.state.current = { ...mocks.state.current, filterFavorite: true }
    await act(async () => root.render(<ProjectCanvas />))
    expect(host.querySelector('[data-canvas-node]')).toBeNull()
    expect(host.textContent).toContain('没有找到匹配的图片')
  })
})

Object.defineProperties(HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 800 },
  clientHeight: { configurable: true, get: () => 600 },
  offsetWidth: { configurable: true, get: () => 400 },
  offsetHeight: { configurable: true, get: () => 42 },
  setPointerCapture: { configurable: true, value: () => undefined },
})

class TestResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }

  disconnect() {}
  unobserve() {}
}

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
