import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { createAnnouncement, deleteAnnouncement, listAnnouncements, updateAnnouncement, type Announcement, type AnnouncementNotification, type AnnouncementStatus } from '../lib/announcements'
import MarkdownRenderer from './MarkdownRenderer'
import { AdminIcon, PlusIcon, TrashIcon } from './icons'
import { useStore } from '../store'

type FormState = {
  title: string
  content: string
  status: AnnouncementStatus
  notification: AnnouncementNotification
  startsAt: string
  endsAt: string
}

const EMPTY_FORM: FormState = { title: '', content: '', status: 'draft', notification: 'silent', startsAt: '', endsAt: '' }

function toInputDate(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function fromInputDate(value: string) {
  return value ? new Date(value).toISOString() : null
}

function toForm(item: Announcement): FormState {
  return { title: item.title, content: item.content, status: item.status, notification: item.notification, startsAt: toInputDate(item.starts_at), endsAt: toInputDate(item.ends_at) }
}

export default function AdminAnnouncements() {
  const { user } = useAuth()
  const showToast = useStore((state) => state.showToast)
  const [items, setItems] = useState<Announcement[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [preview, setPreview] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const selected = useMemo(() => items.find((item) => item.id === selectedId), [items, selectedId])

  const load = async () => {
    setLoading(true)
    try {
      const next = await listAnnouncements()
      setItems(next)
      if (selectedId) {
        const current = next.find((item) => item.id === selectedId)
        if (current) setForm(toForm(current))
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '公告加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (user?.is_admin) void load() }, [user?.is_admin])

  if (!user?.is_admin) return <div className="p-6 text-sm text-gray-500">无权访问</div>

  const selectItem = (item: Announcement) => {
    setSelectedId(item.id)
    setForm(toForm(item))
    setPreview(false)
  }

  const newAnnouncement = () => {
    setSelectedId(null)
    setForm(EMPTY_FORM)
    setPreview(false)
  }

  const save = async () => {
    if (!form.content.trim()) {
      showToast('公告内容不能为空', 'error')
      return
    }
    setSaving(true)
    const input = { title: form.title.trim(), content: form.content, status: form.status, notification: form.notification, starts_at: fromInputDate(form.startsAt), ends_at: fromInputDate(form.endsAt) }
    try {
      const saved = selectedId ? await updateAnnouncement(selectedId, input) : await createAnnouncement(input)
      setItems((current) => selectedId ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current])
      setSelectedId(saved.id)
      setForm(toForm(saved))
      showToast('公告已保存', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '公告保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!selectedId || !window.confirm('确定删除这条公告吗？')) return
    try {
      await deleteAnnouncement(selectedId)
      setItems((current) => current.filter((item) => item.id !== selectedId))
      newAnnouncement()
      showToast('公告已删除', 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '公告删除失败', 'error')
    }
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-gray-50 p-4 sm:p-6 dark:bg-gray-950">
      <div className="mx-auto max-w-6xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2"><AdminIcon className="h-5 w-5 text-gray-600 dark:text-gray-300" /><h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">公告管理</h1></div>
          <button type="button" onClick={newAnnouncement} className="flex items-center gap-1.5 rounded-md bg-blue-500 px-3 py-2 text-sm text-white hover:bg-blue-600"><PlusIcon className="h-4 w-4" />新建公告</button>
        </div>
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <section className="rounded-lg border border-gray-200 bg-white p-2 dark:border-white/[0.08] dark:bg-gray-900">
            {loading ? <div className="p-3 text-sm text-gray-500">加载中...</div> : items.length === 0 ? <div className="p-3 text-sm text-gray-500">暂无公告</div> : items.map((item) => <button key={item.id} type="button" onClick={() => selectItem(item)} className={`mb-1 w-full rounded-md p-3 text-left ${selectedId === item.id ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-gray-50 dark:hover:bg-white/[0.05]'}`}><div className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{item.title || '未命名公告'}</div><div className="mt-1 text-xs text-gray-500">{item.status === 'published' ? '展示中' : item.status === 'archived' ? '归档' : '草稿'}</div></button>)}
          </section>
          <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-white/[0.08] dark:bg-gray-900">
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm text-gray-600 dark:text-gray-300">标题<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className="mt-1 h-9 w-full rounded-md border border-gray-200 bg-transparent px-2 text-sm outline-none focus:border-blue-500 dark:border-white/[0.1]" placeholder="可选" /></label>
              <label className="text-sm text-gray-600 dark:text-gray-300">状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as AnnouncementStatus })} className="mt-1 h-9 w-full rounded-md border border-gray-200 bg-transparent px-2 text-sm outline-none focus:border-blue-500 dark:border-white/[0.1]"><option value="draft">草稿</option><option value="published">展示中</option><option value="archived">归档</option></select></label>
              <label className="text-sm text-gray-600 dark:text-gray-300">通知方式<select value={form.notification} onChange={(event) => setForm({ ...form, notification: event.target.value as AnnouncementNotification })} className="mt-1 h-9 w-full rounded-md border border-gray-200 bg-transparent px-2 text-sm outline-none focus:border-blue-500 dark:border-white/[0.1]"><option value="silent">静默</option><option value="modal">弹窗</option></select></label>
              <div className="grid grid-cols-2 gap-2"><label className="text-sm text-gray-600 dark:text-gray-300">开始时间<input type="datetime-local" value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} className="mt-1 h-9 w-full min-w-0 rounded-md border border-gray-200 bg-transparent px-2 text-xs outline-none focus:border-blue-500 dark:border-white/[0.1]" /></label><label className="text-sm text-gray-600 dark:text-gray-300">结束时间<input type="datetime-local" value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} className="mt-1 h-9 w-full min-w-0 rounded-md border border-gray-200 bg-transparent px-2 text-xs outline-none focus:border-blue-500 dark:border-white/[0.1]" /></label></div>
            </div>
            <div className="mb-2 flex items-center justify-between"><label className="text-sm text-gray-600 dark:text-gray-300">Markdown 内容</label><button type="button" onClick={() => setPreview((value) => !value)} className="text-xs text-blue-500 hover:text-blue-600">{preview ? '编辑' : '预览'}</button></div>
            {preview ? <div className="min-h-64 rounded-md border border-gray-200 p-3 dark:border-white/[0.1]"><MarkdownRenderer content={form.content || '暂无内容'} /></div> : <textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} className="min-h-64 w-full resize-y rounded-md border border-gray-200 bg-transparent p-3 font-mono text-sm leading-5 outline-none focus:border-blue-500 dark:border-white/[0.1]" placeholder="输入 Markdown 公告内容" />}
            <div className="mt-4 flex items-center justify-between"><button type="button" disabled={!selected} onClick={() => void remove()} className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-red-500 hover:bg-red-50 disabled:invisible dark:hover:bg-red-950/30"><TrashIcon className="h-4 w-4" />删除</button><button type="button" disabled={saving} onClick={() => void save()} className="rounded-md bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600 disabled:opacity-60">{saving ? '保存中...' : '保存公告'}</button></div>
          </section>
        </div>
      </div>
    </div>
  )
}
