import { afterEach, expect, it, vi } from 'vitest'
import { getActiveApiProfile, normalizeCustomProviderDefinition } from './apiProfiles'
import { fetchProviderModels } from './providerModels'

const profile = { ...getActiveApiProfile({}), baseUrl: 'https://example.com', apiKey: 'example' }
const signal = new AbortController().signal

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['openai', '/v1/models'],
  ['sb2api-async', '/v1/models'],
  ['bytedance', '/v3/models'],
  ['xai', '/v1/image-generation-models'],
])('%s 从当前地址读取模型 ID 并按顺序去重', async (provider, path) => {
  const rows = [{ id: 'b' }, { id: 'a' }, { id: 'b' }]
  const fetch = vi.fn().mockResolvedValue(Response.json(provider === 'xai' ? { models: rows } : { data: rows }))
  vi.stubGlobal('fetch', fetch)
  expect(await fetchProviderModels({ ...profile, provider }, false, signal)).toEqual(['b', 'a'])
  expect(fetch).toHaveBeenCalledWith(profile.baseUrl + path, expect.objectContaining({ headers: { Authorization: 'Bearer example' }, signal }))
})

it('自定义服务商没有有效的模型列表映射时不发请求', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const custom = normalizeCustomProviderDefinition({ id: 'custom-example', submit: {}, modelList: { path: ' ' } })!
  await expect(fetchProviderModels({ ...profile, provider: custom.id }, false, signal, custom.modelList)).rejects.toThrow('尚未配置模型列表映射')
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  { mapping: { path: '/v1/catalog', listPath: 'result.items', idPath: 'model.name' }, page: { result: { items: [{ model: { name: 'b' } }, { model: { name: 'a' } }, { model: { name: 'b' } }] } } },
  { mapping: { path: 'catalog' }, page: ['b', 'a', 'b'] },
])('自定义服务商按映射的地址和响应字段拉取模型', async ({ mapping, page }) => {
  const custom = normalizeCustomProviderDefinition({ id: 'custom-example', submit: {}, modelList: mapping })!
  const fetch = vi.fn().mockResolvedValue(Response.json(page))
  vi.stubGlobal('fetch', fetch)
  expect(await fetchProviderModels({ ...profile, provider: custom.id }, false, signal, custom.modelList)).toEqual(['b', 'a'])
  expect(fetch.mock.calls[0][0]).toBe(profile.baseUrl + '/v1/catalog')
})

it('区分空列表与 idPath 无法读取的非空列表', async () => {
  const mapping = { path: 'models', listPath: 'data', idPath: 'name' }
  const custom = { ...profile, provider: 'custom-example' }
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ data: [] }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'a' }] })))
  expect(await fetchProviderModels(custom, false, signal, mapping)).toEqual([])
  await expect(fetchProviderModels(custom, false, signal, mapping)).rejects.toThrow('idPath')
})

it('自定义游标分页保留查询参数，跨页去重并按顺序返回', async () => {
  const custom = normalizeCustomProviderDefinition({
    id: 'custom-example', submit: {},
    modelList: { path: 'catalog?limit=2', listPath: 'items', nextCursorPath: 'meta.next', cursorParam: 'after' },
  })!
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ items: ['b'], meta: { next: 'a+b' } }))
    .mockResolvedValueOnce(Response.json({ items: ['b'], meta: { next: 2 } }))
    .mockResolvedValueOnce(Response.json({ items: ['a'], meta: { next: null } }))
  vi.stubGlobal('fetch', fetch)
  expect(await fetchProviderModels({ ...profile, provider: custom.id }, false, signal, custom.modelList)).toEqual(['b', 'a'])
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    profile.baseUrl + '/v1/catalog?limit=2',
    profile.baseUrl + '/v1/catalog?limit=2&after=a%2Bb',
    profile.baseUrl + '/v1/catalog?limit=2&after=2',
  ])
})

it('自定义分页映射不完整或返回重复游标时报告错误', async () => {
  const custom = { ...profile, provider: 'custom-example' }
  const mapping = { path: 'models', listPath: 'data', nextCursorPath: 'next' }
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ data: ['a'], next: 'same' })))
  vi.stubGlobal('fetch', fetch)
  await expect(fetchProviderModels(custom, false, signal, mapping)).rejects.toThrow('cursorParam')
  expect(fetch).not.toHaveBeenCalled()
  await expect(fetchProviderModels(custom, false, signal, { ...mapping, cursorParam: 'cursor' })).rejects.toThrow('游标重复')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('Google 沿用 API Key 并翻页，去掉资源名前缀', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ models: [{ name: 'models/a' }], nextPageToken: 'a+b' }))
    .mockResolvedValueOnce(Response.json({ models: [{ name: 'models/b' }] }))
  vi.stubGlobal('fetch', fetch)
  expect(await fetchProviderModels({ ...profile, provider: 'google' }, false, signal)).toEqual(['a', 'b'])
  expect(fetch.mock.calls[1]).toEqual(['https://example.com/v1beta/models?pageSize=1000&pageToken=a%2Bb', expect.objectContaining({ headers: { 'x-goog-api-key': 'example' } })])
})

it('fal.ai 代理逐页转发平台目录地址', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ models: [{ endpoint_id: 'fal-ai/a' }], next_cursor: 'next' }))
    .mockResolvedValueOnce(Response.json({ models: [{ endpoint_id: 'fal-ai/b' }] }))
  vi.stubGlobal('fetch', fetch)
  expect(await fetchProviderModels({ ...profile, provider: 'fal' }, false, signal)).toEqual(['fal-ai/a', 'fal-ai/b'])
  expect(fetch.mock.calls[1]).toEqual([profile.baseUrl, expect.objectContaining({ headers: {
    Authorization: 'Key example', 'x-fal-target-url': 'https://api.fal.ai/v1/models?limit=50&cursor=next',
  } })])
})

it('启用部署代理时通过同源地址获取模型', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ data: [] }))
  vi.stubGlobal('fetch', fetch)
  await fetchProviderModels({ ...profile, baseUrl: '' }, true, signal)
  expect(fetch.mock.calls[0][0]).toBe('/api-proxy/models')
})
