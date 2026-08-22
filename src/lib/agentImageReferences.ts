import type { AgentRound, TaskRecord } from '../types'
import { replaceImageMentionsForApi, stripImageMentionMarkers } from './promptImageMentions'

const AGENT_ROUND_IMAGE_REFERENCE_RE = /@(?:第)?(\d+)轮图(\d+)/g
const AGENT_REF_TAG_RE = /<ref\b[^>]*\bid=(["'])(round-(\d+)-(?:image|reference)-(\d+))\1[^>]*\/?>/g

export function getAgentCurrentReferenceId(round: AgentRound, index: number) {
  return `round-${round.index}-reference-${index + 1}`
}

export function getAgentGeneratedImageReferenceId(round: AgentRound, index: number) {
  return `round-${round.index}-image-${index + 1}`
}

export function getAgentReferenceTag(referenceId: string) {
  return `<ref id="${referenceId}" />`
}

export function getAgentRemovedReferenceTag(referenceId: string) {
  return `<removed_ref id="${referenceId}" />`
}

export function collectAgentRoundOutputImageSlots(round: AgentRound, tasks: TaskRecord[]) {
  const slots: Array<string | null> = []
  for (const taskId of round.outputTaskIds) {
    const task = tasks.find((item) => item.id === taskId)
    if (!task) {
      slots.push(null)
      continue
    }
    slots.push(...task.outputImages)
  }
  return slots
}

export function extractAgentReferenceIds(text: string) {
  return Array.from(text.matchAll(AGENT_REF_TAG_RE), (match) => match[2]).filter((id): id is string => Boolean(id))
}

export function resolveAgentPromptImageReferences(prompt: string, rounds: AgentRound[], tasks: TaskRecord[]) {
  const refs: string[] = []
  for (const match of prompt.matchAll(AGENT_ROUND_IMAGE_REFERENCE_RE)) {
    const roundIndex = Number(match[1]) - 1
    const imageIndex = Number(match[2]) - 1
    const round = rounds[roundIndex]
    if (!round || imageIndex < 0) continue

    const imageId = collectAgentRoundOutputImageSlots(round, tasks)[imageIndex]
    if (imageId) refs.push(imageId)
  }
  return refs
}

export function replaceAgentPromptImageReferencesForApi(
  prompt: string,
  currentRound: AgentRound,
  rounds: AgentRound[],
  tasks: TaskRecord[],
) {
  const withCurrentReferences = replaceImageMentionsForApi(
    prompt,
    currentRound.inputImageIds.length,
    (index) => getAgentReferenceTag(getAgentCurrentReferenceId(currentRound, index)),
  )

  const replaceGeneratedReference = (text: string, roundNumber: string, imageNumber: string) => {
    const roundIndex = Number(roundNumber) - 1
    const imageIndex = Number(imageNumber) - 1
    const sourceRound = rounds[roundIndex]
    if (!sourceRound || imageIndex < 0) return text

    const imageId = collectAgentRoundOutputImageSlots(sourceRound, tasks)[imageIndex]
    if (!imageId) return getAgentRemovedReferenceTag(getAgentGeneratedImageReferenceId(sourceRound, imageIndex))

    const currentReferenceIndex = currentRound.inputImageIds.indexOf(imageId)
    const referenceId = currentReferenceIndex >= 0
      ? getAgentCurrentReferenceId(currentRound, currentReferenceIndex)
      : getAgentGeneratedImageReferenceId(sourceRound, imageIndex)
    return getAgentReferenceTag(referenceId)
  }
  const withAgentReferences = withCurrentReferences.replace(AGENT_ROUND_IMAGE_REFERENCE_RE, replaceGeneratedReference)
  return stripImageMentionMarkers(withAgentReferences)
}
