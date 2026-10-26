import { useEffect, useRef, useState } from 'react'
import type { ApiProfile, AppSettings, BatchProgress, BatchPromptMode, TaskParams } from '../../types'
import { DEFAULT_BATCH_PROMPT_CONCURRENCY, normalizeBatchPromptConcurrency } from '../../lib/batchPrompts'
import { isTauri } from '../../lib/platform'
import { isGrokImageProfile, normalizeGrokQuality } from '../../lib/grok'
import { isAgnesImageProfile } from '../../lib/agnes'
import { dismissAllTooltips } from '../../lib/tooltipDismiss'
import Select from '../Select'
import ButtonTooltip from './buttonTooltip'
import ParamPopoverChip, { CHIP_BASE_CLASS, CHIP_IDLE_CLASS } from './paramPopoverChip'

const CHIP_CLASS = `${CHIP_BASE_CLASS} ${CHIP_IDLE_CLASS}`
const CHIP_DISABLED_CLASS = 'h-8 px-3.5 rounded-full bg-black/[0.03] dark:bg-white/[0.04] opacity-50 cursor-not-allowed text-xs text-gray-700 dark:text-gray-200'
const ROW_CLASS = 'relative flex items-center justify-between gap-3'
const ROW_LABEL_CLASS = 'text-gray-500 dark:text-gray-400'
const CONTROL_DISABLED_CLASS = 'px-3 py-1.5 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.04] opacity-50 cursor-not-allowed text-xs transition-all duration-200'

type BatchSettingsPatch = Partial<Pick<AppSettings, 'batchPromptEnabled' | 'batchPromptMode' | 'batchPromptConcurrencyLimited' | 'batchPromptConcurrency'>>

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
  modelValue,
  modelOptions,
  onModelChange,
  isFalProvider,
  isFalTextToImage,
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
  modelValue: string
  modelOptions: Array<{ label: string; value: string }>
  onModelChange: (model: string) => void
  isFalProvider: boolean
  isFalTextToImage: boolean
  displaySize: string
  qualityOptions: Array<{ label: string; value: string }>
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
  const isGrok = isGrokImageProfile(activeProfile)
  const isAgnes = isAgnesImageProfile(activeProfile)
  // 折叠时也展示弹层内每一项的当前值，不支持的参数不显示
  const moreSummary = [
    isGrok || isAgnes ? '格式自动' : params.output_format.toUpperCase(),
    showTransparentOutputControl
      ? `透明 ${transparentOutputEnabled}`
      : compressionDisabled ? null : `压缩 ${outputCompressionInput || '默认'}`,
    moderationDisabled ? null : `审核 ${params.moderation}`,
  ].filter(Boolean).join(' · ')
  const prefix = (text: string) => <span className="mr-1.5 text-gray-400 dark:text-gray-500">{text}</span>

  const batchSummary = batchProgress
    ? `${batchProgress.finished}/${batchProgress.total}`
    : batchEnabled ? `${batchPromptCount} 条` : undefined

  return (
    <div className="flex flex-1 flex-wrap sm:flex-nowrap items-center gap-2 min-w-0 text-xs">
      {/* 极小的收缩权重：先截断“更多”的摘要，放不下时才压缩模型 ID */}
      <div className="min-w-0 max-w-full sm:shrink-[0.01] max-sm:flex-auto">
        <Select
          value={modelValue}
          onChange={(val) => onModelChange(String(val))}
          options={modelOptions}
          showValueTooltips
          menuClassName="min-w-max"
          className={CHIP_CLASS}
        />
      </div>
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
          visible={(isFalTextToImage || activeProfile.codexCli) && sizeHint.visible}
          text={isFalTextToImage
            ? <>fal.ai 的文生图模式不支持 <code className="rounded bg-white/10 px-1 py-0.5 font-mono">auto</code> 参数</>
            : 'Codex CLI 不支持尺寸参数，此处设置仅基于提示词工程'}
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
          value={isGrok ? normalizeGrokQuality(params.quality) : activeProfile.codexCli ? 'auto' : isFalProvider && params.quality === 'auto' ? 'high' : params.quality}
          onChange={(val) => {
            if (!activeProfile.codexCli) setParams({ quality: val as TaskParams['quality'] })
          }}
          options={isAgnes ? [{ label: '自动', value: 'auto' }] : qualityOptions}
          disabled={activeProfile.codexCli || isAgnes}
          prefix={prefix('质量')}
          menuClassName="min-w-max"
          className={activeProfile.codexCli || isAgnes ? CHIP_DISABLED_CLASS : CHIP_CLASS}
        />
        <ButtonTooltip
          visible={(activeProfile.codexCli || isFalProvider) && qualityHint.visible}
          text={isFalProvider ? <>fal.ai 不支持 <code className="rounded bg-white/10 px-1 py-0.5 font-mono">auto</code> 质量参数</> : 'Codex CLI 不支持质量参数'}
        />
      </div>
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
      <ParamPopoverChip label="更多" summary={moreSummary} className="sm:min-w-[5rem]">
            <div className={ROW_CLASS}>
              <span className={ROW_LABEL_CLASS}>格式</span>
              <div className="w-28">
                <Select
                  value={params.output_format}
                  disabled={isGrok || isAgnes}
                  onChange={(val) => {
                    setParams({
                      output_format: val as TaskParams['output_format'],
                      ...(val === 'png' ? { output_compression: null } : {}),
                      ...(val === 'jpeg' ? { transparent_output: false } : {}),
                    })
                  }}
                  options={isGrok || isAgnes ? [{ label: '接口默认', value: 'png' }] : [
                    { label: 'PNG', value: 'png' },
                    { label: 'JPEG', value: 'jpeg' },
                    { label: 'WebP', value: 'webp' },
                  ]}
                  className={selectClass}
                />
              </div>
            </div>
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
                <ButtonTooltip
                  visible={transparentOutputHint.visible}
                  text="实现方式可在 设置 → API 配置 中选择"
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
                text={isGrok ? 'Grok 不支持审核参数' : isAgnes ? 'Agnes 不支持审核参数' : 'fal.ai 不支持审核参数'}
              />
            </div>
      </ParamPopoverChip>
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
