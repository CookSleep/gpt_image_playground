import { authFetch } from '../auth/api'

export type AnnouncementStatus = 'draft' | 'published' | 'archived'
export type AnnouncementNotification = 'silent' | 'modal'

export type Announcement = {
  id: string
  title: string
  content: string
  status: AnnouncementStatus
  notification: AnnouncementNotification
  starts_at?: string
  ends_at?: string
  created_at: string
  updated_at: string
}

type AnnouncementInput = Pick<Announcement, 'title' | 'content' | 'status' | 'notification'> & {
  starts_at: string | null
  ends_at: string | null
}

async function readError(response: Response) {
  const data = await response.json().catch(() => null) as { message?: unknown } | null
  return new Error(typeof data?.message === 'string' ? data.message : `公告接口失败：HTTP ${response.status}`)
}

export async function fetchActiveAnnouncement() {
  const response = await authFetch('/api/v1/announcements/active', { cache: 'no-store' })
  if (response.status === 204 || response.status === 404) return null
  if (!response.ok) throw await readError(response)
  return await response.json() as Announcement
}

export async function listAnnouncementHistory() {
  const response = await authFetch('/api/v1/announcements/history', { cache: 'no-store' })
  if (!response.ok) throw await readError(response)
  const data = await response.json() as { announcements?: Announcement[] }
  return data.announcements ?? []
}

export async function listAnnouncements() {
  const response = await authFetch('/api/v1/admin/announcements', { cache: 'no-store' })
  if (!response.ok) throw await readError(response)
  const data = await response.json() as { announcements?: Announcement[] }
  return data.announcements ?? []
}

export async function createAnnouncement(input: AnnouncementInput) {
  const response = await authFetch('/api/v1/admin/announcements', { method: 'POST', body: JSON.stringify(input) })
  if (!response.ok) throw await readError(response)
  return await response.json() as Announcement
}

export async function updateAnnouncement(id: string, input: AnnouncementInput) {
  const response = await authFetch(`/api/v1/admin/announcements/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) })
  if (!response.ok) throw await readError(response)
  return await response.json() as Announcement
}

export async function deleteAnnouncement(id: string) {
  const response = await authFetch(`/api/v1/admin/announcements/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!response.ok) throw await readError(response)
}
