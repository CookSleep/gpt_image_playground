import type { ApiProfile, AppMode, AppSettings } from '../types'
import { isAgentTextApiProfile, splitModelList } from './apiProfiles'

export function getModelPickerOptions(settings: AppSettings, activeProfile: ApiProfile, appMode: AppMode) {
  const profiles = settings.profiles.filter((profile) => profile.id === activeProfile.id || (
    profile.showInModelPicker && (appMode !== 'agent' || settings.agentApiConfigMode === 'hybrid' || isAgentTextApiProfile(profile))
  ))
  return profiles.flatMap((profile) => splitModelList(profile.model).map((model) => ({
    label: profiles.length > 1 ? `${profile.name} · ${model}` : model,
    value: JSON.stringify([profile.id, model]),
    profileId: profile.id,
    model,
  })))
}

export function getModelPickerSettingsPatch(settings: AppSettings, profileId: string, model: string, appMode: AppMode): Partial<AppSettings> {
  return {
    profiles: settings.profiles.map((profile) => profile.id === profileId ? { ...profile, selectedModel: model } : profile),
    ...(appMode !== 'agent' || settings.agentApiConfigMode === 'off'
      ? { activeProfileId: profileId }
      : settings.agentApiConfigMode === 'hybrid'
      ? { agentImageProfileId: profileId }
      : { agentTextProfileId: profileId }),
  }
}
