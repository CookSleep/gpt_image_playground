import { primeImageCache, useStore } from '../store'
import {
  buildLocalSnapshot,
  mergeSnapshots,
  dataUrlToBinary,
  snapshotFromManifest,
  snapshotToDirectoryFiles,
  snapshotToDirectoryManifest,
  replaceLocalData,
  replaceSyncTombstones,
  sortTasksForDisplay,
} from './snapshot'

let syncInFlight: Promise<void> | null = null
const MANIFEST_FILE_NAME = 'manifest.json'
const TEST_FILE_PREFIX = '.gpt-image-playground-test-'

export async function syncWithWebDav() {
  if (syncInFlight) return syncInFlight

  syncInFlight = (async () => {
    const { settings, setSettings, setTasks, showToast } = useStore.getState()
    const webdav = settings.webdav

    if (settings.storageMode !== 'webdav') {
      showToast('当前是本地存储模式，无需同步', 'info')
      return
    }

    if (!webdav.url.trim()) {
      throw new Error('请先填写 WebDAV 目录地址')
    }

    const rootUrl = resolveWebDavRoot(webdav.url.trim())
    const localSnapshot = await buildLocalSnapshot(settings)
    const remoteSnapshot = await readRemoteSnapshot(rootUrl, webdav.username, webdav.password)
    const mergedSnapshot = remoteSnapshot ? mergeSnapshots(localSnapshot, remoteSnapshot) : localSnapshot
    const manifest = snapshotToDirectoryManifest(mergedSnapshot)
    const files = snapshotToDirectoryFiles(mergedSnapshot)

    await uploadSnapshotDirectory(rootUrl, webdav.username, webdav.password, manifest, files, remoteSnapshot)
    await replaceLocalData(mergedSnapshot)
    replaceSyncTombstones({
      deletedTaskIds: mergedSnapshot.deletedTaskIds,
      deletedImageIds: mergedSnapshot.deletedImageIds,
    })
    primeImageCache(mergedSnapshot.images)
    setSettings(mergedSnapshot.settings)
    setTasks(sortTasksForDisplay(mergedSnapshot.tasks))
    showToast(remoteSnapshot ? '已与 WebDAV 目录同步' : '已写入 WebDAV 目录', 'success')
  })()

  try {
    await syncInFlight
  } finally {
    syncInFlight = null
  }
}

export async function syncWebDavOnLaunch() {
  const { settings, showToast } = useStore.getState()
  if (settings.storageMode !== 'webdav' || !settings.webdav.syncOnStartup) return

  try {
    await syncWithWebDav()
  } catch (err) {
    showToast(formatWebDavError('WebDAV 启动同步失败', err), 'error')
  }
}

export async function testWebDavDirectory() {
  const { settings, showToast } = useStore.getState()
  if (settings.storageMode !== 'webdav') {
    showToast('当前是本地存储模式，无需测试 WebDAV', 'info')
    return
  }

  const webdav = settings.webdav
  if (!webdav.url.trim()) {
    throw new Error('请先填写 WebDAV 目录地址')
  }

  const rootUrl = resolveWebDavRoot(webdav.url.trim())
  const testUrl = resolveRemoteUrl(rootUrl, `${TEST_FILE_PREFIX}${Date.now()}.txt`)
  const imageTestUrl = resolveRemoteUrl(rootUrl, `.${TEST_FILE_PREFIX}${Date.now()}.png`)
  const body = new Blob([`ok-${Date.now()}`], { type: 'text/plain' })

  await putRemoteFile(testUrl, body, 'text/plain', webdav.username, webdav.password)
  await putRemoteFile(imageTestUrl, body, 'image/png', webdav.username, webdav.password)

  try {
    await deleteRemoteFile(testUrl, webdav.username, webdav.password)
  } catch {
    /* 测试文件删除失败不影响可用性判断 */
  }

  try {
    await deleteRemoteFile(imageTestUrl, webdav.username, webdav.password)
  } catch {
    /* 测试文件删除失败不影响可用性判断 */
  }

  showToast('WebDAV 目录可用', 'success')
}

function resolveWebDavRoot(url: string) {
  const trimmed = url.trim()
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

function resolveRemoteUrl(rootUrl: string, relativePath: string) {
  return new URL(relativePath.replace(/^\/+/, ''), rootUrl).toString()
}

function buildAuthHeaders(username: string, password: string) {
  const headers: Record<string, string> = {}
  if (username || password) {
    headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`
  }
  return headers
}

async function readRemoteSnapshot(rootUrl: string, username: string, password: string) {
  const manifestUrl = resolveRemoteUrl(rootUrl, MANIFEST_FILE_NAME)
  const response = await fetch(manifestUrl, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      ...buildAuthHeaders(username, password),
    },
  })

  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(await readWebDavError(response))
  }

  const manifestText = await response.text()
  if (!manifestText.trim()) {
    return null
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    throw new Error(`远端 manifest.json 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`)
  }

  return snapshotFromManifest(manifest, async (path) => {
    const fileResponse = await fetch(resolveRemoteUrl(rootUrl, path), {
      method: 'GET',
      cache: 'no-store',
      headers: {
        ...buildAuthHeaders(username, password),
      },
    })

    if (fileResponse.status === 404) return null
    if (!fileResponse.ok) {
      throw new Error(await readWebDavError(fileResponse))
    }

    return new Uint8Array(await fileResponse.arrayBuffer())
  })
}

async function uploadSnapshotDirectory(
  rootUrl: string,
  username: string,
  password: string,
  manifest: ReturnType<typeof snapshotToDirectoryManifest>,
  files: ReturnType<typeof snapshotToDirectoryFiles>,
  previousSnapshot: Awaited<ReturnType<typeof readRemoteSnapshot>>,
) {
  for (const file of files) {
    const fileUrl = resolveRemoteUrl(rootUrl, file.path)
    const bytes = file.bytes.slice().buffer
    await putRemoteFile(fileUrl, new Blob([bytes], { type: extToMime(file.ext) }), extToMime(file.ext), username, password)
  }

  const manifestUrl = resolveRemoteUrl(rootUrl, MANIFEST_FILE_NAME)
  await putRemoteFile(
    manifestUrl,
    new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
    'application/json',
    username,
    password,
  )

  if (previousSnapshot) {
    const currentPaths = new Set(files.map((file) => file.path))
    const stalePaths = previousSnapshot.images
      .map((item) => {
        const { ext } = dataUrlToBinary(item.dataUrl)
        return `${item.id}.${ext}`
      })
      .filter((path) => !currentPaths.has(path))

    for (const path of stalePaths) {
      try {
        await deleteRemoteFile(resolveRemoteUrl(rootUrl, path), username, password)
      } catch {
        /* 忽略孤立文件删除失败 */
      }
    }
  }
}

async function putRemoteFile(url: string, body: Blob, contentType: string, username: string, password: string) {
  const response = await fetch(url, {
    method: 'PUT',
    cache: 'no-store',
    headers: {
      'Content-Type': contentType,
      ...buildAuthHeaders(username, password),
    },
    body,
  })

  if (!response.ok) {
    throw new Error(await readWebDavError(response))
  }
}

async function deleteRemoteFile(url: string, username: string, password: string) {
  const response = await fetch(url, {
    method: 'DELETE',
    cache: 'no-store',
    headers: {
      ...buildAuthHeaders(username, password),
    },
  })

  if (!response.ok && response.status !== 404) {
    throw new Error(await readWebDavError(response))
  }
}

async function readWebDavError(response: Response) {
  const statusText = response.statusText ? ` ${response.statusText}` : ''
  try {
    const text = await response.text()
    return text ? `HTTP ${response.status}${statusText}: ${text}` : `HTTP ${response.status}${statusText}`
  } catch {
    return `HTTP ${response.status}${statusText}`
  }
}

function extToMime(ext: string) {
  const value = ext.toLowerCase()
  if (value === 'jpg' || value === 'jpeg') return 'image/jpeg'
  if (value === 'webp') return 'image/webp'
  if (value === 'gif') return 'image/gif'
  if (value === 'bmp') return 'image/bmp'
  if (value === 'svg') return 'image/svg+xml'
  return 'image/png'
}

function formatWebDavError(fallback: string, err: unknown) {
  return `${fallback}：${err instanceof Error ? err.message : String(err)}`
}
