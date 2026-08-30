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
  setSelectedTaskIds: vi.fn(),
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
  exportImage: vi.fn(async () => undefined),
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
      projectsLoaded: true,
      searchQuery: '',
      filterStatus: 'all',
      filterFavorite: false,
      activeFavoriteCollectionId: null,
      agentPanelCollapsed: false,
      streamPreviewSlots: {},
      projectCanvasCache: {},
      selectedTaskIds: [],
      updateProjectCanvas: mocks.updateProjectCanvas,
      setDetailImage: mocks.setDetailImage,
      setLightboxImageId: mocks.setLightboxImageId,
      setSelectedTaskIds: mocks.setSelectedTaskIds,
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

  it('shows development origin and image world coordinates', () => {
    expect(host.querySelector('[data-canvas-origin]')).not.toBeNull()
    const position = host.querySelector<HTMLElement>('[data-canvas-debug-position]')
    expect(position?.textContent).toBe('x: 0, y: 0')
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

  it('renames an image by double-clicking its name', () => {
    const node = host.querySelector<HTMLElement>('[data-canvas-node]')!
    act(() => node.dispatchEvent(pointerEvent('pointerdown', 1, 80, 80)))
    const name = host.querySelector<HTMLElement>('[data-canvas-image-name]')!
    act(() => name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })))

    const input = host.querySelector<HTMLInputElement>('[data-canvas-image-name]')!
    expect(input.value).toBe('图片 1')
  })

  it('resets the viewport to the canvas origin', () => {
    const resetButton = host.querySelector<HTMLButtonElement>('[aria-label="回到画布原点"]')!
    mocks.updateProjectCanvas.mockClear()

    act(() => resetButton.click())

    expect(mocks.updateProjectCanvas).not.toHaveBeenCalled()
  })

  it('resets only the viewport position without changing zoom', async () => {
    const project = createProject()
    project.canvas!.viewport.scale = 2
    mocks.state.current = { ...mocks.state.current, projects: [project] }
    await act(async () => root.render(<ProjectCanvas />))

    const resetButton = host.querySelector<HTMLButtonElement>('[aria-label="回到画布原点"]')!
    expect(host.querySelector('[aria-label="选择画布缩放比例"]')?.textContent).toBe('200%')

    act(() => resetButton.click())

    expect(host.querySelector('[aria-label="选择画布缩放比例"]')?.textContent).toBe('200%')
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

  it('keeps selection handles screen-sized and outside the image when zoomed', async () => {
    const project = createProject()
    project.canvas!.viewport.scale = 2
    mocks.state.current = { ...mocks.state.current, projects: [project] }
    await act(async () => root.render(<ProjectCanvas />))

    const node = host.querySelector<HTMLElement>('[data-canvas-node]')!
    act(() => node.dispatchEvent(pointerEvent('pointerdown', 1, 80, 80)))

    const nw = host.querySelector<HTMLButtonElement>('[aria-label="调整图片nw"]')!
    const rotate = host.querySelector<HTMLButtonElement>('[aria-label="旋转图片"]')!
    expect(nw.style.transform).toBe('scale(0.5)')
    expect(nw.style.left).toBe('-5px')
    expect(nw.style.top).toBe('-5px')
    expect(rotate.style.transform).toBe('translateX(-50%) scale(0.5)')
    expect(rotate.style.top).toBe('-29px')
  })

  it('centers the first generated image on the world origin', async () => {
    const project = { ...createProject(), id: 'project-b', canvas: undefined }
    const task = { ...createTask(), projectId: 'project-b' }
    mocks.state.current = { ...mocks.state.current, projects: [project], tasks: [task], activeProjectId: 'project-b', projectsLoaded: true }
    mocks.updateProjectCanvas.mockClear()
    await act(async () => root.render(<ProjectCanvas />))

    expect(mocks.updateProjectCanvas).toHaveBeenCalledWith('project-b', expect.objectContaining({
      viewport: { x: 400, y: 300, scale: 1 },
      items: { 'image-a': expect.objectContaining({ x: -120, y: -120, width: 240 }) },
    }))
  })

  it('centers the generating placeholder on the world origin', async () => {
    const project = { ...createProject(), canvas: undefined }
    const task = { ...createTask(), outputImages: [], status: 'running' as const }
    mocks.state.current = { ...mocks.state.current, projects: [project], tasks: [task], activeProjectId: 'project-a', projectsLoaded: true }
    await act(async () => root.render(<ProjectCanvas />))

    const node = host.querySelector<HTMLElement>('[data-canvas-node]')!
    expect(node.style.left).toBe('-512px')
    expect(node.style.top).toBe('-512px')
    expect(node.style.width).toBe('1024px')
  })

  it('allows the generating placeholder to move without persisting a canvas patch', async () => {
    const project = { ...createProject(), canvas: undefined }
    const task = { ...createTask(), outputImages: [], status: 'running' as const }
    mocks.state.current = { ...mocks.state.current, projects: [project], tasks: [task], activeProjectId: 'project-a', projectsLoaded: true }
    mocks.updateProjectCanvas.mockClear()
    await act(async () => root.render(<ProjectCanvas />))

    const node = host.querySelector<HTMLElement>('[data-canvas-node]')!
    act(() => {
      node.dispatchEvent(pointerEvent('pointerdown', 7, 80, 80))
      node.dispatchEvent(pointerEvent('pointermove', 7, 120, 100))
      node.dispatchEvent(pointerEvent('pointerup', 7, 120, 100))
    })

    expect(Number.parseFloat(node.style.left)).toBeCloseTo(-414.4762, 3)
    expect(Number.parseFloat(node.style.top)).toBeCloseTo(-463.2381, 3)
    expect(mocks.updateProjectCanvas).not.toHaveBeenCalled()
  })

  it('does not write the canvas while restoring project records', async () => {
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
    expect(mocks.updateProjectCanvas).not.toHaveBeenCalled()
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
    expect(mocks.setSelectedTaskIds).toHaveBeenCalledWith(['task-a', 'task-b'])
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
    mocks.updateProjectCanvas.mockClear()

    act(() => {
      canvas.dispatchEvent(pointerEvent('pointerdown', 2, 300, 300))
      canvas.dispatchEvent(pointerEvent('pointermove', 2, 330, 320))
      canvas.dispatchEvent(pointerEvent('pointerup', 2, 330, 320))
    })
    expect(mocks.updateProjectCanvas).not.toHaveBeenCalled()

    act(() => {
      world.dispatchEvent(pointerEvent('pointerdown', 3, 500, 500))
      world.dispatchEvent(pointerEvent('pointermove', 3, 520, 510))
      world.dispatchEvent(pointerEvent('pointerup', 3, 520, 510))
    })
    expect(mocks.updateProjectCanvas).not.toHaveBeenCalled()

    act(() => canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 300, clientY: 300, deltaY: -120 })))
    expect(world.style.transform).not.toContain('scale(1)')
    expect(mocks.updateProjectCanvas).not.toHaveBeenCalled()
  })

  it('undoes and redoes canvas edits with keyboard shortcuts', () => {
    const node = host.querySelector<HTMLElement>('[data-canvas-node]')!
    mocks.updateProjectCanvas.mockClear()

    act(() => {
      node.dispatchEvent(pointerEvent('pointerdown', 30, 80, 80))
      node.dispatchEvent(pointerEvent('pointermove', 30, 120, 100))
      node.dispatchEvent(pointerEvent('pointerup', 30, 120, 100))
    })
    expect(mocks.updateProjectCanvas).toHaveBeenLastCalledWith('project-a', expect.objectContaining({
      items: expect.objectContaining({ 'image-a': expect.objectContaining({ x: 40, y: 20 }) }),
    }))

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })))
    expect(mocks.updateProjectCanvas).toHaveBeenLastCalledWith('project-a', expect.objectContaining({
      items: expect.objectContaining({ 'image-a': expect.objectContaining({ x: 0, y: 0 }) }),
    }))

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true })))
    expect(mocks.updateProjectCanvas).toHaveBeenLastCalledWith('project-a', expect.objectContaining({
      items: expect.objectContaining({ 'image-a': expect.objectContaining({ x: 40, y: 20 }) }),
    }))
  })

  it('does not rearrange automatically laid out images when undo history is empty', async () => {
    const secondTask = { ...createTask(), id: 'task-b', outputImages: ['image-b'], createdAt: 2, finishedAt: 3 }
    const project = { ...createProject(), canvas: undefined }
    mocks.state.current = { ...mocks.state.current, tasks: [createTask(), secondTask], projects: [project] }
    await act(async () => root.render(<ProjectCanvas />))
    const canvas = host.querySelector<HTMLElement>('[data-project-canvas]')!
    const before = [...canvas.querySelectorAll<HTMLElement>('[data-canvas-node]')].map((node) => ({ key: node.dataset.nodeKey, left: node.style.left, top: node.style.top }))
    mocks.updateProjectCanvas.mockClear()

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })))

    const after = [...canvas.querySelectorAll<HTMLElement>('[data-canvas-node]')].map((node) => ({ key: node.dataset.nodeKey, left: node.style.left, top: node.style.top }))
    expect(after).toEqual(before)
    expect(mocks.updateProjectCanvas).not.toHaveBeenCalled()
  })

  it('keeps other image positions when undoing a move after automatic layout', async () => {
    const secondTask = { ...createTask(), id: 'task-b', outputImages: ['image-b'], createdAt: 2, finishedAt: 3 }
    const project = { ...createProject(), canvas: undefined }
    mocks.state.current = { ...mocks.state.current, tasks: [createTask(), secondTask], projects: [project] }
    await act(async () => root.render(<ProjectCanvas />))
    const first = host.querySelector<HTMLElement>('[data-node-key="image-a"]')!
    const second = host.querySelector<HTMLElement>('[data-node-key="image-b"]')!
    const before = { left: second.style.left, top: second.style.top }

    act(() => {
      first.dispatchEvent(pointerEvent('pointerdown', 31, 80, 80))
      first.dispatchEvent(pointerEvent('pointermove', 31, 120, 100))
      first.dispatchEvent(pointerEvent('pointerup', 31, 120, 100))
    })
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })))

    expect({ left: second.style.left, top: second.style.top }).toEqual(before)
  })

  it('keeps persisted layout when undoing a move after refresh', async () => {
    const secondTask = { ...createTask(), id: 'task-b', outputImages: ['image-b'], createdAt: 2, finishedAt: 3 }
    const project = createProject()
    project.canvas!.items['image-b'] = { x: 360, y: 140, width: 240, z: 1, favoriteCollectionIds: [] }
    mocks.state.current = { ...mocks.state.current, tasks: [createTask(), secondTask], projects: [project] }
    await act(async () => root.render(<ProjectCanvas />))
    const first = host.querySelector<HTMLElement>('[data-node-key="image-a"]')!
    const second = host.querySelector<HTMLElement>('[data-node-key="image-b"]')!
    const before = { left: second.style.left, top: second.style.top }
    mocks.updateProjectCanvas.mockClear()

    act(() => {
      first.dispatchEvent(pointerEvent('pointerdown', 32, 80, 80))
      first.dispatchEvent(pointerEvent('pointermove', 32, 120, 100))
      first.dispatchEvent(pointerEvent('pointerup', 32, 120, 100))
    })
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })))

    expect({ left: second.style.left, top: second.style.top }).toEqual(before)
  })

  it('keeps wheel events inside the layer panel from zooming the canvas', () => {
    const layerButton = host.querySelector<HTMLButtonElement>('[aria-label="图层"]')!
    act(() => layerButton.click())
    const panel = host.querySelector<HTMLElement>('[data-canvas-layers-panel]')!
    const world = host.querySelector<HTMLElement>('[data-project-canvas]')!.firstElementChild as HTMLElement
    const before = world.style.transform

    act(() => panel.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 })))

    expect(world.style.transform).toBe(before)
  })

  it('closes the zoom preset menu when clicking the canvas', () => {
    const zoomButton = host.querySelector<HTMLButtonElement>('[aria-label="选择画布缩放比例"]')!
    const canvas = host.querySelector<HTMLElement>('[data-project-canvas]')!

    act(() => zoomButton.click())
    expect(host.querySelector('[data-canvas-zoom-preset]')).not.toBeNull()

    act(() => canvas.dispatchEvent(pointerEvent('pointerdown', 20, 700, 500)))

    expect(host.querySelector('[data-canvas-zoom-preset]')).toBeNull()
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
