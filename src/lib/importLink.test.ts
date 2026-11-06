import { afterEach, describe, expect, it, vi } from 'vitest'

import { describeImportLink, getProfileImportBaseUrl, parseImportLink } from './importLink'
import { createCustomProfileImportUrl } from './profileImportUrl'
import { createDefaultOpenAIProfile, DEFAULT_OPENAI_PROFILE_ID, normalizeSettings } from './apiProfiles'
import { setPresetConfig } from './presetConfig'
import { buildApiUrl } from './devProxy'
import { buildSettingsFromUrlParams } from './urlSettings'

const settingsLink = (value: unknown) => `https://example.com/app/?settings=${encodeURIComponent(JSON.stringify(value))}`

describe('parseImportLink', () => {
  it('识别任意域名的网页版导入链接', () => {
    expect(parseImportLink('https://gpt-image-playground.cooksleep.dev?apiUrl=https://api.example.com/v1&apiKey=sk-1&model=gpt-image-2')?.get('apiKey')).toBe('sk-1')
    expect(parseImportLink('  http://my-host:8080/?apiUrl=http%3A%2F%2F10.0.0.1%2Fv1\n')).not.toBeNull()
    expect(parseImportLink(settingsLink({ profiles: [{ name: 'A', provider: 'openai', baseUrl: 'https://a.example.com' }] }))).not.toBeNull()
    expect(parseImportLink(settingsLink({ settings: { profiles: [{ name: 'A' }] } }))).not.toBeNull()
  })

  it('识别 deep link', () => {
    expect(parseImportLink('gpt-image-playground://?apiUrl={address}&apiKey={key}&model={model}')?.get('model')).toBe('{model}')
    expect(parseImportLink('gpt-image-playground://?apiKey=sk-1')).not.toBeNull()
    expect(parseImportLink('gpt-image-playground://')).toBeNull()
    expect(parseImportLink('gpt-image-playground://?foo=bar')).toBeNull()
  })

  it('普通网址和文本不视为导入链接', () => {
    for (const text of [
      '',
      'hello',
      'https://example.com/',
      'https://www.google.com/search?q=apiUrl',
      'https://example.com/?model=gpt-4',
      'https://example.com/?apiKey=sk-1',
      'https://example.com/?apiUrl={address}&apiKey={key}',
      'https://example.com/?apiUrl=not-a-url',
      'https://example.com/?settings=abc',
      settingsLink({ profiles: [] }),
      settingsLink([1, 2]),
      'ftp://example.com/?apiUrl=https://api.example.com',
      'other-app://?apiUrl=https://api.example.com',
      '请打开 https://example.com/?apiUrl=https://api.example.com/v1',
      'https://example.com/?apiUrl=https://a.example.com https://b.example.com',
    ]) {
      expect(parseImportLink(text), text).toBeNull()
    }
  })
})

describe('describeImportLink', () => {
  const current = () => {
    const settings = normalizeSettings({})
    return normalizeSettings({
      ...settings,
      profiles: settings.profiles.map((profile) => profile.id === DEFAULT_OPENAI_PROFILE_ID
        ? { ...profile, name: '默认配置', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-saved' }
        : profile),
    })
  }
  const row = (desc: ReturnType<typeof describeImportLink>, title: string, label: string) =>
    desc.groups.find((group) => group.title === title)?.rows.find((item) => item.label === label)
  // 汇总确认框中的全部展示文本，用于断言某段内容是否出现
  const allText = (desc: ReturnType<typeof describeImportLink>) => JSON.stringify(desc)

  it('新增配置时列出内容，不显示 API Key 明文', () => {
    const params = parseImportLink('gpt-image-playground://?apiUrl=https://api.example.com/v1&apiKey=sk-secret&model=gpt-image-2&profileName=我的配置')!
    const desc = describeImportLink(params, current())
    const title = '新增配置「我的配置」'
    expect(desc.summary).toBe('请只导入来源可信的链接。')
    expect(row(desc, title, 'API 地址')).toEqual({ label: 'API 地址', after: { text: 'https://api.example.com/v1' } })
    expect(row(desc, title, '模型')).toEqual({ label: '模型', after: { text: 'gpt-image-2' } })
    expect(row(desc, title, 'API Key')).toEqual({ label: 'API Key', after: { text: '链接中的 Key', hint: true } })
    expect(allText(desc)).not.toContain('sk-secret')
  })

  it('新增配置未包含 Key 时如实说明', () => {
    const desc = describeImportLink(new URLSearchParams({ apiUrl: 'https://a.example.com/v1', profileName: 'A' }), current())
    expect(row(desc, '新增配置「A」', 'API Key')).toEqual({ label: 'API Key', note: '链接中未包含 API Key' })
  })

  it('修改已有配置时明确提示会继续使用已保存的 Key', () => {
    const params = new URLSearchParams({ profileId: DEFAULT_OPENAI_PROFILE_ID, apiUrl: 'https://evil.example.com/v1' })
    const desc = describeImportLink(params, current())
    const title = '修改配置「默认配置」'
    expect(desc.summary).toBe('请只导入来源可信的链接。')
    expect(desc.groups.find((group) => group.title === title)?.keyReuse).toBe(true)
    expect(row(desc, title, 'API 地址')).toEqual({ label: 'API 地址', before: { text: 'https://api.openai.com/v1' }, after: { text: 'https://evil.example.com/v1' } })
    expect(row(desc, title, 'API Key')?.note).toContain('将继续使用该配置已保存的 API Key')
    expect(allText(desc)).not.toContain('未包含')
    expect(allText(desc)).not.toContain('sk-saved')
  })

  it('替换已保存的 Key 时只说明来源，不显示原文', () => {
    const desc = describeImportLink(new URLSearchParams({ profileId: DEFAULT_OPENAI_PROFILE_ID, apiKey: 'sk-new' }), current())
    expect(row(desc, '修改配置「默认配置」', 'API Key')).toEqual({ label: 'API Key', before: { text: '已保存的 Key', hint: true }, after: { text: '链接中的 Key', hint: true } })
    expect(desc.groups[0].keyReuse).toBeUndefined()
    expect(allText(desc)).not.toContain('sk-new')
    expect(allText(desc)).not.toContain('sk-saved')
  })

  it('API 地址完整显示主机名', () => {
    const host = `${'a'.repeat(120)}.trusted.com.evil.example`
    const desc = describeImportLink(new URLSearchParams({ apiUrl: `https://${host}/${'p'.repeat(200)}` }), current())
    expect(desc.groups[0].rows[0].after?.text).toContain(`https://${host}/`)
    expect(allText(desc)).not.toContain('p'.repeat(100))
  })

  it('展示值中的换行会被折叠，无法伪造确认框中的行', () => {
    const desc = describeImportLink(new URLSearchParams({ apiUrl: 'https://a.example.com/v1', profileName: 'A\nAPI Key：未包含\r\n模型：x' }), current())
    expect(desc.groups.map((group) => group.title)).toEqual(['新增配置「A API Key：未包含 模型：x」'])
    expect(desc.groups[0].rows.map((item) => item.label)).toEqual(['API 地址', '模型', 'API Key'])
    // 任何展示文本中都不再含有换行、回车或 Tab
    expect(allText(desc)).not.toMatch(/\\[nrt]/)
  })

  it('新增配置较多时也全部列出', () => {
    const profiles = Array.from({ length: 5 }, (_, idx) => ({ name: `P${idx}`, provider: 'openai', baseUrl: `https://p${idx}.example.com/v1`, model: `m${idx}` }))
    const desc = describeImportLink(parseImportLink(settingsLink({ profiles }))!, current())
    expect(desc.summary).toBe('链接将新增 5 个配置。请只导入来源可信的链接。')
    expect(desc.groups.map((group) => group.title)).toEqual(['新增配置「P0」', '新增配置「P1」', '新增配置「P2」', '新增配置「P3」', '新增配置「P4」'])
  })

  it('名称或值为空时显示占位，不出现空的「」', () => {
    const desc = describeImportLink(parseImportLink(settingsLink({ profiles: [{ name: ' ', provider: 'openai', baseUrl: 'https://a.example.com/v1', model: '' }] }))!, current())
    expect(desc.groups[0].title).not.toContain('「」')
    expect(row(desc, desc.groups[0].title, '模型')?.after?.text).toBeTruthy()
  })

  it('不带协议头的地址按实际请求补全后完整显示主机名', () => {
    const host = `api.openai.com.${'a'.repeat(90)}.evil.com`
    const desc = describeImportLink(parseImportLink(settingsLink({ profiles: [{ name: 'X', provider: 'openai', baseUrl: `${host}/v1` }] }))!, current())
    expect(row(desc, '新增配置「X」', 'API 地址')?.after).toEqual({ text: `https://${host}/v1` })
  })

  it('主机名中的 Tab 和换行不会让预览与实际请求的主机不一致', () => {
    for (const ch of ['\t', '\n', '\r']) {
      const baseUrl = `https://api.openai.com${ch}.evil.com/v1`
      const desc = describeImportLink(parseImportLink(settingsLink({ profiles: [{ name: 'X', provider: 'openai', baseUrl }] }))!, current())
      const actualHost = new URL(buildApiUrl(baseUrl, 'images/generations')).host
      expect(actualHost).toBe('api.openai.com.evil.com')
      expect(row(desc, '新增配置「X」', 'API 地址')?.after).toEqual({ text: `https://${actualHost}/v1` })
      expect(allText(desc)).not.toContain('api.openai.com .evil.com')
    }
  })

  it('无法解析的地址不截断', () => {
    const raw = `http://[${'b'.repeat(120)}`
    const desc = describeImportLink(parseImportLink(settingsLink({ profiles: [{ name: 'X', provider: 'openai', baseUrl: raw }] }))!, current())
    expect(row(desc, '新增配置「X」', 'API 地址')?.after).toEqual({ text: raw })
  })

  it('修改项全部列出，改了地址的排在最前', () => {
    const base = current()
    const settings = normalizeSettings({
      ...base,
      profiles: [
        ...base.profiles,
        ...Array.from({ length: 4 }, (_, idx) => ({ ...createDefaultOpenAIProfile(), id: `p${idx}`, name: `P${idx}`, baseUrl: `https://p${idx}.example.com/v1`, model: `m${idx}` })),
      ],
    })
    const profiles = [0, 1, 2, 3].map((idx) => ({ id: `p${idx}`, name: `P${idx}`, provider: 'openai', baseUrl: idx === 3 ? 'https://evil.example.com/v1' : `https://p${idx}.example.com/v1`, model: `new${idx}` }))
    const desc = describeImportLink(parseImportLink(settingsLink({ profiles }))!, settings)
    const titles = desc.groups.map((group) => group.title)
    for (const idx of [0, 1, 2, 3]) expect(titles).toContain(`修改配置「P${idx}」`)
    expect(titles.indexOf('修改配置「P3」')).toBeLessThan(titles.indexOf('修改配置「P0」'))
    expect(row(desc, '修改配置「P0」', '模型')).toEqual({ label: '模型', before: { text: 'm0' }, after: { text: 'new0' } })
  })

  it('同时修改和新增时摘要写出两类数量和总数', () => {
    const base = current()
    const settings = normalizeSettings({
      ...base,
      profiles: [...base.profiles, { ...createDefaultOpenAIProfile(), id: 'p0', name: 'P0', baseUrl: 'https://p0.example.com/v1', model: 'm0' }],
    })
    const profiles = [
      { id: 'p0', name: 'P0', provider: 'openai', baseUrl: 'https://p0.example.com/v1', model: 'new0' },
      { name: 'N1', provider: 'openai', baseUrl: 'https://n1.example.com/v1' },
      { name: 'N2', provider: 'openai', baseUrl: 'https://n2.example.com/v1' },
    ]
    const desc = describeImportLink(parseImportLink(settingsLink({ profiles }))!, settings)
    expect(desc.summary).toBe('链接将修改 1 个、新增 2 个配置，共 3 个。请只导入来源可信的链接。')
  })

  it('链接指向已删除的预置配置时预览会先恢复它', () => {
    const preset = { ...createDefaultOpenAIProfile(), id: 'preset-a', name: '预置 A', baseUrl: 'https://preset.example.com/v1', apiKey: 'sk-preset' }
    setPresetConfig({ customProviders: [], profiles: [preset] })
    try {
      const desc = describeImportLink(new URLSearchParams({ profileId: 'preset-a', apiUrl: 'https://evil.example.com/v1' }), current())
      const title = '修改配置「预置 A」'
      expect(desc.notes).toEqual(['将恢复预置配置：预置 A'])
      expect(row(desc, title, 'API 地址')).toEqual({ label: 'API 地址', before: { text: 'https://preset.example.com/v1' }, after: { text: 'https://evil.example.com/v1' } })
      expect(row(desc, title, 'API Key')?.note).toContain('将继续使用该配置已保存的 API Key')
      expect(desc.groups.find((group) => group.title === title)?.keyReuse).toBe(true)
      expect(allText(desc)).not.toContain('sk-preset')
    } finally {
      setPresetConfig(null)
    }
  })

  it('只恢复预置配置时摘要据实说明', () => {
    const preset = { ...createDefaultOpenAIProfile(), id: 'preset-a', name: '预置 A', baseUrl: 'https://preset.example.com/v1' }
    setPresetConfig({ customProviders: [], profiles: [preset] })
    try {
      const desc = describeImportLink(new URLSearchParams({ profileId: 'preset-a' }), current())
      expect(desc.summary).toBe('链接将恢复已删除的预置配置。')
      expect(desc.hasConfigChanges).toBe(true)
      expect(desc.notes).toEqual(['将恢复预置配置：预置 A'])
      expect(desc.groups).toEqual([])
    } finally {
      setPresetConfig(null)
    }
  })

  it('只切换到已存在的相同配置时摘要说明切换目标', () => {
    const base = current()
    const profile = { id: 'p0', name: 'P0', provider: 'openai', baseUrl: 'https://p0.example.com/v1', model: 'm0' }
    const settings = normalizeSettings({ ...base, profiles: [...base.profiles, profile] })
    const desc = describeImportLink(parseImportLink(settingsLink({ profiles: [profile] }))!, settings)
    expect(desc.summary).toBe('已存在相同的配置，导入后将切换到「P0」。')
    expect(desc.hasConfigChanges).toBe(false)
    expect(desc.groups).toEqual([])
  })

  it('只新增自定义服务商时摘要与附注一致', () => {
    const provider = { id: 'cp-1', name: '服务商 X', template: 'openai-compatible', baseUrl: 'https://x.example.com/v1' }
    const profile = { id: 'p0', name: 'P0', provider: 'openai', baseUrl: 'https://p0.example.com/v1', model: 'm0' }
    const base = current()
    const settings = normalizeSettings({ ...base, profiles: [...base.profiles, profile] })
    const desc = describeImportLink(parseImportLink(settingsLink({ customProviders: [provider], profiles: [profile] }))!, settings)
    expect(desc.notes).toEqual(['新增自定义服务商：服务商 X', '导入后将切换到「P0」'])
    expect(desc.groups).toEqual([])
    expect(desc.summary).toBe('链接将新增 1 个自定义服务商。请只导入来源可信的链接。')
    expect(desc.hasConfigChanges).toBe(true)
  })

  it('只修改已有自定义服务商的请求映射时需要确认', () => {
    const provider = { id: 'cp-1', name: '服务商 X', submit: { path: 'images/generations' } }
    const profile = { id: 'p0', name: 'P0', provider: 'cp-1', baseUrl: 'https://p0.example.com/v1', model: 'm0' }
    const base = current()
    const settings = normalizeSettings({ ...base, customProviders: [provider], profiles: [...base.profiles, profile], activeProfileId: 'p0' })
    const params = parseImportLink(settingsLink({ customProviders: [{ ...provider, submit: { path: 'images/generate' } }], profiles: [profile] }))!
    const next = normalizeSettings({ ...settings, ...buildSettingsFromUrlParams(settings, params) })
    expect(next.profiles).toEqual(settings.profiles)
    expect(next.customProviders[0]).toEqual({
      ...settings.customProviders[0],
      submit: { ...settings.customProviders[0].submit, path: 'images/generate' },
    })
    const desc = describeImportLink(params, settings)
    expect(desc.summary).toBe('链接将修改 1 个自定义服务商。请只导入来源可信的链接。')
    expect(desc.notes).toEqual(['修改自定义服务商：服务商 X'])
    expect(desc.groups).toEqual([])
    expect(desc.hasConfigChanges).toBe(true)
  })

  it('修改未展示的字段时逐项列出，布尔值和枚举显示为可读文本', () => {
    const profile = { id: 'p0', name: 'P0', provider: 'openai', baseUrl: 'https://p0.example.com/v1', model: 'm0' }
    const base = current()
    const settings = normalizeSettings({ ...base, profiles: [...base.profiles, profile] })
    const desc = describeImportLink(parseImportLink(settingsLink({ profiles: [{ ...profile, timeout: 300, codexCli: true, apiMode: 'responses' }] }))!, settings)
    const rows = desc.groups[0].rows
    expect(desc.groups[0].title).toBe('修改配置「P0」')
    expect(rows).toContainEqual({ label: '请求超时 (秒)', before: { text: '600' }, after: { text: '300' } })
    expect(rows).toContainEqual({ label: 'Codex CLI 兼容模式', before: { text: '关闭', fixed: true }, after: { text: '开启', fixed: true } })
    expect(rows).toContainEqual({ label: 'API 接口', before: { text: 'Images API', fixed: true }, after: { text: 'Responses API', fixed: true } })
    expect(rows.map((item) => item.label)).not.toContain('名称')
  })

  it('内置服务商名称是固定标签，自定义服务商名称按字面值显示', () => {
    const profile = { id: 'p0', name: 'P0', provider: 'openai', baseUrl: 'https://p0.example.com/v1', model: 'm0' }
    const base = current()
    const settings = normalizeSettings({ ...base, profiles: [...base.profiles, profile] })
    const toFal = describeImportLink(parseImportLink(settingsLink({ profiles: [{ ...profile, provider: 'fal' }] }))!, settings)
    expect(row(toFal, '修改配置「P0」', '服务商类型')).toEqual({ label: '服务商类型', before: { text: 'OpenAI', fixed: true }, after: { text: 'fal.ai', fixed: true } })
    const provider = { id: 'cp-1', name: '服务商 X', template: 'openai-compatible', baseUrl: 'https://x.example.com/v1' }
    const toCustom = describeImportLink(parseImportLink(settingsLink({ customProviders: [provider], profiles: [{ ...profile, provider: 'cp-1' }] }))!, settings)
    expect(row(toCustom, '修改配置「P0」', '服务商类型')?.after).toEqual({ text: '服务商 X' })
  })

  it('只改了内部字段时分组不为空', () => {
    const profile = { id: 'p0', name: 'P0', provider: 'openai', baseUrl: 'https://p0.example.com/v1', model: 'm0' }
    const base = current()
    const settings = normalizeSettings({ ...base, profiles: [...base.profiles, profile] })
    const desc = describeImportLink(parseImportLink(settingsLink({ profiles: [{ ...profile, providerDrafts: { fal: { model: 'x' } } }] }))!, settings)
    expect(desc.groups[0].rows).toEqual([{ label: '其他设置', note: '将修改该配置的其他内部设置' }])
  })

  it('同时修改可见字段和内部字段时也提示其他设置', () => {
    const profile = { id: 'p0', name: 'P0', provider: 'openai', baseUrl: 'https://p0.example.com/v1', model: 'm0' }
    const base = current()
    const settings = normalizeSettings({ ...base, profiles: [...base.profiles, profile] })
    const desc = describeImportLink(parseImportLink(settingsLink({ profiles: [{ ...profile, model: 'm1', providerDrafts: { fal: { baseUrl: 'https://evil.example.com' } } }] }))!, settings)
    expect(desc.groups[0].rows).toEqual([
      { label: '模型', before: { text: 'm0' }, after: { text: 'm1' } },
      { label: '其他设置', note: '将修改该配置的其他内部设置' },
    ])
  })

  it('新增配置列出链接中设置了的其他字段', () => {
    const desc = describeImportLink(parseImportLink(settingsLink({ profiles: [{ name: 'X', provider: 'openai', baseUrl: 'https://x.example.com/v1', codexCli: true, timeout: 300, reasoningEffort: 'high' }] }))!, current())
    const rows = desc.groups[0].rows
    expect(rows).toContainEqual({ label: 'Codex CLI 兼容模式', after: { text: '开启', fixed: true } })
    expect(rows).toContainEqual({ label: '请求超时 (秒)', after: { text: '300' } })
    expect(rows).toContainEqual({ label: '推理强度', after: { text: 'high' } })
    expect(rows.map((item) => item.label)).not.toContain('流式传输')
    expect(rows.map((item) => item.label)).not.toContain('服务商类型')
  })

  it('不会改变设置时如实说明', () => {
    const desc = describeImportLink(new URLSearchParams({ profileId: DEFAULT_OPENAI_PROFILE_ID }), current())
    expect(desc.summary).toContain('不会改变当前设置')
    expect(desc.groups).toEqual([])
    expect(desc.notes).toEqual([])
  })
})

describe('getProfileImportBaseUrl', () => {
  const options = { includeApiKey: true, useNewApiAddress: false, useNewApiKey: false, useNewApiModel: false }
  const profile = { ...createDefaultOpenAIProfile(), name: 'A', apiKey: 'sk-1' }

  it('客户端使用配置的网页版地址，网页版使用当前地址', () => {
    expect(getProfileImportBaseUrl(true, 'http://tauri.localhost/index.html', 'https://web.example.com')).toBe('https://web.example.com/')
    expect(getProfileImportBaseUrl(false, 'https://my-host.example.com/app/?a=1', 'https://web.example.com')).toBe('https://my-host.example.com/app/?a=1')
    expect(getProfileImportBaseUrl(false, 'https://my-host.example.com/app/?a=1', '')).toBe('https://my-host.example.com/app/?a=1')
  })

  it('客户端未配置网页版地址时改用 deep link', () => {
    expect(getProfileImportBaseUrl(true, 'http://tauri.localhost/', '')).toBe('gpt-image-playground://')
    const url = createCustomProfileImportUrl(getProfileImportBaseUrl(true, 'http://tauri.localhost/', ''), profile, undefined, options)
    expect(url.startsWith('gpt-image-playground://?settings=')).toBe(true)
    expect(parseImportLink(url)).not.toBeNull()
  })

  it('客户端复制的链接可以被重新识别为导入链接', () => {
    const url = createCustomProfileImportUrl(getProfileImportBaseUrl(true, 'http://tauri.localhost/', 'https://web.example.com'), profile, undefined, options)
    expect(url.startsWith('https://web.example.com/?settings=')).toBe(true)
    expect(parseImportLink(url)).not.toBeNull()
  })
})

describe('WEB_APP_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('读取 VITE_WEB_APP_URL 并去掉末尾斜杠', async () => {
    vi.stubEnv('VITE_WEB_APP_URL', ' https://web.example.com/ ')
    vi.resetModules()
    expect((await import('./importLink')).WEB_APP_URL).toBe('https://web.example.com')
  })

  it('未设置时为空', async () => {
    vi.stubEnv('VITE_WEB_APP_URL', '')
    vi.resetModules()
    expect((await import('./importLink')).WEB_APP_URL).toBe('')
  })
})
