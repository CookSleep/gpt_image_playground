import type { CustomProviderDefinition } from '../types'

/** Composite 文生图与图片编辑接口的自定义服务商配置。 */
export const COMPOSITE_IMAGE_EDIT_PROVIDER: CustomProviderDefinition = {
  id: 'composite',
  name: 'Composite 图像生成',
  template: 'http-image',
  submit: {
    path: 'model/{model}',
    method: 'POST',
    contentType: 'json',
    body: {
      prompt: '$prompt',
      image_size: '$params.image_size',
      quality: '$params.quality',
      num_images: '$params.n',
      output_format: '$params.output_format',
    },
    taskIdPath: 'request_id',
  },
  editSubmit: {
    path: 'model/{model}',
    method: 'POST',
    contentType: 'json',
    body: {
      platform: 'composite',
      prompt: '$prompt',
      image_urls: '$inputImages.dataUrls',
      mask_url: '$mask.dataUrl',
      image_size: '$params.image_size',
      quality: '$params.quality',
      num_images: '$params.n',
      output_format: '$params.output_format',
    },
    taskIdPath: 'request_id',
  },
  poll: {
    path: 'model/{model}/requests/{task_id}',
    method: 'GET',
    intervalSeconds: 2,
    maxIntervalSeconds: 15,
    timeoutSeconds: 600,
    maxRetries: 3,
    statusPath: 'status',
    successValues: ['COMPLETED'],
    failureValues: ['FAILED', 'CANCELED'],
    pendingValues: ['IN_QUEUE', 'IN_PROGRESS'],
    errorPath: 'error.message',
    result: {
      imageUrlPaths: ['images.*.url'],
    },
  },
  editPoll: {
    path: 'model/{model}/requests/{task_id}',
    method: 'GET',
    intervalSeconds: 2,
    maxIntervalSeconds: 15,
    timeoutSeconds: 600,
    maxRetries: 3,
    statusPath: 'status',
    successValues: ['COMPLETED'],
    failureValues: ['FAILED', 'CANCELED'],
    pendingValues: ['IN_QUEUE', 'IN_PROGRESS'],
    errorPath: 'error.message',
    result: {
      imageUrlPaths: ['images.*.url'],
    },
  },
}
