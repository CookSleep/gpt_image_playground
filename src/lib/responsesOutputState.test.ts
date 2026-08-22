import { describe, expect, it } from 'vitest'
import { normalizeResponsesOutputItems } from './responsesOutputState'

describe('Responses output normalization', () => {
  it('normalizes known item fields and preserves unknown typed items', () => {
    const normalized = normalizeResponsesOutputItems([
      { type: 'message', content: 'invalid' },
      {
        type: 'message',
        id: 123,
        content: [
          null,
          [],
          { type: 'output_text', text: 123 },
          { type: '', text: 'invalid' },
          {
            type: 'output_text',
            text: '安全文本',
            annotations: [null, { type: 'url_citation', url: 'https://example.com', start_index: 0, end_index: 4 }],
          },
          { type: 'refusal', refusal: '无法协助' },
          { type: 'refusal', refusal: 123 },
          { type: 'future_content_part', payload: { enabled: true } },
        ],
      },
      { type: 'function_call', call_id: 'missing-name', arguments: '{}' },
      { type: 'function_call', call_id: 'bad-arguments', name: 'tool', arguments: {} },
      { type: 'function_call', call_id: 'paired', name: 'tool', arguments: '{}' },
      { type: 'function_call_output', call_id: 'missing-output' },
      { type: 'function_call_output', call_id: 'paired', output: '{}' },
      { type: 'function_call_output', call_id: 'content-output', output: [
        { type: 'input_text', text: '工具文本' },
        { type: 'input_text', text: 123 },
        { type: 'input_image', image_url: 'data:image/png;base64,a', detail: 123 },
        { type: 'input_image', file_id: 'file-image' },
        { type: 'input_image' },
        { type: 'input_file', file_data: 'data:file', filename: 'file.txt' },
        { type: 'input_file', filename: 'missing-source.txt' },
        { type: 'future_input_part', payload: true },
      ] },
      { type: 'image_generation_call', id: 123, action: [], result: { base64: 123, detail: 'keep' } },
      { type: 'image_generation_call', id: 'pending-image', result: null },
      { type: 'web_search_call', status: 123, action: { type: 'search' } },
      { type: 'future_response_item', payload: { enabled: true } },
    ])

    expect(normalized).toEqual([
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: '安全文本',
          annotations: [{ type: 'url_citation', url: 'https://example.com', start_index: 0, end_index: 4 }],
        },
        { type: 'refusal', refusal: '无法协助' },
        { type: 'future_content_part', payload: { enabled: true } },
        ],
      },
      { type: 'function_call', call_id: 'paired', name: 'tool', arguments: '{}' },
      { type: 'function_call_output', call_id: 'paired', output: '{}' },
      { type: 'function_call_output', call_id: 'content-output', output: [
        { type: 'input_text', text: '工具文本' },
        { type: 'input_image', image_url: 'data:image/png;base64,a' },
        { type: 'input_image', file_id: 'file-image' },
        { type: 'input_file', file_data: 'data:file', filename: 'file.txt' },
        { type: 'future_input_part', payload: true },
      ] },
      { type: 'image_generation_call', result: { detail: 'keep' } },
      { type: 'image_generation_call', id: 'pending-image', result: null },
      { type: 'web_search_call', action: { type: 'search' } },
      { type: 'future_response_item', payload: { enabled: true } },
    ])
  })
})
