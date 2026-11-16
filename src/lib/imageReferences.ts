import type { AgentConversation, AgentInputDraft, InputImage, TaskRecord } from '../types'
import { getPrivacySnapshotImageIds, type PrivacyModeState } from './privacyMode'

type ImageReferenceState = {
  tasks: TaskRecord[]
  inputImages: InputImage[]
  galleryInputDraft: AgentInputDraft | null
  agentInputDrafts: Record<string, AgentInputDraft>
  agentConversations: AgentConversation[]
  privacyMode: PrivacyModeState | null
}

export function addTaskReferencedImageIds(ids: Set<string>, task: TaskRecord) {
  for (const id of [
    ...task.inputImageIds,
    ...task.outputImages,
    ...task.transparentOriginalImages ?? [],
    ...task.streamPartialImageIds ?? [],
    task.maskTargetImageId,
    task.maskImageId,
    task.markupImageId,
  ]) {
    if (id) ids.add(id)
  }
}

export function getReferencedImageIds(state: ImageReferenceState) {
  const ids = new Set(getPrivacySnapshotImageIds(state.privacyMode))
  for (const task of state.tasks) addTaskReferencedImageIds(ids, task)
  const inputs = [state.inputImages, state.galleryInputDraft?.inputImages ?? [], ...Object.values(state.agentInputDrafts).map((draft) => draft.inputImages)]
  for (const images of inputs) {
    for (const img of images) {
      ids.add(img.id)
      if (img.markupImageId) ids.add(img.markupImageId)
    }
  }
  for (const conversation of state.agentConversations) {
    for (const item of [...conversation.rounds, ...conversation.messages]) {
      for (const id of item.inputImageIds ?? []) ids.add(id)
      if (item.maskTargetImageId) ids.add(item.maskTargetImageId)
      if (item.maskImageId) ids.add(item.maskImageId)
    }
  }
  return ids
}
