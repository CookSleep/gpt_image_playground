import type { ApiProfile, CustomProviderDefinition, TaskParams } from '../types'
import { getImageModelFamily } from './imageModels'
import { resolveCustomProviderModel } from './imageProviderMappings'

export function getImageRequestExecution(
  profile: ApiProfile,
  params: Pick<TaskParams, 'n' | 'output_format'>,
  hasInputImages: boolean,
  definition?: CustomProviderDefinition | null,
) {
  const family = getImageModelFamily(profile)
  const customProvider = definition ? resolveCustomProviderModel(definition, profile.model) : null
  const submit = hasInputImages ? customProvider?.editSubmit ?? customProvider?.submit : customProvider?.submit
  const isAsyncCustom = Boolean(submit?.taskIdPath)
  // 自定义渠道以请求模板和异步协议为准。
  const split = customProvider
    ? !isAsyncCustom && (profile.codexCli || params.output_format === 'svg')
    : profile.provider !== 'fal' && (
      profile.provider === 'google' || profile.provider === 'bytedance'
      || (!family && (profile.apiMode === 'responses' || profile.codexCli || params.output_format === 'svg'
        || (profile.streamImages && params.output_format !== 'gif')))
    )
  return { customProvider, isAsyncCustom, concurrent: params.n > 1 && split }
}
