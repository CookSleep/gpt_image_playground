import { useEffect, useMemo, useState, useRef, useCallback, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { AgentMessage, AgentRound, TaskRecord } from '../types'
import { editOutputs, regenerateAgentAssistantMessage, removeMultipleTasks, removeTask, reuseConfig, useStore } from '../store'
import { getActiveAgentRounds, getAgentBranchLeafId, getConversationSearchText, getAgentRoundTaskIds, getAgentSiblingRounds } from '../lib/agentConversationState'
import { ensureImageCached, getCachedImage } from '../lib/imageCache'
import { getPromptMentionParts } from '../lib/promptImageMentions'
import { copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import type { AgentWebSearchStatus } from '../lib/agentWebSearch'
import { getAgentAssistantBlocks, getAgentAssistantCopyContent, getRoundTaskSlots } from '../lib/agentAssistantBlocks'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { downloadImageEntriesAsZip, downloadImageIds, getImageZipEntries } from '../lib/downloadImages'
import TaskCard from './TaskCard'
import MarkdownRenderer from './MarkdownRenderer'
import { TooltipButton as AgentActionButton } from './TooltipButton'
import { TrashIcon, DownloadIcon, EditIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, SidebarLeftIcon, FavoriteIcon, CloseIcon, CopyIcon, RefreshIcon, ArrowDownIcon } from './icons'

function ChatImageThumb({ imageId, imageIndex, maskImageId }: { imageId: string; imageIndex: number; maskImageId?: string | null }) {
  const [src, setSrc] = useState<string>(() => getCachedImage(imageId) || '')
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)

  useEffect(() => {
    let cancelled = false

    if (maskImageId) {
      Promise.all([ensureImageCached(imageId), ensureImageCached(maskImageId)])
        .then(async ([baseUrl, maskUrl]) => {
          if (!baseUrl || !maskUrl) return baseUrl || ''
          return createMaskPreviewDataUrl(baseUrl, maskUrl)
        })
        .then((url) => {
          if (!cancelled && url) setSrc(url)
        })
        .catch(() => {
          if (!cancelled) setSrc(getCachedImage(imageId) || '')
        })
      return () => { cancelled = true }
    }

    const cached = getCachedImage(imageId)
    if (cached) {
      setSrc(cached)
      return () => { cancelled = true }
    }
    ensureImageCached(imageId).then((url) => {
      if (!cancelled && url) setSrc(url)
    })
    return () => { cancelled = true }
  }, [imageId, maskImageId])

  return (
    <div 
      className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-lg shadow-sm cursor-pointer transition-opacity hover:opacity-90 ${
        maskImageId ? 'border-2 border-blue-500' : 'border border-gray-200 dark:border-white/[0.08]'
      }`}
      onClick={() => setLightboxImageId(imageId, [imageId])}
    >
      {src ? <img src={src} className="h-full w-full object-cover" alt="" /> : <div className="h-full w-full bg-gray-100 dark:bg-white/[0.04]" />}
      {maskImageId && (
        <span className="absolute left-1 top-1 z-10 rounded bg-blue-500/90 px-1.5 py-0.5 text-[8px] font-bold leading-none tracking-wider text-white backdrop-blur-sm pointer-events-none">
          MASK
        </span>
      )}
      <span className="absolute bottom-1 left-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-black/55 text-[9px] font-semibold text-white backdrop-blur-sm pointer-events-none">
        {imageIndex + 1}
      </span>
    </div>
  )
}

function AgentStreamingCursor() {
  return (
    <span
      aria-label="正在生成"
      className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500 align-baseline dark:bg-blue-400"
    />
  )
}

function formatTime(value: number) {
  return new Date(value).toLocaleString()
}

function AgentWebSearchInlineStatus({ status }: { status: AgentWebSearchStatus }) {
  return (
    <span className="inline-flex text-sm font-medium text-gray-500 dark:text-gray-400">
      <span className={status.completed ? undefined : 'agent-web-search-running-text'}>{status.text}</span>
    </span>
  )
}

function AgentWebSearchStatusLines({ statuses }: { statuses: AgentWebSearchStatus[] }) {
  if (statuses.length === 0) return null
  return (
    <div className="mb-2 space-y-1">
      {statuses.map((status, index) => (
        <div key={`${status.text}-${index}`}>
          <AgentWebSearchInlineStatus status={status} />
        </div>
      ))}
    </div>
  )
}

const MOBILE_HEADER_PULL_THRESHOLD = 24
const MOBILE_HEADER_PULL_MAX_OFFSET = 48
const MOBILE_HEADER_EDGE_GUARD = 24

function getPageScrollTop() {
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0
}

export default function AgentWorkspace() {
  const conversations = useStore((s) => s.agentConversations)
  const conversationsLoaded = useStore((s) => s.agentConversationsLoaded)
  const activeConversationId = useStore((s) => s.activeAgentConversationId)
  const createConversation = useStore((s) => s.createAgentConversation)
  const setActiveConversationId = useStore((s) => s.setActiveAgentConversationId)
  const renameConversation = useStore((s) => s.renameAgentConversation)
  const deleteConversation = useStore((s) => s.deleteAgentConversation)
  const deleteAgentRound = useStore((s) => s.deleteAgentRound)
  const deleteAgentAssistantMessage = useStore((s) => s.deleteAgentAssistantMessage)
  const sidebarCollapsed = useStore((s) => s.agentSidebarCollapsed)
  const setSidebarCollapsed = useStore((s) => s.setAgentSidebarCollapsed)
  const agentMobileHeaderVisible = useStore((s) => s.agentMobileHeaderVisible)
  const setAgentMobileHeaderVisible = useStore((s) => s.setAgentMobileHeaderVisible)
  const appMode = useStore((s) => s.appMode)
  const tasks = useStore((s) => s.tasks)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setPrompt = useStore((s) => s.setPrompt)
  const setInputImages = useStore((s) => s.setInputImages)
  const setMaskDraft = useStore((s) => s.setMaskDraft)
  const clearMaskDraft = useStore((s) => s.clearMaskDraft)
  const setAppMode = useStore((s) => s.setAppMode)
  const agentScrollToBottomAfterSubmit = useStore((s) => s.settings.agentScrollToBottomAfterSubmit)
  const agentEditingRoundId = useStore((s) => s.agentEditingRoundId)
  const agentEditingConversationId = useStore((s) => s.agentEditingConversationId)
  const setAgentEditingConversationId = useStore((s) => s.setAgentEditingConversationId)
  const setAgentEditingRoundId = useStore((s) => s.setAgentEditingRoundId)
  const setActiveAgentRoundId = useStore((s) => s.setActiveAgentRoundId)
  const showToast = useStore((s) => s.showToast)
  const openFavoritePicker = useStore((s) => s.openFavoritePicker)
  const agentGeneratingTitleIds = useStore((s) => s.agentGeneratingTitleIds)
  const conversation = conversations.find((item) => item.id === activeConversationId) ?? null
  const [editingConversationTitle, setEditingConversationTitle] = useState('')

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomSentinelRef = useRef<HTMLDivElement>(null)
  const messageRefs = useRef(new Map<string, HTMLElement>())
  const [scrollTargetRoundId, setScrollTargetRoundId] = useState<string | null>(null)
  const [pullDownOffset, setPullDownOffset] = useState(0)
  const [mobileTopBarVisible, setMobileTopBarVisible] = useState(true)
  const [conversationSearchQuery, setConversationSearchQuery] = useState('')
  const [conversationActionsId, setConversationActionsId] = useState<string | null>(null)
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true)
  const touchStartY = useRef(-1)
  const conversationLongPressTimer = useRef<number | null>(null)
  const autoScrollStateRef = useRef<{ conversationId: string | null; lastUserMessageSignature: string | null }>({ conversationId: null, lastUserMessageSignature: null })
  const errorCopyPointerDownRef = useRef<{ x: number; y: number } | null>(null)

  const updateIsScrolledToBottom = useCallback(() => {
    const sentinel = bottomSentinelRef.current
    if (appMode !== 'agent' || !sentinel) {
      setIsScrolledToBottom(true)
      return
    }

    const viewportHeight = window.visualViewport?.height ?? window.innerHeight
    setIsScrolledToBottom(sentinel.getBoundingClientRect().top <= viewportHeight + 24)
  }, [appMode])

  const scrollToAgentBottom = useCallback(() => {
    const scrollingElement = document.scrollingElement ?? document.documentElement
    window.scrollTo({ top: scrollingElement.scrollHeight, behavior: 'smooth' })
  }, [])

  const handleTouchStart = (e: React.TouchEvent) => {
    const touchY = e.touches[0]?.clientY ?? -1
    if (
      appMode !== 'agent' ||
      agentMobileHeaderVisible ||
      getPageScrollTop() > 0 ||
      touchY < MOBILE_HEADER_EDGE_GUARD
    ) {
      touchStartY.current = -1
      setPullDownOffset(0)
      return
    }

    touchStartY.current = touchY
  }

  const handleHeaderTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY
  }
   
  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current <= 0 || agentMobileHeaderVisible) return

    const diff = e.touches[0].clientY - touchStartY.current
    if (diff <= 0) {
      setPullDownOffset(0)
      return
    }

    if (e.cancelable) e.preventDefault()
    if (diff >= MOBILE_HEADER_PULL_THRESHOLD) {
      setAgentMobileHeaderVisible(true)
      setPullDownOffset(0)
      touchStartY.current = -1
      return
    }

    setPullDownOffset(Math.min(diff, MOBILE_HEADER_PULL_MAX_OFFSET))
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartY.current > 0 && !agentMobileHeaderVisible) {
      const touchEndY = e.changedTouches[0].clientY
      if (touchEndY - touchStartY.current >= MOBILE_HEADER_PULL_THRESHOLD) setAgentMobileHeaderVisible(true)
    }
    setPullDownOffset(0)
    touchStartY.current = -1
  }

  useEffect(() => {
    if (sidebarCollapsed) {
      setAgentEditingConversationId(null)
    }
  }, [sidebarCollapsed, setAgentEditingConversationId])

  useEffect(() => {
    if (appMode !== 'agent') return

    document.documentElement.classList.add('agent-no-pull-refresh')
    return () => document.documentElement.classList.remove('agent-no-pull-refresh')
  }, [appMode])

  useEffect(() => {
    if (!agentMobileHeaderVisible || appMode !== 'agent') return

    const handleInteract = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('header[data-no-drag-select]')) return
      setAgentMobileHeaderVisible(false)
    }

    document.addEventListener('mousedown', handleInteract, { capture: true })
    document.addEventListener('touchstart', handleInteract, { capture: true })

    return () => {
      document.removeEventListener('mousedown', handleInteract, { capture: true })
      document.removeEventListener('touchstart', handleInteract, { capture: true })
    }
  }, [agentMobileHeaderVisible, appMode, setAgentMobileHeaderVisible])

  useEffect(() => {
    if (appMode !== 'agent') return

    setMobileTopBarVisible(true)
    let lastScrollY = window.scrollY
    let ticking = false

    const handleScroll = () => {
      if (ticking) return

      window.requestAnimationFrame(() => {
        const currentScrollY = window.scrollY
        if (currentScrollY < 20) {
          setMobileTopBarVisible(true)
        } else if (currentScrollY > lastScrollY + 10) {
          setMobileTopBarVisible(false)
        } else if (currentScrollY < lastScrollY - 10) {
          setMobileTopBarVisible(true)
        }

        updateIsScrolledToBottom()

        lastScrollY = currentScrollY
        ticking = false
      })
      ticking = true
    }

    const initialFrame = window.requestAnimationFrame(updateIsScrolledToBottom)
    const visualViewport = window.visualViewport
    window.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', updateIsScrolledToBottom)
    visualViewport?.addEventListener('resize', updateIsScrolledToBottom)

    return () => {
      window.cancelAnimationFrame(initialFrame)
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', updateIsScrolledToBottom)
      visualViewport?.removeEventListener('resize', updateIsScrolledToBottom)
    }
  }, [appMode, updateIsScrolledToBottom])

  useEffect(() => {
    if (appMode !== 'agent') return
    if (!conversationsLoaded) return
    
    if (conversations.length === 0) {
      createConversation()
    } else if (!conversation) {
      const latest = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0]
      if (latest && latest.messages.length === 0) {
        setActiveConversationId(latest.id)
      } else {
        createConversation()
      }
    }
  }, [appMode, conversationsLoaded, conversations, conversation, createConversation, setActiveConversationId])

  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  )

  const filteredConversations = useMemo(() => {
    const query = conversationSearchQuery.trim().toLocaleLowerCase()
    if (!query) return sortedConversations
    return sortedConversations.filter((item) => getConversationSearchText(item).includes(query))
  }, [conversationSearchQuery, sortedConversations])

  const activeRounds = useMemo(
    () => conversation ? getActiveAgentRounds(conversation) : [],
    [conversation],
  )

  const activeMessages = useMemo(() => {
    if (!conversation) return []
    const messages: AgentMessage[] = []
    for (const round of activeRounds) {
      const userMessage = conversation.messages.find((message) => message.id === round.userMessageId)
      if (userMessage) messages.push(userMessage)
      const assistantMessage = round.assistantMessageId
        ? conversation.messages.find((message) => message.id === round.assistantMessageId)
        : conversation.messages.find((message) => message.roundId === round.id && message.role === 'assistant')
      if (assistantMessage) messages.push(assistantMessage)
    }
    return messages
  }, [activeRounds, conversation])

  useEffect(() => {
    const conversationId = conversation?.id ?? null
    const lastMessage = activeMessages[activeMessages.length - 1] ?? null
    const lastUserMessageSignature = lastMessage?.role === 'user'
      ? `${lastMessage.id}:${lastMessage.createdAt}:${lastMessage.content}`
      : null
    const previous = autoScrollStateRef.current
    const shouldScroll = appMode === 'agent' &&
      agentScrollToBottomAfterSubmit &&
      previous.conversationId === conversationId &&
      lastMessage?.role === 'user' &&
      lastUserMessageSignature != null &&
      previous.lastUserMessageSignature !== lastUserMessageSignature

    autoScrollStateRef.current = { conversationId, lastUserMessageSignature }
    if (!shouldScroll) return

    const frame = window.requestAnimationFrame(() => {
      scrollToAgentBottom()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeMessages, agentScrollToBottomAfterSubmit, appMode, conversation?.id, scrollToAgentBottom])

  useEffect(() => {
    const frame = window.requestAnimationFrame(updateIsScrolledToBottom)
    return () => window.cancelAnimationFrame(frame)
  }, [activeMessages, activeRounds, updateIsScrolledToBottom])

  useEffect(() => {
    if (!scrollTargetRoundId) return
    const id = window.requestAnimationFrame(() => {
      messageRefs.current.get(scrollTargetRoundId)?.scrollIntoView({ block: 'center' })
      setScrollTargetRoundId(null)
    })
    return () => window.cancelAnimationFrame(id)
  }, [activeMessages, scrollTargetRoundId])

  const handleSwitchBranch = (round: AgentRound, direction: -1 | 1) => {
    if (!conversation) return
    const siblings = getAgentSiblingRounds(conversation, round)
    if (siblings.length <= 1) return
    const currentIndex = siblings.findIndex((item) => item.id === round.id)
    const nextRound = siblings[(currentIndex + direction + siblings.length) % siblings.length]
    const nextLeafId = getAgentBranchLeafId(conversation, nextRound.id)
    setActiveAgentRoundId(conversation.id, nextLeafId)
    setAgentEditingRoundId(null)
    setScrollTargetRoundId(nextRound.id)
  }

  const handleDeleteConversation = (id: string) => {
    const targetConversation = conversations.find((item) => item.id === id) ?? null
    const roundIds = new Set(targetConversation?.rounds.map((round) => round.id) ?? [])
    const roundTaskIds = targetConversation?.rounds.flatMap((round) => round.outputTaskIds) ?? []
    const relatedTasks = tasks.filter((task) =>
      task.agentConversationId === id || Boolean(task.agentRoundId && roundIds.has(task.agentRoundId)),
    )
    const existingTaskIds = new Set(tasks.map((task) => task.id))
    const relatedTaskIds = Array.from(new Set([...roundTaskIds, ...relatedTasks.map((task) => task.id)]))
      .filter((taskId) => existingTaskIds.has(taskId))
    const relatedTaskIdSet = new Set(relatedTaskIds)
    const generatedImageCount = new Set(
      tasks
        .filter((task) => relatedTaskIdSet.has(task.id))
        .flatMap((task) => task.outputImages || []),
    ).size

    setConfirmDialog({
      title: '删除对话',
      message: '确定要删除这个 Agent 对话吗？',
      checkbox: generatedImageCount > 0
        ? {
            label: `同时删除对话中生成的图片（${generatedImageCount} 张）`,
            tone: 'danger',
          }
        : undefined,
      action: async (deleteGeneratedImages = false) => {
        deleteConversation(id)
        if (deleteGeneratedImages && relatedTaskIds.length > 0) await removeMultipleTasks(relatedTaskIds)
      },
    })
  }

  const startRenameConversation = (e: ReactMouseEvent | React.TouchEvent, id: string, currentTitle: string) => {
    e.stopPropagation()
    if (agentGeneratingTitleIds[id]) {
      showToast('标题生成中，暂不能修改标题', 'info')
      return
    }
    setAgentEditingConversationId(id)
    setEditingConversationTitle(currentTitle)
  }

  const confirmRenameConversation = () => {
    if (agentEditingConversationId && editingConversationTitle.trim() && !agentGeneratingTitleIds[agentEditingConversationId]) {
      renameConversation(agentEditingConversationId, editingConversationTitle.trim())
    }
    setAgentEditingConversationId(null)
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      confirmRenameConversation()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setAgentEditingConversationId(null)
    }
  }

  // Effect to sync title when editing id is set from outside (e.g. Header)
  useEffect(() => {
    if (agentEditingConversationId) {
      const convo = conversations.find(c => c.id === agentEditingConversationId)
      if (convo) {
        setEditingConversationTitle(convo.title)
      }
    }
  }, [agentEditingConversationId, conversations])

  const clearConversationLongPressTimer = () => {
    if (conversationLongPressTimer.current == null) return
    window.clearTimeout(conversationLongPressTimer.current)
    conversationLongPressTimer.current = null
  }

  const handleConversationPointerDown = (id: string, e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return
    clearConversationLongPressTimer()
    conversationLongPressTimer.current = window.setTimeout(() => {
      setConversationActionsId(id)
      conversationLongPressTimer.current = null
    }, 450)
  }

  const handleConversationSelect = (id: string) => {
    setActiveConversationId(id)
    if (conversationActionsId && conversationActionsId !== id) setConversationActionsId(null)
  }

  useEffect(() => {
    if (!conversationActionsId) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-agent-conversation-item]')) return
      setConversationActionsId(null)
    }

    document.addEventListener('pointerdown', handlePointerDown, { capture: true })
    return () => document.removeEventListener('pointerdown', handlePointerDown, { capture: true })
  }, [conversationActionsId])

  const handleDeleteMessage = (message: AgentMessage, round: AgentRound) => {
    const isUserMessage = message.role === 'user'
    const conversationId = conversation?.id
    setConfirmDialog({
      title: isUserMessage ? '删除轮次' : '删除消息',
      message: isUserMessage
        ? '确定要删除这轮任务吗？这会删除这条消息和它的输出，后续消息会被保留。'
        : '确定要删除这条消息吗？这会同时删除这条回复生成的图片。',
      awaitAction: true,
      action: async () => {
        if (!conversationId) return true
        try {
          const result = isUserMessage
            ? await deleteAgentRound(conversationId, round.id)
            : await deleteAgentAssistantMessage(conversationId, message.id)
          if (result === 'running') {
            showToast('该轮次仍在生成，请先停止生成后再删除', 'info')
            return true
          }
          if (result === 'not-found') {
            showToast(isUserMessage ? '该轮次已不存在' : '该消息已不存在', 'info')
            return true
          }
          if (result === 'deleted-with-warning') {
            showToast('已删除，但本地存储或图片清理未完成', 'error')
            return true
          }
          showToast(isUserMessage ? '已删除轮次' : '已删除消息', 'success')
          return true
        } catch (err) {
          console.error(err)
          showToast(isUserMessage ? '删除轮次失败' : '删除消息失败', 'error')
          return false
        }
      },
    })
  }

  const handleReuse = (task: TaskRecord) => {
    setConfirmDialog({
      title: '切换到画廊模式？',
      message: '复用参数会应用到画廊输入区。切换到画廊模式后，当前 Agent 对话仍会保留。',
      confirmText: '切换并复用',
      cancelText: '取消',
      action: () => {
        setAppMode('gallery')
        void reuseConfig(task)
      },
    })
  }

  const handleEditRoundMessage = async (round: AgentRound, content: string) => {
    setAgentEditingRoundId(round.id)
    clearMaskDraft()

    const inputImages = await Promise.all(
      round.inputImageIds.map(async (id) => ({
        id,
        dataUrl: await ensureImageCached(id) || '',
      })),
    )
    setInputImages(inputImages)
    const maskTargetImageId = round.maskTargetImageId ?? (round.maskImageId ? round.inputImageIds[0] : null)
    if (maskTargetImageId && round.maskImageId && inputImages.some((img) => img.id === maskTargetImageId)) {
      const maskDataUrl = await ensureImageCached(round.maskImageId)
      if (maskDataUrl) {
        setMaskDraft({
          targetImageId: maskTargetImageId,
          maskDataUrl,
          updatedAt: Date.now(),
        })
      }
    }
    setPrompt(content)
  }

  const handleCopyMessage = async (content: string, successMessage = '提示词已复制', failureMessage = '复制提示词失败') => {
    try {
      await copyTextToClipboard(content)
      showToast(successMessage, 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage(failureMessage, err), 'error')
    }
  }

  const handleErrorCopyPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    errorCopyPointerDownRef.current = { x: e.clientX, y: e.clientY }
  }

  const handleErrorCopyClick = (e: ReactMouseEvent<HTMLDivElement>, content: string) => {
    e.stopPropagation()

    const pointerDown = errorCopyPointerDownRef.current
    errorCopyPointerDownRef.current = null
    if (pointerDown && Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 4) return

    const selection = window.getSelection()
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      const target = e.currentTarget
      if ((selection.anchorNode && target.contains(selection.anchorNode)) || (selection.focusNode && target.contains(selection.focusNode))) return
    }

    void handleCopyMessage(content, '完整报错已复制', '复制完整报错失败')
  }

  return (
    <main 
      data-agent-workspace 
      className="safe-area-x mx-auto flex min-h-[calc(100vh-100px)] flex-col lg:flex-row max-w-7xl lg:gap-3 px-3 lg:px-0 relative overflow-visible transition-all duration-300"
    >
      {/* Pull Down Indicator */}
      {pullDownOffset > 0 && !agentMobileHeaderVisible && (
        <div 
          className="fixed top-0 left-0 right-0 z-50 flex justify-center items-end pointer-events-none sm:hidden"
          style={{ height: `${pullDownOffset + 10}px`, opacity: pullDownOffset / MOBILE_HEADER_PULL_MAX_OFFSET }}
        >
          <div className="bg-black/60 backdrop-blur-sm text-white rounded-full p-1 mb-2 shadow-lg">
            <ChevronDownIcon className="w-4 h-4" />
          </div>
        </div>
      )}

      {/* Mobile Left Sidebar Overlay Backdrop */}
      {!sidebarCollapsed && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setSidebarCollapsed(true)} />
      )}
      
      {/* Left Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-4/5 max-w-[320px] flex-col border-r border-gray-200 bg-white/95 shadow-2xl backdrop-blur transition-transform duration-300 dark:border-white/[0.08] dark:bg-gray-950/95 lg:hidden ${!sidebarCollapsed ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="pl-[max(1rem,env(safe-area-inset-left))] flex h-full min-h-0 w-full flex-col">
          <div className="safe-area-top shrink-0">
            <div className="flex h-14 items-center justify-between gap-2 px-4">
              <button type="button" onClick={() => setSidebarCollapsed(true)} className="lg:hidden p-2 -ml-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 rounded-lg transition-colors" title="折叠左侧边栏">
                <SidebarLeftIcon className="w-5 h-5" />
              </button>
              <button type="button" onClick={createConversation} className="p-2 -mr-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 lg:hover:bg-gray-100 lg:dark:hover:bg-white/[0.04] rounded-lg transition-colors" title="新对话">
                <EditIcon className="w-5 h-5" />
              </button>
            </div>
          </div>
          <div className="shrink-0 px-4 pb-3">
            <input
              type="text"
              value={conversationSearchQuery}
              onChange={(e) => setConversationSearchQuery(e.target.value)}
              placeholder="搜索聊天..."
              className="w-full rounded-xl border border-gray-200 bg-gray-100/80 px-3 py-2 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-blue-400 focus:bg-white dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-white dark:focus:border-blue-400 dark:focus:bg-white/[0.07]"
            />
          </div>
          <div className="space-y-1 overflow-y-auto flex-1 px-4 pb-4">
          {filteredConversations.length === 0 && (
            <div className="px-2 py-8 text-center text-sm text-gray-400">没有找到匹配的聊天</div>
          )}
          {filteredConversations.map((item) => {
            const isGeneratingTitle = Boolean(agentGeneratingTitleIds[item.id])
            return (
              <div
                key={item.id}
                data-agent-conversation-item
                className="group flex h-14 items-center gap-2 rounded-lg px-2 hover:bg-gray-100 dark:hover:bg-white/[0.04]"
                onPointerDown={(e) => handleConversationPointerDown(item.id, e)}
                onPointerUp={clearConversationLongPressTimer}
                onPointerCancel={clearConversationLongPressTimer}
                onPointerLeave={clearConversationLongPressTimer}
                onContextMenu={(e) => {
                  if (conversationActionsId === item.id) e.preventDefault()
                }}
              >
                {agentEditingConversationId === item.id ? (
                  <div className="min-w-0 flex-1 flex flex-col justify-center h-[38px]">
                    <input
                      type="text"
                      className="h-7 flex-1 bg-white dark:bg-black/20 border border-blue-400/50 dark:border-white/20 rounded px-1.5 py-0 text-sm leading-7 outline-none text-gray-900 dark:text-white focus:border-blue-500 dark:focus:border-white/40 shadow-sm min-w-0"
                      value={editingConversationTitle}
                      onChange={(e) => setEditingConversationTitle(e.target.value)}
                      onKeyDown={handleRenameKeyDown}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      onBlur={confirmRenameConversation}
                    />
                  </div>
                ) : (
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => handleConversationSelect(item.id)}>
                    <div className={`truncate ${item.id === activeConversationId ? 'font-semibold text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-300'}`}>{item.title}</div>
                    <div className="text-xs text-gray-400">{formatTime(item.updatedAt)}</div>
                  </button>
                )}
                <div className={`flex shrink-0 items-center gap-1 overflow-hidden transition-all duration-150 ${agentEditingConversationId === item.id ? 'w-6 opacity-100' : `group-hover:w-[4.5rem] group-hover:opacity-100 group-focus-within:w-[4.5rem] group-focus-within:opacity-100 ${conversationActionsId === item.id ? 'w-[4.5rem] opacity-100' : 'w-0 opacity-0'}`}`}>
                  {agentEditingConversationId === item.id ? (
                    <AgentActionButton
                      tooltip="确认"
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); confirmRenameConversation() }}
                      className="p-1.5 hover:bg-gray-200 dark:hover:bg-white/10 rounded-md text-green-500 hover:text-green-600 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </AgentActionButton>
                  ) : (
                    <>
                      <AgentActionButton tooltip="编辑标题" className="p-1.5 text-gray-400 hover:text-gray-700 disabled:text-gray-300 disabled:hover:text-gray-300 disabled:cursor-not-allowed dark:hover:text-gray-200 dark:disabled:text-gray-600 dark:disabled:hover:text-gray-600" onClick={(e) => startRenameConversation(e, item.id, item.title)} disabled={isGeneratingTitle}>
                        <EditIcon className="w-4 h-4" />
                      </AgentActionButton>
                      <AgentActionButton tooltip="删除" className="p-1.5 text-gray-400 hover:text-red-500" onClick={(e) => { e.stopPropagation(); handleDeleteConversation(item.id) }}>
                        <TrashIcon className="w-4 h-4" />
                      </AgentActionButton>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        </div>
      </aside>

      {/* Center Chat Area */}
      <section className="min-w-0 flex-1 flex flex-col relative">
        {/* Mobile Header Toggles */}
        <div className={`sticky top-0 z-20 lg:hidden overflow-hidden transition-all duration-300 ease-in-out ${mobileTopBarVisible ? 'max-h-16 opacity-100 mb-2' : 'max-h-0 opacity-0 mb-0 pointer-events-none'}`}>
          <div
            className="flex h-14 items-center justify-between border-b border-gray-200 bg-white/80 px-2 backdrop-blur dark:border-white/[0.08] dark:bg-gray-950/80"
            onTouchStart={handleHeaderTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <button type="button" onClick={() => setSidebarCollapsed(false)} className="p-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.04] rounded-lg transition-colors" title="展开对话列表">
              <SidebarLeftIcon className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setSidebarCollapsed(false)
                if (conversation) {
                  useStore.getState().setAgentEditingConversationId(conversation.id)
                }
              }}
              className="text-sm font-semibold text-gray-700 dark:text-gray-300 truncate flex-1 text-center px-2 hover:bg-gray-100 dark:hover:bg-white/[0.04] rounded transition-colors"
            >
              {conversation?.title || 'Agent'}
            </button>
            <button type="button" onClick={createConversation} className="p-2 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-white/[0.04] rounded-lg transition-colors" title="新对话">
              <EditIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div 
          ref={scrollContainerRef}
          className="flex-1 space-y-4 overflow-visible pb-[calc(var(--input-bar-clearance,12rem)+1.5rem)] px-1 lg:pt-14 lg:px-4"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {!conversation ? (
            <div className="py-20 text-center text-gray-400">
              <p className="mb-3">还没有 Agent 对话</p>
              <button type="button" onClick={createConversation} className="rounded-lg bg-blue-500 px-4 py-2 text-white hover:bg-blue-600 transition-colors">创建对话</button>
            </div>
          ) : (
            (() => {
              if (activeMessages.length === 0) {
                return (
                  <div className="py-20 text-center text-gray-400">
                    <p className="mb-2">开始新的 Agent 对话</p>
                    <p className="text-xs">在底部输入框发送消息即可创建第一轮对话。</p>
                  </div>
                )
              }

              const renderedMessages = activeMessages.map((message) => {
                const round = conversation.rounds.find((item) => item.id === message.roundId)
                const isAssistant = message.role === 'assistant'
                const isStreamingAssistant = isAssistant && round?.status === 'running'
                const isEditing = !isAssistant && round?.id === agentEditingRoundId
                const siblingRounds = !isAssistant && round ? getAgentSiblingRounds(conversation, round) : []
                const siblingIndex = round ? siblingRounds.findIndex((item) => item.id === round.id) : -1
                const hasBranches = siblingRounds.length > 1
                const taskSlotsForRound = isAssistant ? getRoundTaskSlots(round ?? null, tasks) : []
                const tasksForRound = taskSlotsForRound.map((slot) => slot.task).filter(Boolean) as TaskRecord[]
                const hasRoundTasks = tasksForRound.length > 0
                const favoriteTasksForRound = tasksForRound.filter((task) => (task.outputImages?.length ?? 0) > 0)
                const hasRoundFavoriteTasks = favoriteTasksForRound.length > 0
                const allRoundTasksFavorited = hasRoundFavoriteTasks && favoriteTasksForRound.every((task) => task.isFavorite)
                const assistantBlocks = isAssistant ? getAgentAssistantBlocks(round ?? null, taskSlotsForRound, tasks, Boolean(message.content.trim())) : []
                const inputImagesForRound = (round?.inputImageIds || []).map(id => ({ id, dataUrl: '' }))
                const parts = getPromptMentionParts(message.content, inputImagesForRound)
                return (
                  <div key={message.id} className={`flex w-full mb-6 ${isAssistant ? 'justify-start' : 'justify-end'}`}>
                    <div
                      ref={(node) => {
                        if (!isAssistant && node) messageRefs.current.set(message.roundId, node)
                        else if (!isAssistant) messageRefs.current.delete(message.roundId)
                      }}
                      className={`group flex max-w-[95%] flex-col md:max-w-[85%] lg:max-w-[75%] ${isAssistant ? 'items-start' : 'items-end'}`}
                    >
                      <article 
                        className={`relative flex min-w-[16rem] max-w-full flex-col rounded-2xl p-4 transition-all duration-200 ${
                        isAssistant 
                          ? 'bg-white/70 dark:bg-white/[0.03] border border-gray-200 dark:border-white/[0.08] rounded-tl-sm hover:bg-white dark:hover:bg-white/[0.04]' 
                          : `bg-gray-100 dark:bg-[#2A2D31] rounded-tr-sm ${isEditing ? 'ring-2 ring-blue-500/50 dark:ring-blue-400/50' : ''}`
                      }`}
                      >
                    <div className="mb-2 flex items-center justify-between gap-4 text-sm text-gray-500 dark:text-gray-400">
                      <span className="font-medium">
                         <span className={isAssistant ? 'text-blue-600 dark:text-blue-400 font-semibold' : 'text-gray-700 dark:text-gray-200 font-semibold'}>{isAssistant ? 'Agent' : '用户'}</span> <span className="opacity-60 font-normal ml-1">· 第 {round?.index ?? '?'} 轮</span>
                      </span>
                    </div>
                    
                    {message.role === 'user' && round && round.inputImageIds.length > 0 && (
                      <div className="flex gap-2 mb-3 overflow-x-auto pb-1" onClick={e => e.stopPropagation()}>
                          {round.inputImageIds.map((imgId, imageIndex) => (
                            <ChatImageThumb
                              key={imgId}
                              imageId={imgId}
                              imageIndex={imageIndex}
                              maskImageId={imgId === (round.maskTargetImageId ?? round.inputImageIds[0]) ? round.maskImageId : null}
                            />
                          ))}
                      </div>
                    )}

                    {round?.status === 'error' && isAssistant && message.content.startsWith('请求失败：') ? (
                      <div
                        data-selectable-text
                        className="-m-2 flex cursor-copy select-text flex-col rounded-xl p-2 transition-colors hover:bg-red-50/60 dark:hover:bg-red-500/5"
                        title="点击复制完整报错"
                        onPointerDown={handleErrorCopyPointerDown}
                        onClick={(e) => handleErrorCopyClick(e, message.content)}
                      >
                        {(() => {
                          const content = message.content.replace(/^请求失败：/, '');
                          const [mainErr, ...hints] = content.split('\n提示：');
                          return (
                            <>
                              <div className="flex items-start gap-2 text-red-500 dark:text-red-400">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-[18px] h-[18px] mt-[1.5px] flex-shrink-0">
                                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                                </svg>
                                <div className="whitespace-pre-wrap text-[14px] leading-relaxed break-words font-medium">
                                  {mainErr}
                                </div>
                              </div>
                              {hints.length > 0 && (
                                <div className="pl-[26px] mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-gray-500 dark:text-gray-400 break-words opacity-90">
                                  <span className="font-medium">提示：</span>{hints.join('\n提示：')}
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    ) : (
                      <div data-selectable-text className={`text-[15px] leading-relaxed text-gray-800 dark:text-gray-100 ${!isAssistant ? 'select-text' : ''}`}>
                        {isAssistant ? (
                          <>
                            {assistantBlocks.length > 0 ? assistantBlocks.map((block, index) => {
                              if (block.type === 'web-search') return <AgentWebSearchStatusLines key={block.key} statuses={[block.status]} />
                              if (block.type === 'text') return <div key={block.key} className={index > 0 ? 'mt-3' : undefined}><MarkdownRenderer content={block.content ?? message.content} streaming={isStreamingAssistant} /></div>
                              if (block.type === 'batch-params') {
                                return (
                                  <div key={block.key} className={index > 0 ? 'mt-3' : undefined}>
                                    <AgentWebSearchInlineStatus status={block.status} />
                                  </div>
                                )
                              }
                              if (block.type === 'deleted-image-task') {
                                return (
                                  <div key={block.key} className="mt-4 w-full min-w-[16rem] max-w-sm rounded-xl bg-gray-50/50 dark:bg-white/[0.02] border border-dashed border-gray-200 dark:border-white/[0.08] p-4 flex min-h-[120px] flex-col items-center justify-center text-gray-400 dark:text-gray-500" onClick={e => e.stopPropagation()}>
                                    <TrashIcon className="w-6 h-6 mb-2 opacity-50" />
                                    <span className="text-xs">[Image Removed]</span>
                                  </div>
                                )
                              }
                              return (
                                <div key={block.key} className="mt-4 max-w-sm" onClick={e => e.stopPropagation()}>
                                  <TaskCard
                                    task={block.task}
                                    disableSwipe={true}
                                    onClick={() => setDetailTaskId(block.task.id)}
                                    onReuse={() => handleReuse(block.task)}
                                    onEditOutputs={() => editOutputs(block.task)}
                                    onDelete={() => setConfirmDialog({ title: '删除任务', message: '确定要删除这个任务吗？', action: () => removeTask(block.task) })}
                                  />
                                </div>
                              )
                            }) : isStreamingAssistant ? <AgentStreamingCursor /> : null}
                          </>
                        ) : parts.some((part) => part.type === 'mention') ? (
                          <div className="whitespace-pre-wrap break-words">
                            {parts.map((part, i) =>
                              part.type === 'text' ? <span key={i}>{part.text}</span> : <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-blue-100/50 text-blue-700 dark:bg-blue-500/30 dark:text-blue-300 text-xs font-medium mx-0.5 align-baseline">{part.text}</span>
                            )}
                          </div>
                        ) : (
                          <MarkdownRenderer content={parts[0]?.text ?? ''} />
                        )}
                      </div>
                    )}

                      </article>

                    {!isStreamingAssistant && <div className={`mt-2 flex w-full min-w-fit items-center justify-between gap-3 px-1 transition-opacity duration-200 ${isEditing || hasBranches ? 'opacity-100' : 'opacity-100 lg:opacity-0 lg:group-hover:opacity-100'}`} onClick={e => e.stopPropagation()}>
                      <div className="flex min-w-0 items-center gap-2">
                        {isEditing && (
                          <div className="inline-flex items-center rounded-md bg-blue-100 px-2 py-1 text-xs text-blue-700 dark:bg-blue-500/20 dark:text-blue-300">
                            <span className="truncate">正在编辑</span>
                            <AgentActionButton
                              tooltip="取消编辑"
                              className="ml-1 -mr-1 p-0.5 rounded-full hover:bg-blue-200 dark:hover:bg-blue-500/40 transition-colors"
                              onClick={(e) => {
                                e.stopPropagation();
                                setPrompt('');
                                setInputImages([]);
                                clearMaskDraft();
                                setAgentEditingRoundId(null);
                              }}
                            >
                              <CloseIcon className="w-3 h-3" />
                            </AgentActionButton>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 ml-auto text-gray-400">
                        {!isAssistant && round && hasBranches && siblingIndex >= 0 && (
                          <div className="inline-flex items-center text-sm font-bold text-gray-400 dark:text-gray-500 mr-1">
                            <AgentActionButton tooltip="上一分支" className="p-1 rounded-md hover:bg-gray-200/50 dark:hover:bg-white/10 hover:text-gray-800 dark:hover:text-gray-200 transition-colors" onClick={() => handleSwitchBranch(round, -1)}>
                              <ChevronLeftIcon className="w-4 h-4" />
                            </AgentActionButton>
                            <span className="px-1 tabular-nums tracking-widest">{siblingIndex + 1}/{siblingRounds.length}</span>
                            <AgentActionButton tooltip="下一分支" className="p-1 rounded-md hover:bg-gray-200/50 dark:hover:bg-white/10 hover:text-gray-800 dark:hover:text-gray-200 transition-colors" onClick={() => handleSwitchBranch(round, 1)}>
                              <ChevronRightIcon className="w-4 h-4" />
                            </AgentActionButton>
                          </div>
                        )}
                        {isAssistant ? (
                          <>
                            <AgentActionButton tooltip="复制输出文本" className={`p-1.5 rounded-md transition-colors ${message.content.trim() ? 'text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:text-gray-200 dark:hover:bg-white/[0.06]' : 'text-gray-300 dark:text-gray-600 opacity-50 cursor-not-allowed'}`} disabled={!message.content.trim()} onClick={() => {
                              void handleCopyMessage(getAgentAssistantCopyContent(message.content, assistantBlocks), '输出文本已复制', '复制输出文本失败');
                            }}>
                              <CopyIcon className="w-4 h-4" />
                            </AgentActionButton>
                            <AgentActionButton tooltip="重新生成" className="p-1.5 rounded-md text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors" onClick={() => {
                              if (conversation && round) void regenerateAgentAssistantMessage(conversation.id, round.id);
                            }}>
                              <RefreshIcon className="w-4 h-4" />
                            </AgentActionButton>
                            <AgentActionButton tooltip={allRoundTasksFavorited ? '编辑收藏夹' : '收藏所有图片'} className={`p-1.5 rounded-md transition-colors ${hasRoundFavoriteTasks ? (allRoundTasksFavorited ? 'text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-500/10' : 'text-gray-400 hover:text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-500/10') : 'text-gray-300 dark:text-gray-600 opacity-50 cursor-not-allowed'}`} disabled={!hasRoundFavoriteTasks} onClick={() => {
                              if (!hasRoundFavoriteTasks) return;
                              openFavoritePicker(favoriteTasksForRound.map((task) => task.id));
                            }}>
                              <FavoriteIcon className="w-4 h-4" filled={allRoundTasksFavorited} />
                            </AgentActionButton>
                            <AgentActionButton tooltip="下载所有图片" className={`p-1.5 rounded-md transition-colors ${hasRoundTasks ? 'text-gray-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-500/10' : 'text-gray-300 dark:text-gray-600 opacity-50 cursor-not-allowed'}`} disabled={!hasRoundTasks} onClick={async () => {
                               const imageIds = tasksForRound.flatMap(t => t.outputImages || []);
                               if (imageIds.length === 0) return;
                               try {
                                  const roundIndex = round?.index ?? 0;
                                  const fileNameBase = 'agent-round-' + roundIndex;
                                  const settings = useStore.getState().settings;
                                  const { successCount, failCount } = settings.zipDownloadRoutes.includes('agent-round-all')
                                    ? await downloadImageEntriesAsZip(getImageZipEntries(imageIds, fileNameBase), fileNameBase)
                                    : await downloadImageIds(imageIds, fileNameBase);
                                 if (successCount === 0) {
                                   useStore.getState().showToast('下载失败', 'error');
                                 } else if (failCount > 0) {
                                   useStore.getState().showToast('部分下载失败：成功 ' + successCount + '，失败 ' + failCount, 'error');
                                 } else {
                                   useStore.getState().showToast(successCount > 1 ? '下载成功：' + successCount + ' 张图片' : '下载成功', 'success');
                                 }
                               } catch (err) {
                                 console.error(err);
                                 useStore.getState().showToast('下载失败', 'error');
                               }
                             }}>
                               <DownloadIcon className="w-4 h-4" />
                             </AgentActionButton>
                            <AgentActionButton tooltip="删除消息" className="p-1.5 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-md transition-colors" onClick={() => {
                              if (round) handleDeleteMessage(message, round);
                            }}>
                              <TrashIcon className="w-4 h-4" />
                            </AgentActionButton>
                          </>
                        ) : (
                          <>
                            <AgentActionButton tooltip="复制提示词" className="p-1.5 rounded-md hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-white/[0.04] transition-colors" onClick={() => {
                              void handleCopyMessage(message.content);
                            }}>
                              <CopyIcon className="w-4 h-4" />
                            </AgentActionButton>
                            <AgentActionButton tooltip="编辑" className="p-1.5 rounded-md hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200/50 dark:hover:bg-white/[0.04] transition-colors" onClick={() => {
                               if (round) void handleEditRoundMessage(round, message.content);
                            }}>
                              <EditIcon className="w-4 h-4" />
                            </AgentActionButton>
                            <AgentActionButton tooltip="删除" className="p-1.5 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-md transition-colors" onClick={() => {
                              if (round) handleDeleteMessage(message, round);
                            }}>
                              <TrashIcon className="w-4 h-4" />
                            </AgentActionButton>
                          </>
                        )}
                      </div>
                    </div>}
                    </div>
                </div>
                )
              })

              const runningRounds = activeRounds.filter((round) =>
                round.status === 'running' &&
                !conversation.messages.some((message) => message.roundId === round.id && message.role === 'assistant'),
              )

              return (
                <>
                  {renderedMessages}
                  {runningRounds.map((round) => (
                    <div key={`running-${round.id}`} className="flex w-full justify-start mb-6">
                      <article className="flex min-w-[16rem] max-w-[95%] flex-col rounded-2xl rounded-tl-sm border border-gray-200 bg-white/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.03] md:max-w-[85%] lg:max-w-[75%]">
                        <div className="mb-2 text-sm text-gray-500 dark:text-gray-400">
                          <span className="text-blue-600 dark:text-blue-400 font-semibold">Agent</span> <span className="ml-1 font-normal opacity-60">· 第 {round.index} 轮</span>
                        </div>
                        <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
                          <span className="inline-flex items-center gap-1.5">
                            <span>正在生成回复</span>
                            <span className="flex gap-1">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
                            </span>
                          </span>
                        </div>
                      </article>
                    </div>
                  ))}
                </>
              )
            })()
          )}
          <div ref={bottomSentinelRef} aria-hidden="true" />
        </div>

        <button
          onClick={scrollToAgentBottom}
          className={`fixed bottom-[calc(var(--input-bar-clearance,12rem)+1.5rem)] left-1/2 -translate-x-1/2 z-30 flex h-10 w-10 items-center justify-center rounded-full bg-white/90 backdrop-blur shadow-[0_2px_12px_rgba(0,0,0,0.1)] border border-gray-200/50 text-gray-500 transition-all duration-300 hover:bg-gray-50 hover:text-gray-800 dark:border-white/[0.08] dark:bg-gray-800/90 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200 ${
            !isScrolledToBottom && activeMessages.length > 0 ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0 pointer-events-none'
          }`}
          aria-label="滚动到底部"
        >
          <ArrowDownIcon className="h-5 w-5" />
        </button>
      </section>
    </main>
  )
}
