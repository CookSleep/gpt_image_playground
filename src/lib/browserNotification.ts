export type BrowserNotificationPermission = NotificationPermission | 'unsupported'
export type BrowserNotificationPermissionResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'insecure' | 'denied' | 'default' | 'error'; error?: unknown }
export type BrowserNotificationReadiness =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'insecure' | 'denied' | 'default' }

function getNotificationConstructor() {
  if (typeof window === 'undefined' || !('Notification' in window)) return null
  return window.Notification
}

function isSecureNotificationContext() {
  return typeof window !== 'undefined' && window.isSecureContext
}

export function getBrowserNotificationReadiness(): BrowserNotificationReadiness {
  const NotificationConstructor = getNotificationConstructor()
  if (!NotificationConstructor) return { ok: false, reason: 'unsupported' }
  if (!isSecureNotificationContext()) return { ok: false, reason: 'insecure' }
  if (NotificationConstructor.permission === 'granted') return { ok: true }
  return { ok: false, reason: NotificationConstructor.permission }
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermissionResult> {
  const readiness = getBrowserNotificationReadiness()
  if (readiness.ok || readiness.reason !== 'default') return readiness

  try {
    const permission = await window.Notification.requestPermission()
    if (permission === 'granted') return { ok: true }
    if (permission === 'denied') return { ok: false, reason: 'denied' }
    return { ok: false, reason: 'default' }
  } catch (error) {
    return { ok: false, reason: 'error', error }
  }
}

export function showBrowserNotification(title: string, options?: NotificationOptions) {
  const NotificationConstructor = getNotificationConstructor()
  if (!NotificationConstructor || !isSecureNotificationContext() || NotificationConstructor.permission !== 'granted') return false

  try {
    const notification = new NotificationConstructor(title, {
      tag: 'task-completion',
      requireInteraction: false,
      ...options,
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
    return true
  } catch {
    return false
  }
}
