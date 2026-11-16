import type { AgentConversation, AgentInputDraft, AppMode, BatchProgress, InputImage, MaskDraft, TaskRecord } from '../types'
import { isEmptyAgentConversation } from './agentConversationState'
import { restoreAgentInputDraftState, restoreGalleryInputDraftState, saveActiveAgentInputDrafts, saveGalleryInputDraft } from './inputDraftState'

/** 进入隐私模式前的输入框，退出时恢复；隐私模式期间持久化也使用它，刷新后不丢失 */
export interface PrivacyInputSnapshot {
  appMode: AppMode
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  galleryInputDraft: AgentInputDraft | null
  agentInputDrafts: Record<string, AgentInputDraft>
  activeAgentConversationId: string | null
  reusedTaskApiProfileId: string | null
  reusedTaskApiProfileName: string | null
  reusedTaskApiProfileMissing: boolean
  reusedTaskApiModel: string | null
}

export interface PrivacyModeState {
  startedAt: number
  hiddenTaskIds: Set<string>
  /** 进入时已有内容的对话；其中仍在进行的回合之后创建的任务也要隐藏 */
  hiddenConversationIds: Set<string>
  inputSnapshot: PrivacyInputSnapshot
  /** 进入时停止的批量提交中尚未提交的提示词数，退出时提示 */
  stoppedBatchPrompts: number
}

type PrivacySourceState = PrivacyInputSnapshot & { tasks: TaskRecord[]; agentConversations: AgentConversation[]; batchProgress: BatchProgress | null }

export function createPrivacyModeState(state: PrivacySourceState, now: number): PrivacyModeState {
  return {
    startedAt: now,
    hiddenTaskIds: new Set(state.tasks.map((task) => task.id)),
    // 空对话会被“新对话”复用并刷新创建时间，不需要隐藏
    hiddenConversationIds: new Set(state.agentConversations.filter((c) => !isEmptyAgentConversation(c)).map((c) => c.id)),
    inputSnapshot: {
      appMode: state.appMode,
      prompt: state.prompt,
      inputImages: state.inputImages,
      maskDraft: state.maskDraft,
      // 退出时不重新打开遮罩编辑器
      maskEditorImageId: null,
      galleryInputDraft: state.galleryInputDraft,
      agentInputDrafts: state.agentInputDrafts,
      activeAgentConversationId: state.activeAgentConversationId,
      reusedTaskApiProfileId: state.reusedTaskApiProfileId,
      reusedTaskApiProfileName: state.reusedTaskApiProfileName,
      reusedTaskApiProfileMissing: state.reusedTaskApiProfileMissing,
      reusedTaskApiModel: state.reusedTaskApiModel,
    },
    stoppedBatchPrompts: state.batchProgress ? state.batchProgress.total - state.batchProgress.started : 0,
  }
}

// 导入的旧数据创建时间早于进入时间，也一并隐藏
export function isPrivacyHiddenConversation(privacy: PrivacyModeState | null, conversation: Pick<AgentConversation, 'id' | 'createdAt'>) {
  if (!privacy) return false
  return conversation.createdAt < privacy.startedAt || privacy.hiddenConversationIds.has(conversation.id)
}

export function isPrivacyHiddenTask(privacy: PrivacyModeState | null, task: Pick<TaskRecord, 'id' | 'createdAt' | 'agentConversationId'>) {
  if (!privacy) return false
  return task.createdAt < privacy.startedAt || privacy.hiddenTaskIds.has(task.id) || Boolean(task.agentConversationId && privacy.hiddenConversationIds.has(task.agentConversationId))
}

export function getPrivacySnapshotImageIds(privacy: PrivacyModeState | null) {
  if (!privacy) return []
  const snapshot = privacy.inputSnapshot
  return [snapshot, snapshot.galleryInputDraft, ...Object.values(snapshot.agentInputDrafts)]
    .flatMap((draft) => draft?.inputImages.flatMap((img) => img.markupImageId ? [img.id, img.markupImageId] : [img.id]) ?? [])
}

/** 退出隐私模式时的输入框：恢复进入前的草稿，丢弃隐私模式中未提交的输入 */
export function restorePrivacyInputState(snapshot: PrivacyInputSnapshot, current: { appMode: AppMode; activeAgentConversationId: string | null }) {
  const galleryInputDraft = saveGalleryInputDraft(snapshot)
  const agentInputDrafts = saveActiveAgentInputDrafts(snapshot)
  return {
    galleryInputDraft,
    agentInputDrafts,
    ...(current.appMode === 'gallery'
      ? restoreGalleryInputDraftState(galleryInputDraft)
      : restoreAgentInputDraftState(agentInputDrafts, current.activeAgentConversationId)),
    maskEditorImageId: null,
    reusedTaskApiProfileId: snapshot.reusedTaskApiProfileId,
    reusedTaskApiProfileName: snapshot.reusedTaskApiProfileName,
    reusedTaskApiProfileMissing: snapshot.reusedTaskApiProfileMissing,
    reusedTaskApiModel: snapshot.reusedTaskApiModel,
  }
}
