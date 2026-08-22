import type { AgentConversation, AgentInputDraft, AppMode, AppSettings, FavoriteCollection, InputImage, MaskDraft, TaskParams } from '../types'
import { normalizeSettings } from './apiProfiles'
import { normalizeAgentConversations } from './agentConversationState'
import { ensureDefaultFavoriteCollection, normalizeFavoriteCollections, resolveDefaultFavoriteCollectionId } from './favoriteState'
import { cleanStaleAgentInputDrafts, getPersistableAgentInputDrafts, isEmptyAgentInputDraft, normalizeAgentInputDraft, normalizeAgentInputDrafts, normalizeAgentInputDraftsByKey, saveGalleryInputDraft } from './inputDraftState'
import { getPersistableAgentConversations, stripPersistedAgentConversations } from './agentResponseState'

export interface PersistedAppState {
  settings: AppSettings
  previousPresetConfig?: Pick<AppSettings, 'customProviders' | 'profiles'> | null
  dismissedPresetProfileIds?: string[]
  dismissedPresetProviderIds?: string[]
  params: TaskParams
  prompt?: string
  inputImages?: InputImage[]
  dismissedCodexCliPrompts: string[]
  appMode: AppMode
  galleryInputDraft: AgentInputDraft | null
  agentConversations?: AgentConversation[]
  activeAgentConversationId: string | null
  agentInputDrafts: Record<string, AgentInputDraft>
  agentSidebarCollapsed: boolean
  agentAssetTab: 'references' | 'outputs'
  agentAssetPanelCollapsed: boolean
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
  supportPromptDismissed: boolean
  supportPromptOpen: boolean
  supportPromptSkippedForImportedData: boolean
}

type PersistedStateSource = Omit<PersistedAppState, 'prompt' | 'inputImages' | 'agentConversations'> & {
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  agentConversations: AgentConversation[]
}

type PersistedStateFallback = Pick<
  PersistedAppState,
  'settings' | 'params' | 'dismissedPresetProfileIds' | 'dismissedPresetProviderIds' | 'dismissedCodexCliPrompts' | 'favoriteCollections' | 'defaultFavoriteCollectionId'
> & {
  agentConversations: AgentConversation[]
}

export type NormalizedPersistedAppState = PersistedAppState & {
  previousPresetConfig: Pick<AppSettings, 'customProviders' | 'profiles'> | null
  dismissedPresetProfileIds: string[]
  dismissedPresetProviderIds: string[]
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  agentConversations: AgentConversation[]
}

export interface PersistedStateMergePlan {
  state: NormalizedPersistedAppState
  hasLegacyAgentConversations: boolean
  shouldMigrateAgentConversations: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function normalizeStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeParams(value: unknown, fallback: TaskParams): TaskParams {
  if (!isRecord(value)) return fallback
  return {
    size: typeof value.size === 'string' ? value.size : fallback.size,
    quality: value.quality === 'auto' || value.quality === 'low' || value.quality === 'medium' || value.quality === 'high' ? value.quality : fallback.quality,
    output_format: value.output_format === 'png' || value.output_format === 'jpeg' || value.output_format === 'webp' ? value.output_format : fallback.output_format,
    output_compression: value.output_compression === null || (typeof value.output_compression === 'number' && Number.isFinite(value.output_compression))
      ? value.output_compression
      : fallback.output_compression,
    moderation: value.moderation === 'auto' || value.moderation === 'low' ? value.moderation : fallback.moderation,
    n: typeof value.n === 'number' && Number.isFinite(value.n) ? value.n : fallback.n,
    transparent_output: typeof value.transparent_output === 'boolean' ? value.transparent_output : fallback.transparent_output,
  }
}

export function createPersistedState(state: PersistedStateSource, includeLegacyAgentConversations = false): PersistedAppState {
  const settings = normalizeSettings(state.settings)
  const galleryInputDraft = saveGalleryInputDraft(state)
  return {
    settings,
    previousPresetConfig: state.previousPresetConfig ?? null,
    dismissedPresetProfileIds: state.dismissedPresetProfileIds ?? [],
    dismissedPresetProviderIds: state.dismissedPresetProviderIds ?? [],
    params: state.params,
    ...(settings.persistInputOnRestart && (state.appMode === 'gallery' || galleryInputDraft)
      ? {
          prompt: galleryInputDraft?.prompt ?? '',
          inputImages: galleryInputDraft?.inputImages.map((img) => ({ id: img.id, dataUrl: '' })) ?? [],
        }
      : {}),
    dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
    appMode: state.appMode,
    galleryInputDraft: settings.persistInputOnRestart && galleryInputDraft
      ? { ...galleryInputDraft, inputImages: galleryInputDraft.inputImages.map((img) => ({ id: img.id, dataUrl: '' })) }
      : null,
    ...(includeLegacyAgentConversations
      ? { agentConversations: getPersistableAgentConversations(state.agentConversations) }
      : {}),
    activeAgentConversationId: state.activeAgentConversationId,
    agentInputDrafts: settings.persistInputOnRestart ? getPersistableAgentInputDrafts(state) : {},
    agentSidebarCollapsed: state.agentSidebarCollapsed,
    agentAssetTab: state.agentAssetTab,
    agentAssetPanelCollapsed: state.agentAssetPanelCollapsed,
    favoriteCollections: state.favoriteCollections,
    defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
    supportPromptDismissed: state.supportPromptDismissed,
    supportPromptOpen: state.supportPromptOpen,
    supportPromptSkippedForImportedData: state.supportPromptSkippedForImportedData,
  }
}

export function migratePersistedState(persistedState: unknown, _version?: number): unknown {
  if (!isRecord(persistedState)) return persistedState
  return {
    ...persistedState,
    agentConversations: stripPersistedAgentConversations(persistedState.agentConversations),
  }
}

export function normalizePersistedState(
  persistedState: unknown,
  fallback: PersistedStateFallback,
  now = Date.now(),
): PersistedStateMergePlan | null {
  if (!isRecord(persistedState)) return null

  const settings = normalizeSettings(persistedState.settings ?? fallback.settings)
  const previousPresetConfig = isRecord(persistedState.previousPresetConfig) && Array.isArray(persistedState.previousPresetConfig.profiles)
    ? (() => {
        const normalized = normalizeSettings(persistedState.previousPresetConfig)
        return {
          customProviders: normalized.customProviders,
          profiles: persistedState.previousPresetConfig.profiles.length ? normalized.profiles : [],
        }
      })()
    : null
  const hasLegacyAgentConversations = Array.isArray(persistedState.agentConversations)
  const agentConversations = hasLegacyAgentConversations
    ? normalizeAgentConversations(persistedState.agentConversations)
    : fallback.agentConversations
  const activeAgentConversationId = typeof persistedState.activeAgentConversationId === 'string' && (
    !hasLegacyAgentConversations || agentConversations.some((conversation) => conversation.id === persistedState.activeAgentConversationId)
  )
    ? persistedState.activeAgentConversationId
    : agentConversations[0]?.id ?? null
  const appMode = persistedState.appMode === 'agent' ? 'agent' : 'gallery'
  const galleryInputDraft = settings.persistInputOnRestart
    ? normalizeAgentInputDraft(persistedState.galleryInputDraft ?? {
        prompt: persistedState.prompt,
        inputImages: persistedState.inputImages,
        maskDraft: null,
        maskEditorImageId: null,
      }, now)
    : null
  const normalizedAgentInputDrafts = !settings.persistInputOnRestart
    ? {}
    : hasLegacyAgentConversations
      ? normalizeAgentInputDrafts(persistedState.agentInputDrafts, agentConversations)
      : normalizeAgentInputDraftsByKey(persistedState.agentInputDrafts)
  const cleanedAgentInputDrafts = cleanStaleAgentInputDrafts(normalizedAgentInputDrafts, activeAgentConversationId, now)
  const agentInputDrafts = appMode === 'agent' && activeAgentConversationId && !cleanedAgentInputDrafts[activeAgentConversationId] && settings.persistInputOnRestart && typeof persistedState.prompt === 'string'
    ? {
        ...cleanedAgentInputDrafts,
        [activeAgentConversationId]: normalizeAgentInputDraft({
          prompt: persistedState.prompt,
          inputImages: persistedState.inputImages,
          maskDraft: null,
          maskEditorImageId: null,
        }, now),
      }
    : cleanedAgentInputDrafts
  const restoredAgentDraft = settings.persistInputOnRestart && appMode === 'agent' && activeAgentConversationId
    ? agentInputDrafts[activeAgentConversationId] ?? null
    : null
  const favoriteCollections = Array.isArray(persistedState.favoriteCollections)
    ? ensureDefaultFavoriteCollection(normalizeFavoriteCollections(persistedState.favoriteCollections, now), now)
    : fallback.favoriteCollections
  const preferredDefaultFavoriteCollectionId = persistedState.defaultFavoriteCollectionId === null || typeof persistedState.defaultFavoriteCollectionId === 'string'
    ? persistedState.defaultFavoriteCollectionId
    : fallback.defaultFavoriteCollectionId

  return {
    state: {
      settings,
      previousPresetConfig,
      dismissedPresetProfileIds: normalizeStringArray(persistedState.dismissedPresetProfileIds, fallback.dismissedPresetProfileIds ?? []),
      dismissedPresetProviderIds: normalizeStringArray(persistedState.dismissedPresetProviderIds, fallback.dismissedPresetProviderIds ?? []),
      params: normalizeParams(persistedState.params, fallback.params),
      dismissedCodexCliPrompts: normalizeStringArray(persistedState.dismissedCodexCliPrompts, fallback.dismissedCodexCliPrompts),
      appMode,
      galleryInputDraft: galleryInputDraft && !isEmptyAgentInputDraft(galleryInputDraft) ? galleryInputDraft : null,
      agentConversations,
      activeAgentConversationId,
      agentInputDrafts,
      agentSidebarCollapsed: Boolean(persistedState.agentSidebarCollapsed),
      agentAssetTab: persistedState.agentAssetTab === 'references' ? 'references' : 'outputs',
      agentAssetPanelCollapsed: Boolean(persistedState.agentAssetPanelCollapsed),
      favoriteCollections,
      defaultFavoriteCollectionId: resolveDefaultFavoriteCollectionId(favoriteCollections, preferredDefaultFavoriteCollectionId),
      supportPromptDismissed: Boolean(persistedState.supportPromptDismissed),
      supportPromptOpen: Boolean(persistedState.supportPromptOpen),
      supportPromptSkippedForImportedData: Boolean(persistedState.supportPromptSkippedForImportedData),
      prompt: restoredAgentDraft ? restoredAgentDraft.prompt : galleryInputDraft?.prompt ?? '',
      inputImages: restoredAgentDraft ? restoredAgentDraft.inputImages : galleryInputDraft?.inputImages ?? [],
      maskDraft: restoredAgentDraft ? restoredAgentDraft.maskDraft : galleryInputDraft?.maskDraft ?? null,
      maskEditorImageId: restoredAgentDraft ? restoredAgentDraft.maskEditorImageId : galleryInputDraft?.maskEditorImageId ?? null,
    },
    hasLegacyAgentConversations,
    shouldMigrateAgentConversations: hasLegacyAgentConversations && agentConversations.length > 0,
  }
}

export function mergePersistedAgentConversations(stored: AgentConversation[], legacy: AgentConversation[]) {
  const merged = new Map<string, AgentConversation>()
  for (const conversation of stored) merged.set(conversation.id, conversation)
  for (const conversation of legacy) {
    const existing = merged.get(conversation.id)
    if (!existing || conversation.updatedAt >= existing.updatedAt) merged.set(conversation.id, conversation)
  }
  return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt)
}
