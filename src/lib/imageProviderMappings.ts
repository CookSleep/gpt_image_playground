import type { CustomProviderDefinition } from '../types'

/** Images 兼容接口的任务 ID 与 /tasks/{task_id} 查询协议 */
export const OPENAI_IMAGE_TASK_PROVIDER: CustomProviderDefinition = {
  id: 'openai',
  name: 'OpenAI Images 异步任务',
  submit: { path: 'images/generations', taskIdPath: 'data.0.task_id' },
  poll: {
    path: 'tasks/{task_id}',
    intervalSeconds: 4,
    statusPath: 'data.status',
    successValues: ['completed'],
    failureValues: ['failed', 'cancelled'],
    errorPath: 'data.error.message',
    result: { imageUrlPaths: ['data.result.images.*.url'] },
  },
}

export function resolveCustomProviderModel(provider: CustomProviderDefinition, model: string): CustomProviderDefinition {
  const override = provider.modelOverrides?.find((item) => item.models.some((pattern) => {
    const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp(`^${escaped}$`, 'i').test(model)
  }))
  return override ? { ...provider, submit: override.submit, editSubmit: override.editSubmit, poll: override.poll ?? provider.poll } : provider
}
