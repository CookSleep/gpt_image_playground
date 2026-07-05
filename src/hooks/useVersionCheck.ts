import { useState, useEffect } from 'react'

const REPO = 'CookSleep/gpt_image_playground'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`

function compareVersions(a: string, b: string) {
  const aParts = a.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const bParts = b.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(aParts.length, bParts.length)

  for (let i = 0; i < length; i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0)
    if (diff !== 0) return diff
  }

  return 0
}

export interface LatestRelease {
  tag: string
  url: string
}

// 模块级 Promise 缓存：解决 StrictMode 下 useEffect 双执行导致的重复请求
// 同步立即赋值 Promise，第二次调用直接复用同一个 Promise
let latestReleasePromise: Promise<LatestRelease | null> | null = null

function fetchLatestRelease(): Promise<LatestRelease | null> {
  if (latestReleasePromise) return latestReleasePromise
  latestReleasePromise = fetch(API_URL, { headers: { Accept: 'application/vnd.github.v3+json' } })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    })
    .then((data): LatestRelease | null => {
      const tag: string = data.tag_name ?? ''
      const version = tag.replace(/^v/, '')
      if (version && compareVersions(version, __APP_VERSION__) > 0) {
        return {
          tag,
          url: data.html_url ?? `https://github.com/${REPO}/releases/latest`,
        }
      }
      return null
    })
    .catch(() => {
      // 静默失败，不影响正常使用；保留缓存避免重复请求
      return null
    })
  return latestReleasePromise
}

/**
 * 检查 GitHub 最新 Release 版本。
 * - 仅当最新 Release 版本高于当前 __APP_VERSION__ 时提示。
 * - 用户点击后调用 dismiss()，本次浏览期间不再提示（sessionStorage）。
 * - 刷新页面后重新检查。
 */
export function useVersionCheck() {
  const [latestRelease, setLatestRelease] = useState<LatestRelease | null>(null)
  const [dismissed, setDismissed] = useState(() =>
    sessionStorage.getItem('version-dismissed') === 'true',
  )

  useEffect(() => {
    let cancelled = false
    fetchLatestRelease().then((release) => {
      if (cancelled) return
      if (release) setLatestRelease(release)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = () => {
    setDismissed(true)
    sessionStorage.setItem('version-dismissed', 'true')
  }

  const hasUpdate = latestRelease !== null && !dismissed

  return { hasUpdate, latestRelease, dismiss }
}
