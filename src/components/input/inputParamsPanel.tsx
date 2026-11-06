import { useEffect, useRef, useState } from 'react'
import { GIF_FRAME_COUNT_RANGE, GIF_FRAME_DURATION_RANGE, IMAGE_COMPLEXITIES, type ApiProfile, type AppSettings, type BatchProgress, type BatchPromptMode, type ParamDisabledReasons, type TaskParams } from '../../types'
import { DEFAULT_BATCH_PROMPT_CONCURRENCY, normalizeBatchPromptConcurrency } from '../../lib/batchPrompts'
import { isTauri } from '../../lib/platform'
import { getImageModelFamily, supportsGrokQuality } from '../../lib/imageModels'
import { getImageModelOptions, getImageModelParams } from '../../lib/imageModelParams'
import { getImageSearchSupport, getImageThinkingSupport } from '../../lib/imageSearch'
import { useHintTooltip } from '../../hooks/useHintTooltip'
import { dismissAllTooltips } from '../../lib/tooltipDismiss'
import Select, { type SelectOption } from '../Select'
import ButtonTooltip from './buttonTooltip'
import ParamPopoverChip, { CHIP_BASE_CLASS, CHIP_IDLE_CLASS } from './paramPopoverChip'

const CHIP_CLASS = `${CHIP_BASE_CLASS} ${CHIP_IDLE_CLASS}`
const CHIP_DISABLED_CLASS = 'h-8 px-3.5 rounded-full bg-black/[0.03] dark:bg-white/[0.04] opacity-50 cursor-not-allowed text-xs text-gray-700 dark:text-gray-200'
// 与下拉框同高，开关行和下拉框行的间距保持一致
const ROW_CLASS = 'relative flex min-h-[30px] items-center justify-between gap-3'
const ROW_LABEL_CLASS = 'text-gray-500 dark:text-gray-400'
const CONTROL_DISABLED_CLASS = 'px-3 py-1.5 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.04] opacity-50 cursor-not-allowed text-xs transition-all duration-200'

type BatchSettingsPatch = Partial<Pick<AppSettings, 'batchPromptEnabled' | 'batchPromptMode' | 'batchPromptConcurrencyLimited' | 'batchPromptConcurrency'>>

function ImageSearchToggle({ label, hint: hintText, checked, reason, onToggle }: { label: string; hint: string; checked: boolean; reason?: string; onToggle: () => void }) {
  const hint = useHintTooltip()
  return (
    <div
      className={ROW_CLASS}
      onMouseEnter={hint.show}
      onMouseLeave={hint.hide}
      onTouchStart={hint.startTouch}
      onTouchEnd={hint.clearTimer}
      onTouchCancel={hint.hide}
      onClick={reason ? hint.show : undefined}
      onFocus={hint.show}
      onBlur={hint.hide}
      tabIndex={reason ? 0 : undefined}
    >
      <span className={ROW_LABEL_CLASS}>{label}</span>
      <Switch label={label} checked={!reason && checked} disabled={Boolean(reason)} onToggle={onToggle} />
      <ButtonTooltip
        visible={hint.visible}
        text={reason ?? hintText}
      />
    </div>
  )
}

function Switch({ checked, disabled, label, onToggle }: { checked: boolean; disabled?: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} />
    </button>
  )
}

/** 输入为空或无效时保留原值 */
function parseConcurrency(input: string, fallback: number) {
  const parsed = Number(input)
  return input.trim() && Number.isFinite(parsed) ? normalizeBatchPromptConcurrency(parsed) : fallback
}

/** 并发数输入框：随弹层挂载，打开时从已保存的值初始化，聚焦输入时实时提示过高的并发数 */
function ConcurrencyInput({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (value: number) => void }) {
  const [input, setInput] = useState(String(value))
  const [focused, setFocused] = useState(false)
  const latestRef = useRef({ input, value, onCommit })
  latestRef.current = { input, value, onCommit }

  // 直接关闭弹层时输入框被卸载而不会触发 blur，卸载时补一次提交
  useEffect(() => () => {
    const latest = latestRef.current
    const next = parseConcurrency(latest.input, latest.value)
    if (next !== latest.value) latest.onCommit(next)
  }, [])

  const commit = () => {
    const next = parseConcurrency(input, value)
    setInput(String(next))
    if (next !== value) onCommit(next)
  }

  return (
    <>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        disabled={disabled}
        type="number"
        min={1}
        className={`w-28 px-3 py-1.5 rounded-xl border border-transparent focus:border-blue-300 dark:focus:border-blue-500/50 focus:outline-none text-xs transition-all duration-200 ${
          disabled ? 'bg-black/[0.03] dark:bg-white/[0.04] opacity-50 cursor-not-allowed' : 'bg-black/[0.04] dark:bg-white/[0.06]'
        }`}
      />
      <ButtonTooltip
        visible={focused && Number(input) > DEFAULT_BATCH_PROMPT_CONCURRENCY}
        text={`并发数超过 ${DEFAULT_BATCH_PROMPT_CONCURRENCY} 可能导致${isTauri ? '客户端' : '浏览器'}卡顿或触发服务商限流`}
      />
    </>
  )
}

/** GIF 帧参数输入框：超出范围时取边界值，清空或无效时保留原值 */
function GifParamInput({ value, range, onCommit }: {
  value: number
  range: { min: number; max: number }
  onCommit: (value: number) => void
}) {
  const [input, setInput] = useState(String(value))
  const latestRef = useRef({ input, value, onCommit })
  latestRef.current = { input, value, onCommit }

  const parse = (text: string, fallback: number) => {
    const parsed = Number(text)
    if (!text.trim() || !Number.isFinite(parsed)) return fallback
    return Math.min(range.max, Math.max(range.min, Math.round(parsed)))
  }

  // 直接关闭弹层时输入框被卸载而不会触发 blur，卸载时补一次提交
  useEffect(() => () => {
    const latest = latestRef.current
    const next = parse(latest.input, latest.value)
    if (next !== latest.value) latest.onCommit(next)
  }, [])

  return (
    <input
      value={input}
      onChange={(e) => setInput(e.target.value)}
      onBlur={() => {
        const next = parse(input, value)
        setInput(String(next))
        if (next !== value) onCommit(next)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      type="number"
      min={range.min}
      max={range.max}
      className="w-28 px-3 py-1.5 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] focus:border-blue-300 dark:focus:border-blue-500/50 focus:outline-none text-xs transition-all duration-200"
    />
  )
}

interface HintTooltipState {
  visible: boolean
  show: () => void
  hide: () => void
  clearTimer: () => void
  startTouch: () => void
}

export default function InputParamsPanel({
  params,
  setParams,
  activeProfile,
  searchSupport,
  thinkingSupport,
  modelOptions,
  onModelChange,
  isFalProvider,
  displaySize,
  qualityOptions,
  selectClass,
  transparentOutputAvailable,
  showTransparentOutputControl,
  transparentOutputEnabled,
  transparentOutputHint,
  onTransparentOutputMenuOpenChange,
  compressionHint,
  compressionDisabled,
  outputCompressionInput,
  setOutputCompressionInput,
  commitOutputCompression,
  moderationHint,
  moderationDisabled,
  complexityHint,
  disabledReasons,
  hasInputImages,
  agentAutoImageCount,
  outputImageLimit,
  nInput,
  setNInputFocused,
  commitN,
  handleNInputChange,
  handleNLimitIncreaseAttempt,
  showAgentNHint,
  hideNLimitHint,
  startAgentNHintTouch,
  clearAgentNHintTouchTimer,
  nLimitHint,
  nLimitHintText,
  streamConcurrentByN,
  streamConcurrentHint,
  sizeHint,
  qualityHint,
  onOpenSizePicker,
  showBatch,
  batchEnabled,
  batchMode,
  batchConcurrencyLimited,
  batchConcurrency,
  batchPromptCount,
  batchProgress,
  onBatchChange,
  onStopBatch,
}: {
  params: TaskParams
  setParams: (patch: Partial<TaskParams>) => void
  activeProfile: ApiProfile
  searchSupport: ReturnType<typeof getImageSearchSupport>
  thinkingSupport: ReturnType<typeof getImageThinkingSupport>
  modelOptions: Array<{ label: string; value: string }>
  onModelChange: (model: string) => void
  isFalProvider: boolean
  displaySize: string
  qualityOptions: SelectOption[]
  selectClass: string
  transparentOutputAvailable: boolean
  showTransparentOutputControl: boolean
  transparentOutputEnabled: boolean
  transparentOutputHint: HintTooltipState
  onTransparentOutputMenuOpenChange: (open: boolean) => void
  compressionHint: HintTooltipState
  compressionDisabled: boolean
  outputCompressionInput: string
  setOutputCompressionInput: (value: string) => void
  commitOutputCompression: () => void
  moderationHint: HintTooltipState
  moderationDisabled: boolean
  complexityHint: HintTooltipState
  disabledReasons: ParamDisabledReasons
  hasInputImages: boolean
  agentAutoImageCount: boolean
  outputImageLimit: number
  nInput: string
  setNInputFocused: (focused: boolean) => void
  commitN: () => void
  handleNInputChange: (value: string) => void
  handleNLimitIncreaseAttempt: (preventDefault: () => void) => void
  showAgentNHint: () => void
  hideNLimitHint: () => void
  startAgentNHintTouch: () => void
  clearAgentNHintTouchTimer: () => void
  nLimitHint: HintTooltipState
  nLimitHintText: string
  streamConcurrentByN: boolean
  streamConcurrentHint: HintTooltipState
  sizeHint: HintTooltipState
  qualityHint: HintTooltipState
  onOpenSizePicker: () => void
  showBatch: boolean
  batchEnabled: boolean
  batchMode: BatchPromptMode
  batchConcurrencyLimited: boolean
  batchConcurrency: number
  batchPromptCount: number
  batchProgress: BatchProgress | null
  onBatchChange: (patch: BatchSettingsPatch) => void
  onStopBatch: () => void
}) {
  // 折叠时也展示弹层内每一项的当前值，不支持的参数不显示
  const family = getImageModelFamily(activeProfile)
  const modelOptionsForImage = getImageModelOptions(activeProfile)
  const modelParams = getImageModelParams(activeProfile, params)
  const resolutionHint = useHintTooltip({ enabled: () => !modelOptionsForImage.resolutions.length })
  const thinkingHint = useHintTooltip({ enabled: () => Boolean(thinkingSupport.reason) })
  const qualityDisabled = family === 'grok' && !supportsGrokQuality(activeProfile.model)
  const thinkingValue = thinkingSupport.levels.includes(params.thinking_level ?? '') ? params.thinking_level! : 'auto'
  const isGif = params.output_format === 'gif'
  const moreSummary = (
    family === 'gemini'
      ? [
          thinkingSupport.reason ? null : `思考等级 ${thinkingValue}`,
          params.google_search && !searchSupport.googleSearch ? 'Google Search' : null,
          params.image_search && !searchSupport.imageSearch ? 'Image Search' : null,
          transparentOutputAvailable ? `透明 ${Boolean(params.transparent_output)}` : null,
        ]
      : [
          disabledReasons.complexity ? null : `复杂度 ${params.complexity}`,
          params.output_format.toUpperCase(),
          isGif ? `${params.frame_count} 帧` : null,
          showTransparentOutputControl
            ? `透明 ${transparentOutputEnabled}`
            : compressionDisabled ? null : `压缩 ${outputCompressionInput || '默认'}`,
          moderationDisabled ? null : `审核 ${params.moderation}`,
        ]
  ).filter(Boolean).join(' · ')
  const prefix = (text: string) => <span className="mr-1.5 text-gray-400 dark:text-gray-500">{text}</span>

  const batchSummary = batchProgress
    ? `${batchProgress.finished}/${batchProgress.total}`
    : batchEnabled ? `${batchPromptCount} 条` : undefined

  return (
    <div className="flex flex-1 flex-wrap items-center gap-2 min-w-0 text-xs">
      <div className="min-w-0 max-w-full max-sm:flex-auto">
        <Select
          value={activeProfile.model}
          onChange={(val) => onModelChange(String(val))}
          options={modelOptions}
          showValueTooltips
          menuClassName="min-w-max"
          className={CHIP_CLASS}
        />
      </div>
      {family && (
        <>
          <div className="max-sm:flex-auto sm:shrink-0">
            <Select
              value={modelParams.aspect_ratio}
              onChange={(value) => setParams({ aspect_ratio: String(value) })}
              options={modelOptionsForImage.ratios.map((value) => ({ label: value, value }))}
              prefix={prefix('比例')}
              menuClassName="min-w-max"
              className={CHIP_CLASS}
            />
          </div>
          <div
            className="relative max-sm:flex-auto sm:shrink-0"
            onMouseEnter={resolutionHint.show}
            onMouseLeave={resolutionHint.hide}
            onTouchStart={resolutionHint.startTouch}
            onTouchEnd={resolutionHint.clearTimer}
            onTouchCancel={resolutionHint.hide}
            onClick={resolutionHint.show}
          >
            <Select
              value={modelParams.resolution ?? 'auto'}
              onChange={(value) => setParams({ resolution: String(value) })}
              options={(family === 'grok' ? ['1K', '2K'] : ['512', '1K', '2K', '4K']).map((value) => ({
                label: value,
                value,
                disabledReason: modelOptionsForImage.resolutions.includes(value) ? undefined : '当前模型不支持此分辨率',
              }))}
              disabled={!modelOptionsForImage.resolutions.length}
              prefix={prefix('分辨率')}
              menuClassName="min-w-max"
              className={modelOptionsForImage.resolutions.length ? CHIP_CLASS : CHIP_DISABLED_CLASS}
            />
            <ButtonTooltip visible={!modelOptionsForImage.resolutions.length && resolutionHint.visible} text="当前模型不支持分辨率参数" />
          </div>
          {family === 'grok' && (
            <div
              className="relative max-sm:flex-auto sm:shrink-0"
              onMouseEnter={qualityHint.show}
              onMouseLeave={qualityHint.hide}
              onTouchStart={qualityHint.startTouch}
              onTouchEnd={qualityHint.clearTimer}
              onTouchCancel={qualityHint.hide}
              onClick={qualityHint.show}
            >
              <Select
                value={modelParams.quality ?? 'auto'}
                onChange={(value) => setParams({ quality: value as TaskParams['quality'] })}
                options={['auto', 'low', 'medium'].map((value) => ({ label: value, value }))}
                disabled={qualityDisabled}
                prefix={prefix('质量')}
                menuClassName="min-w-max"
                className={qualityDisabled ? CHIP_DISABLED_CLASS : CHIP_CLASS}
              />
              <ButtonTooltip visible={qualityDisabled && qualityHint.visible} text="当前模型不支持质量参数" />
            </div>
          )}
        </>
      )}
      {!family && (
        <>
          <div
            className="relative max-sm:flex-auto sm:shrink-0"
            onMouseEnter={sizeHint.show}
            onMouseLeave={sizeHint.hide}
            onTouchStart={sizeHint.startTouch}
            onTouchEnd={sizeHint.clearTimer}
            onTouchCancel={sizeHint.hide}
            onClick={sizeHint.show}
          >
            <button
              type="button"
              onClick={() => { dismissAllTooltips(); onOpenSizePicker() }}
              className={`flex w-full items-center ${CHIP_CLASS}`}
            >
              {prefix('尺寸')}
              <span className="font-mono">{displaySize}</span>
            </button>
            <ButtonTooltip
              visible={(Boolean(disabledReasons.autoSize) || activeProfile.codexCli) && sizeHint.visible}
              text={disabledReasons.autoSize ?? 'Codex CLI 不支持尺寸参数，此处设置仅基于提示词工程'}
            />
          </div>
          <div
            className="relative max-sm:flex-auto sm:shrink-0"
            onMouseEnter={qualityHint.show}
            onMouseLeave={qualityHint.hide}
            onTouchStart={qualityHint.startTouch}
            onTouchEnd={qualityHint.clearTimer}
            onTouchCancel={qualityHint.hide}
            onClick={qualityHint.show}
          >
            <Select
              value={activeProfile.codexCli ? 'auto' : isFalProvider && params.quality === 'auto' ? 'high' : params.quality}
              onChange={(val) => {
                if (!activeProfile.codexCli) setParams({ quality: val as TaskParams['quality'] })
              }}
              options={qualityOptions}
              disabled={activeProfile.codexCli}
              prefix={prefix('质量')}
              menuClassName="min-w-max"
              className={activeProfile.codexCli ? CHIP_DISABLED_CLASS : CHIP_CLASS}
            />
            <ButtonTooltip
              visible={activeProfile.codexCli && qualityHint.visible}
              text="Codex CLI 不支持质量参数"
            />
          </div>
        </>
      )}
      <label
        className={`relative flex items-center max-sm:flex-auto sm:shrink-0 ${agentAutoImageCount ? CHIP_DISABLED_CLASS : `${CHIP_CLASS} cursor-text`}`}
        onMouseEnter={() => { showAgentNHint(); streamConcurrentHint.show() }}
        onMouseLeave={() => { hideNLimitHint(); streamConcurrentHint.hide() }}
        onTouchStart={() => { startAgentNHintTouch(); streamConcurrentHint.startTouch() }}
        onTouchEnd={() => { clearAgentNHintTouchTimer(); streamConcurrentHint.clearTimer() }}
        onTouchCancel={() => {
          clearAgentNHintTouchTimer()
          hideNLimitHint()
          streamConcurrentHint.hide()
        }}
        onClick={() => { showAgentNHint(); streamConcurrentHint.show() }}
      >
        {prefix('数量')}
        <input
          value={nInput}
          onChange={(e) => handleNInputChange(e.target.value)}
          onFocus={() => setNInputFocused(true)}
          onBlur={() => {
            setNInputFocused(false)
            commitN()
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              handleNLimitIncreaseAttempt(() => e.preventDefault())
            }
          }}
          onWheel={(e) => {
            if (e.deltaY < 0) {
              handleNLimitIncreaseAttempt(() => e.preventDefault())
            }
          }}
          disabled={agentAutoImageCount}
          type={agentAutoImageCount ? 'text' : 'number'}
          min={agentAutoImageCount ? undefined : 1}
          max={agentAutoImageCount ? undefined : outputImageLimit}
          style={{ width: `${Math.max(1, nInput.length)}ch` }}
          className="bg-transparent text-xs focus:outline-none disabled:cursor-not-allowed [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <ButtonTooltip visible={nLimitHint.visible} text={nLimitHintText} />
        <ButtonTooltip visible={streamConcurrentByN && streamConcurrentHint.visible && !nLimitHint.visible} text="数量大于 1 时会将多图生成拆分为并发单图" />
      </label>
      {family === 'grok' && transparentOutputAvailable && (
        <div
          className="relative max-sm:flex-auto sm:shrink-0"
          onMouseEnter={transparentOutputHint.show}
          onMouseLeave={transparentOutputHint.hide}
          onTouchStart={transparentOutputHint.startTouch}
          onTouchEnd={transparentOutputHint.clearTimer}
          onTouchCancel={transparentOutputHint.hide}
          onClick={transparentOutputHint.show}
        >
          <Select
            value={params.transparent_output ? 'on' : 'off'}
            onChange={(value) => setParams({ transparent_output: value === 'on' })}
            options={[
              { label: 'false', value: 'off' },
              { label: 'true', value: 'on' },
            ]}
            prefix={prefix('透明背景')}
            menuClassName="min-w-max"
            className={CHIP_CLASS}
            onOpenChange={onTransparentOutputMenuOpenChange}
          />
          <ButtonTooltip visible={transparentOutputHint.visible} text="当前图像模型使用本地后处理生成透明背景" />
        </div>
      )}
      {family !== 'grok' && (
        // 按 5rem 参与换行判断，再伸展到摘要全宽：空间不足时先截断摘要，连 5rem 都放不下才换行
        <ParamPopoverChip label="更多" summary={moreSummary} className="sm:basis-20 sm:grow sm:max-w-max">
          {family === 'gemini' && (
            <>
              <div
                className={ROW_CLASS}
                onMouseEnter={thinkingHint.show}
                onMouseLeave={thinkingHint.hide}
                onTouchStart={thinkingHint.startTouch}
                onTouchEnd={thinkingHint.clearTimer}
                onTouchCancel={thinkingHint.hide}
                onClick={thinkingHint.show}
              >
                <span className={ROW_LABEL_CLASS}>思考等级</span>
                <div className="w-28">
                  <Select
                    value={thinkingValue}
                    onChange={(value) => setParams({ thinking_level: value as TaskParams['thinking_level'] })}
                    options={['auto', 'minimal', 'low', 'medium', 'high'].map((value) => ({
                      label: value,
                      value,
                      disabledReason: value === 'auto' || thinkingSupport.levels.includes(value) ? undefined : '当前模型不支持此思考等级',
                    }))}
                    disabled={Boolean(thinkingSupport.reason)}
                    className={thinkingSupport.reason ? CONTROL_DISABLED_CLASS : selectClass}
                  />
                </div>
                <ButtonTooltip visible={Boolean(thinkingSupport.reason) && thinkingHint.visible} text={thinkingSupport.reason} />
              </div>
              <ImageSearchToggle
                label="Google Search"
                hint="搜索网页信息，为图像生成提供参考"
                checked={Boolean(params.google_search)}
                reason={searchSupport.googleSearch}
                onToggle={() => setParams({ google_search: !params.google_search })}
              />
              <ImageSearchToggle
                label="Image Search"
                hint="搜索网络图片，为图像生成提供视觉参考"
                checked={Boolean(params.image_search)}
                reason={searchSupport.imageSearch}
                onToggle={() => setParams({ image_search: !params.image_search })}
              />
            </>
          )}
          {family === 'gemini' && transparentOutputAvailable && (
            <div
              className={ROW_CLASS}
              onMouseEnter={transparentOutputHint.show}
              onMouseLeave={transparentOutputHint.hide}
              onTouchStart={transparentOutputHint.startTouch}
              onTouchEnd={transparentOutputHint.clearTimer}
              onTouchCancel={transparentOutputHint.hide}
              onClick={transparentOutputHint.show}
            >
              <span className={ROW_LABEL_CLASS}>透明背景</span>
              <div className="w-28">
                <Select
                  value={params.transparent_output ? 'on' : 'off'}
                  onChange={(value) => setParams({ transparent_output: value === 'on' })}
                  options={[
                    { label: 'false', value: 'off' },
                    { label: 'true', value: 'on' },
                  ]}
                  className={selectClass}
                  onOpenChange={onTransparentOutputMenuOpenChange}
                />
              </div>
              <ButtonTooltip
                visible={transparentOutputHint.visible}
                text="当前图像模型使用本地后处理生成透明背景"
              />
            </div>
          )}
          {!family && (
            <>
              <div
                className={ROW_CLASS}
                onMouseEnter={complexityHint.show}
                onMouseLeave={complexityHint.hide}
                onTouchStart={complexityHint.startTouch}
                onTouchEnd={complexityHint.clearTimer}
                onTouchCancel={complexityHint.hide}
                onClick={complexityHint.show}
              >
                <span className={ROW_LABEL_CLASS}>复杂度</span>
                <div className="w-28">
                  <Select
                    value={disabledReasons.complexity ? 'auto' : params.complexity}
                    onChange={(val) => {
                      if (!disabledReasons.complexity) setParams({ complexity: val as TaskParams['complexity'] })
                    }}
                    options={IMAGE_COMPLEXITIES.map((value) => ({ label: value, value }))}
                    disabled={Boolean(disabledReasons.complexity)}
                    className={disabledReasons.complexity ? CONTROL_DISABLED_CLASS : selectClass}
                  />
                </div>
                <ButtonTooltip
                  visible={Boolean(disabledReasons.complexity) && complexityHint.visible}
                  text={disabledReasons.complexity}
                />
              </div>
              <div className={ROW_CLASS}>
                <span className={ROW_LABEL_CLASS}>格式</span>
                <div className="w-28">
                  <Select
                    value={params.output_format}
                    onChange={(val) => {
                      setParams({
                        output_format: val as TaskParams['output_format'],
                        ...(val === 'png' || val === 'svg' || val === 'gif' ? { output_compression: null } : {}),
                        ...(val === 'jpeg' ? { transparent_output: false } : {}),
                      })
                    }}
                    options={[
                      { label: 'PNG', value: 'png' },
                      { label: 'JPEG', value: 'jpeg' },
                      { label: 'WebP', value: 'webp' },
                      { label: 'SVG', value: 'svg', disabledReason: disabledReasons.svg },
                      { label: 'GIF', value: 'gif', disabledReason: disabledReasons.gif },
                    ]}
                    className={selectClass}
                  />
                </div>
              </div>
              {hasInputImages && params.output_format === 'svg' && (
                <p className="text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                  SVG 只能用于文生图，有参考图时无法提交
                </p>
              )}
              {isGif && (
                <>
                  <label className={ROW_CLASS}>
                    <span className={ROW_LABEL_CLASS}>帧数</span>
                    <GifParamInput
                      value={params.frame_count}
                      range={GIF_FRAME_COUNT_RANGE}
                      onCommit={(frame_count) => setParams({ frame_count })}
                    />
                  </label>
                  <label className={ROW_CLASS}>
                    <span className={ROW_LABEL_CLASS}>每帧时长（ms）</span>
                    <GifParamInput
                      value={params.frame_duration_ms}
                      range={GIF_FRAME_DURATION_RANGE}
                      onCommit={(frame_duration_ms) => setParams({ frame_duration_ms })}
                    />
                  </label>
                </>
              )}
              {showTransparentOutputControl && (
                <div
                  className={ROW_CLASS}
                  onMouseEnter={transparentOutputHint.show}
                  onMouseLeave={transparentOutputHint.hide}
                  onTouchStart={transparentOutputHint.startTouch}
                  onTouchEnd={transparentOutputHint.clearTimer}
                  onTouchCancel={transparentOutputHint.hide}
                  onClick={transparentOutputHint.show}
                >
                  <span className={ROW_LABEL_CLASS}>透明背景</span>
                  <div className="w-28">
                    <Select
                      value={transparentOutputEnabled ? 'on' : 'off'}
                      onChange={(val) => {
                        if (!transparentOutputAvailable) return
                        setParams({
                          transparent_output: val === 'on',
                          ...(params.output_format === 'png' ? { output_compression: null } : {}),
                        })
                      }}
                      options={[
                        { label: 'false', value: 'off' },
                        { label: 'true', value: 'on' },
                      ]}
                      className={selectClass}
                      onOpenChange={onTransparentOutputMenuOpenChange}
                    />
                  </div>
                  {/* SVG 和 GIF 只能用接口原生透明背景，没有可选的实现方式 */}
                  <ButtonTooltip
                    visible={transparentOutputHint.visible && params.output_format !== 'svg' && !isGif}
                    text={<>实现方式可在<strong className="font-semibold">「设置 → API 配置」</strong>中选择</>}
                  />
                </div>
              )}
              {!showTransparentOutputControl && (
                <label
                  className={ROW_CLASS}
                  onMouseEnter={compressionHint.show}
                  onMouseLeave={compressionHint.hide}
                  onTouchStart={compressionHint.startTouch}
                  onTouchEnd={compressionHint.clearTimer}
                  onTouchCancel={compressionHint.hide}
                  onClick={compressionHint.show}
                >
                  <span className={ROW_LABEL_CLASS}>压缩率</span>
                  <input
                    value={outputCompressionInput}
                    onChange={(e) => setOutputCompressionInput(e.target.value)}
                    onBlur={commitOutputCompression}
                    disabled={compressionDisabled}
                    type="number"
                    min={0}
                    max={100}
                    placeholder="0-100"
                    className={`w-28 px-3 py-1.5 rounded-xl border border-transparent focus:border-blue-300 dark:focus:border-blue-500/50 focus:outline-none text-xs transition-all duration-200 ${
                      compressionDisabled
                        ? 'bg-black/[0.03] dark:bg-white/[0.04] opacity-50 cursor-not-allowed'
                        : 'bg-black/[0.04] dark:bg-white/[0.06]'
                      }`}
                  />
                  <ButtonTooltip
                    visible={compressionHint.visible}
                    text={isFalProvider ? 'fal.ai 不支持压缩率参数' : '仅 JPEG 和 WebP 支持压缩率'}
                  />
                </label>
              )}
              <div
                className={ROW_CLASS}
                onMouseEnter={moderationHint.show}
                onMouseLeave={moderationHint.hide}
                onTouchStart={moderationHint.startTouch}
                onTouchEnd={moderationHint.clearTimer}
                onTouchCancel={moderationHint.hide}
                onClick={moderationHint.show}
              >
                <span className={ROW_LABEL_CLASS}>审核</span>
                <div className="w-28">
                  <Select
                    value={moderationDisabled ? 'auto' : params.moderation}
                    onChange={(val) => {
                      if (!moderationDisabled) setParams({ moderation: val as TaskParams['moderation'] })
                    }}
                    options={[
                      { label: 'auto', value: 'auto' },
                      { label: 'low', value: 'low' },
                    ]}
                    disabled={moderationDisabled}
                    className={moderationDisabled ? CONTROL_DISABLED_CLASS : selectClass}
                  />
                </div>
                <ButtonTooltip
                  visible={moderationDisabled && moderationHint.visible}
                  text="fal.ai 不支持审核参数"
                />
              </div>
            </>
          )}
        </ParamPopoverChip>
      )}
      {showBatch && (
        <ParamPopoverChip label="批量" summary={batchSummary} active={batchEnabled || Boolean(batchProgress)} className="sm:shrink-0">
          <div className={ROW_CLASS}>
            <span className={ROW_LABEL_CLASS}>多提示词批量提交</span>
            <Switch
              checked={batchEnabled}
              disabled={Boolean(batchProgress)}
              label="多提示词批量提交"
              onToggle={() => onBatchChange({ batchPromptEnabled: !batchEnabled })}
            />
          </div>
          {batchEnabled && (
            <>
              <div className={ROW_CLASS}>
                <span className={ROW_LABEL_CLASS}>执行方式</span>
                <div className="w-28">
                  <Select
                    value={batchMode}
                    onChange={(val) => onBatchChange({ batchPromptMode: val as BatchPromptMode })}
                    options={[
                      { label: '排队', value: 'queue' },
                      { label: '并发', value: 'concurrent' },
                    ]}
                    disabled={Boolean(batchProgress)}
                    className={batchProgress ? CONTROL_DISABLED_CLASS : selectClass}
                  />
                </div>
              </div>
              {batchMode === 'concurrent' && (
                <div className={ROW_CLASS}>
                  <span className={ROW_LABEL_CLASS}>限制并发数</span>
                  <Switch
                    checked={batchConcurrencyLimited}
                    disabled={Boolean(batchProgress)}
                    label="限制并发数"
                    onToggle={() => onBatchChange({ batchPromptConcurrencyLimited: !batchConcurrencyLimited })}
                  />
                </div>
              )}
              {batchMode === 'concurrent' && batchConcurrencyLimited && (
                <label className={ROW_CLASS}>
                  <span className={ROW_LABEL_CLASS}>并发数</span>
                  <ConcurrencyInput
                    value={batchConcurrency}
                    disabled={Boolean(batchProgress)}
                    onCommit={(value) => onBatchChange({ batchPromptConcurrency: value })}
                  />
                </label>
              )}
              {batchMode === 'concurrent' && !batchConcurrencyLimited && (
                <p className="rounded-lg bg-amber-500/[0.1] px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:bg-amber-500/[0.14] dark:text-amber-400/90">
                  不限制并发时会同时发出全部请求，提示词较多时可能导致{isTauri ? '客户端' : '浏览器'}卡顿甚至崩溃，也容易触发服务商限流。
                </p>
              )}
              <p className="text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
                提示词之间空两行分隔，当前共 {batchPromptCount} 条；参考图和参数对每条提示词都生效。
              </p>
            </>
          )}
          {batchProgress && (
            <div className={ROW_CLASS}>
              <span className={ROW_LABEL_CLASS}>
                已完成 {batchProgress.finished} / {batchProgress.total}
              </span>
              <button
                type="button"
                onClick={onStopBatch}
                className="rounded-xl bg-red-500/[0.12] px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-500/[0.18] dark:bg-red-500/[0.18] dark:text-red-400/90 dark:hover:bg-red-500/[0.25]"
              >
                停止批量
              </button>
            </div>
          )}
        </ParamPopoverChip>
      )}
    </div>
  )
}
