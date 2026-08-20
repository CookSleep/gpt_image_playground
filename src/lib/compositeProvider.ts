import type { CustomProviderDefinition } from '../types'

/** composite 图生图/编辑接口的自定义服务商配置；文生图提交接口待接入后再替换 submit。 */
export const COMPOSITE_IMAGE_EDIT_PROVIDER: CustomProviderDefinition = {
  id: 'composite',
  name: 'Composite 图像编辑',
  template: 'http-image',
  editOnly: true,
  submit: {
    path: 'model/{model}/edit',
    method: 'POST',
    contentType: 'json',
    body: {
      platform: 'composite',
      prompt: '$prompt',
      image_urls: '$inputImages.dataUrls',
      image_size: '$params.image_size',
      quality: '$params.quality',
      num_images: '$params.n',
      output_format: '$params.output_format',
    },
    taskIdPath: 'request_id',
  },
  editSubmit: {
    path: 'model/{model}/edit',
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
    path: 'model/{model}/edit/requests/{task_id}/status',
    method: 'GET',
    intervalSeconds: 2,
    maxIntervalSeconds: 15,
    timeoutSeconds: 600,
    maxRetries: 3,
    statusPath: 'status',
    successValues: ['COMPLETED'],
    failureValues: ['FAILED', 'CANCELED'],
    errorPath: 'error.message',
    resultPath: 'model/{model}/edit/requests/{task_id}',
    resultMethod: 'GET',
    result: {
      imageUrlPaths: ['images.*.url'],
    },
  },
}
