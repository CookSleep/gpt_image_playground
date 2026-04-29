import { getActiveApiProfile } from '../types'
import { callFalImageApi } from './falImageApi'
import { callOaiLikeImageApi } from './oaiImageApi'
import type { CallApiOptions, CallApiResult } from './apiShared'

export type { CallApiOptions, CallApiResult } from './apiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  if (profile.provider === 'fal') return callFalImageApi(opts, profile)

  return callOaiLikeImageApi(opts, profile)
}
