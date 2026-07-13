import { useCallback, useEffect, useRef, useState } from 'react'
import { buildAssetQuery, createLatestAssetRequestGuard, mergeMovedAssets, removeAssets, toggleAssetSelection, toggleExpandedAsset } from '../lib/assetLibrary'
import { apiRequest, imageUrl, type ApiAsset, type ApiAssetFolder } from '../lib/minimalApi'
import { AuroraConfirmDialog, type AuroraConfirmAction } from './AuroraConfirmDialog'
import { CheckCircleIcon, EditIcon, FolderIcon, ImageIcon, PlusIcon, RefreshIcon, SearchIcon, SparklesIcon, TrashIcon } from './icons'

type FolderFilter = string | null | undefined

interface ConfirmState {
  title: string
  message: string
  actions: AuroraConfirmAction[]
}

export function AssetLibrary(props: {
  onCreate: () => void
  onOpenGeneration: (generationId: string) => void
  onChanged: () => void
}) {
  const [folders, setFolders] = useState<ApiAssetFolder[]>([])
  const [assets, setAssets] = useState<ApiAsset[]>([])
  const [folderId, setFolderId] = useState<FolderFilter>(undefined)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(new Set<string>())
  const [expandedAssetIds, setExpandedAssetIds] = useState(new Set<string>())
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [editingFolderId, setEditingFolderId] = useState('')
  const [editingFolderName, setEditingFolderName] = useState('')
  const [editingAssetId, setEditingAssetId] = useState('')
  const [editingAssetName, setEditingAssetName] = useState('')
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [busy, setBusy] = useState(false)
  const assetRequestGuard = useRef(createLatestAssetRequestGuard())

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 280)
    return () => window.clearTimeout(timer)
  }, [query])

  const loadFolders = useCallback(async () => {
    const result = await apiRequest<{ folders: ApiAssetFolder[] }>('/api/folders')
    setFolders(result.folders)
  }, [])

  const loadAssets = useCallback(async (cursor?: string | null) => {
    const requestId = assetRequestGuard.current.begin()
    setLoading(true)
    setError('')
    try {
      const result = await apiRequest<{ assets: ApiAsset[]; nextCursor: string | null }>(buildAssetQuery({ q: search, folderId, cursor }))
      if (!assetRequestGuard.current.isLatest(requestId)) return
      setAssets((current) => cursor ? [...current, ...result.assets] : result.assets)
      setNextCursor(result.nextCursor)
      if (!cursor) setSelected(new Set())
    } catch (err) {
      if (!assetRequestGuard.current.isLatest(requestId)) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (assetRequestGuard.current.isLatest(requestId)) setLoading(false)
    }
  }, [folderId, search])

  useEffect(() => {
    void loadFolders().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [loadFolders])

  useEffect(() => {
    void loadAssets()
  }, [loadAssets])

  async function createFolder() {
    if (!newFolderName.trim()) return
    setBusy(true)
    setError('')
    try {
      const result = await apiRequest<{ folder: ApiAssetFolder }>('/api/folders', { method: 'POST', body: JSON.stringify({ name: newFolderName }) })
      setFolders((current) => [...current, result.folder].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')))
      setFolderId(result.folder.id)
      setNewFolderName('')
      setCreatingFolder(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function renameFolder(folder: ApiAssetFolder) {
    if (!editingFolderName.trim()) return
    setBusy(true)
    try {
      const result = await apiRequest<{ folder: ApiAssetFolder }>(`/api/folders/${encodeURIComponent(folder.id)}`, { method: 'PATCH', body: JSON.stringify({ name: editingFolderName }) })
      setFolders((current) => current.map((item) => item.id === folder.id ? result.folder : item))
      setEditingFolderId('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function requestDeleteFolder(folder: ApiAssetFolder) {
    const remove = async (deleteImages: boolean) => {
      setBusy(true)
      try {
        await apiRequest(`/api/folders/${encodeURIComponent(folder.id)}?deleteImages=${deleteImages}`, { method: 'DELETE' })
        setFolders((current) => current.filter((item) => item.id !== folder.id))
        if (folderId === folder.id) setFolderId(undefined)
        setConfirm(null)
        await loadAssets()
        props.onChanged()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    }
    setConfirm({
      title: `删除“${folder.name}”`,
      message: '你可以只删除文件夹并保留图片，也可以同时永久删除其中图片和对象存储文件。',
      actions: [
        { label: '仅删除文件夹', action: () => remove(false) },
        { label: '文件夹和图片都删除', tone: 'danger', action: () => remove(true) },
      ],
    })
  }

  async function renameAsset(asset: ApiAsset) {
    if (!editingAssetName.trim()) return
    setBusy(true)
    try {
      const result = await apiRequest<{ image: ApiAsset }>(`/api/images/${encodeURIComponent(asset.id)}`, { method: 'PATCH', body: JSON.stringify({ name: editingAssetName }) })
      setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, name: result.image.name } : item))
      setEditingAssetId('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function moveImages(imageIds: string[], targetFolderId: string | null) {
    setBusy(true)
    setError('')
    try {
      await apiRequest('/api/images/move', { method: 'POST', body: JSON.stringify({ imageIds, folderId: targetFolderId }) })
      setAssets((current) => {
        const moved = mergeMovedAssets(current, imageIds, targetFolderId)
        if (folderId === undefined || folderId === targetFolderId) return moved
        return removeAssets(moved, imageIds)
      })
      setSelected(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  function requestDeleteAsset(asset: ApiAsset) {
    setConfirm({
      title: `删除“${asset.name}”`,
      message: '图片记录和对象存储中的原文件都会被永久删除，所属任务仍会保留。',
      actions: [{
        label: '永久删除图片',
        tone: 'danger',
        action: async () => {
          setBusy(true)
          try {
            await apiRequest(`/api/images/${encodeURIComponent(asset.id)}`, { method: 'DELETE' })
            setAssets((current) => removeAssets(current, [asset.id]))
            setSelected((current) => { const next = new Set(current); next.delete(asset.id); return next })
            setConfirm(null)
            props.onChanged()
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        },
      }],
    })
  }

  return (
    <section className="asset-library asset-manager">
      <div className="asset-library-head">
        <div><span className="panel-eyebrow">PERSISTED IMAGE LIBRARY</span><h1>图片资产</h1><p>用名称、搜索和文件夹整理每一张生成图片。</p></div>
        <div>
          <button type="button" onClick={() => void Promise.all([loadFolders(), loadAssets()]).catch((err) => setError(err instanceof Error ? err.message : String(err)))}><RefreshIcon />刷新</button>
          <button type="button" className="asset-create" onClick={props.onCreate}><SparklesIcon />创作新图片</button>
        </div>
      </div>
      <div className="asset-manager-layout">
        <aside className="asset-folders" aria-label="图片文件夹">
          <div className="asset-folders-head"><span>文件夹</span><button type="button" onClick={() => setCreatingFolder(true)} aria-label="创建文件夹" title="创建文件夹"><PlusIcon /></button></div>
          <select value={folderId === undefined ? 'all' : folderId === null ? 'uncategorized' : folderId} onChange={(event) => setFolderId(event.target.value === 'all' ? undefined : event.target.value === 'uncategorized' ? null : event.target.value)} aria-label="选择文件夹"><option value="all">全部图片</option><option value="uncategorized">未分类</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>
          {typeof folderId === 'string' ? <div className="mobile-folder-actions"><span>{folders.find((folder) => folder.id === folderId)?.name}</span><button type="button" onClick={() => { const folder = folders.find((item) => item.id === folderId); if (folder) { setEditingFolderId(folder.id); setEditingFolderName(folder.name) } }} aria-label="重命名当前文件夹"><EditIcon /></button><button type="button" onClick={() => { const folder = folders.find((item) => item.id === folderId); if (folder) requestDeleteFolder(folder) }} aria-label="删除当前文件夹"><TrashIcon /></button></div> : null}
          <button type="button" className={folderId === undefined ? 'active' : ''} onClick={() => setFolderId(undefined)}><ImageIcon />全部图片</button>
          <button type="button" className={folderId === null ? 'active' : ''} onClick={() => setFolderId(null)}><FolderIcon />未分类</button>
          {creatingFolder ? <div className="folder-editor"><input value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="文件夹名称" autoFocus maxLength={80} onKeyDown={(event) => { if (event.key === 'Enter') void createFolder(); if (event.key === 'Escape') setCreatingFolder(false) }} /><button type="button" onClick={() => void createFolder()} disabled={busy || !newFolderName.trim()}><CheckCircleIcon /></button></div> : null}
          {folders.map((folder) => editingFolderId === folder.id ? <div key={folder.id} className="folder-editor"><input value={editingFolderName} onChange={(event) => setEditingFolderName(event.target.value)} autoFocus maxLength={80} onKeyDown={(event) => { if (event.key === 'Enter') void renameFolder(folder); if (event.key === 'Escape') setEditingFolderId('') }} /><button type="button" onClick={() => void renameFolder(folder)}><CheckCircleIcon /></button></div> : <div key={folder.id} className={`folder-row ${folderId === folder.id ? 'active' : ''}`}><button type="button" onClick={() => setFolderId(folder.id)}><FolderIcon />{folder.name}</button><button type="button" onClick={() => { setEditingFolderId(folder.id); setEditingFolderName(folder.name) }} aria-label={`重命名${folder.name}`}><EditIcon /></button><button type="button" onClick={() => requestDeleteFolder(folder)} aria-label={`删除${folder.name}`}><TrashIcon /></button></div>)}
        </aside>
        <main className="asset-results">
          <div className="asset-results-toolbar">
            <label><SearchIcon /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索图片名称或提示词" aria-label="搜索图片资产" />{query ? <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">×</button> : null}</label>
            <div className="asset-results-head" aria-live="polite"><span>{loading ? assets.length ? '正在更新…' : '正在加载…' : `${assets.length} 张图片`}</span>{selected.size ? <b>已选择 {selected.size} 张</b> : null}</div>
          </div>
          {error ? <div className="asset-manager-error">{error}<button type="button" onClick={() => setError('')}>关闭</button></div> : null}
          <div className="asset-grid">{assets.map((asset) => {
            const expanded = expandedAssetIds.has(asset.id)
            const expandable = asset.prompt.trim().length > 120
            return <article key={asset.id} className={selected.has(asset.id) ? 'selected' : ''}>
              <div className="asset-image" onClick={() => props.onOpenGeneration(asset.generationId)}><img src={imageUrl(asset.id)} alt={asset.name} /><label onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selected.has(asset.id)} onChange={() => setSelected((current) => toggleAssetSelection(current, asset.id))} aria-label={`选择${asset.name}`} /><span><CheckCircleIcon /></span></label></div>
              <div className="asset-card-body">
                {editingAssetId === asset.id ? <div className="asset-name-editor"><input value={editingAssetName} onChange={(event) => setEditingAssetName(event.target.value)} maxLength={80} autoFocus onKeyDown={(event) => { if (event.key === 'Enter') void renameAsset(asset); if (event.key === 'Escape') setEditingAssetId('') }} /><button type="button" onClick={() => void renameAsset(asset)} aria-label="保存图片名称"><CheckCircleIcon /></button></div> : <h2 title={asset.name}>{asset.name}</h2>}
                <div className="asset-prompt-wrap">
                  <p id={`asset-prompt-${asset.id}`} className={`asset-prompt ${!expandable || expanded ? 'expanded' : ''}`}>{asset.prompt}</p>
                  {expandable ? <button className="asset-prompt-toggle" type="button" aria-expanded={expanded} aria-controls={`asset-prompt-${asset.id}`} onClick={() => setExpandedAssetIds((current) => toggleExpandedAsset(current, asset.id))}>{expanded ? '收起' : '展开'}</button> : null}
                </div>
                <footer><select value={asset.folderId ?? ''} onChange={(event) => void moveImages([asset.id], event.target.value || null)} aria-label={`移动${asset.name}`}><option value="">未分类</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><button type="button" onClick={() => { setEditingAssetId(asset.id); setEditingAssetName(asset.name) }} aria-label={`重命名${asset.name}`}><EditIcon /></button><button type="button" onClick={() => requestDeleteAsset(asset)} aria-label={`删除${asset.name}`}><TrashIcon /></button></footer>
              </div>
            </article>
          })}</div>
          {!loading && !assets.length ? <div className="asset-empty"><ImageIcon /><b>{search ? '没有匹配的图片' : '这个位置还没有图片'}</b><span>{search ? '尝试更换图片名称或提示词关键词。' : '可以移动已有图片到这里，或开始一次新创作。'}</span></div> : null}
          {nextCursor ? <button className="asset-load-more" type="button" disabled={loading} onClick={() => void loadAssets(nextCursor)}>{loading ? '正在加载…' : '加载更多'}</button> : null}
        </main>
      </div>
      {selected.size ? <div className="asset-bulk-bar"><span>已选择 {selected.size} 张</span><select defaultValue="" onChange={(event) => { const value = event.target.value; if (value) void moveImages([...selected], value === 'uncategorized' ? null : value); event.target.value = '' }} aria-label="批量移动到文件夹"><option value="">移动到…</option><option value="uncategorized">未分类</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><button type="button" onClick={() => setSelected(new Set())}>取消选择</button></div> : null}
      {confirm ? <AuroraConfirmDialog {...confirm} busy={busy} onClose={() => !busy && setConfirm(null)} /> : null}
    </section>
  )
}
