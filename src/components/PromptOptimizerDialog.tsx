import { CloseIcon, SparklesIcon } from './icons'

export function PromptOptimizerDialog(props: {
  original: string
  optimized: string
  onApply: () => void
  onClose: () => void
}) {
  return (
    <div className="aurora-modal-backdrop" onClick={props.onClose}>
      <section className="prompt-optimizer-modal" role="dialog" aria-modal="true" aria-labelledby="prompt-optimizer-title" onClick={(event) => event.stopPropagation()}>
        <header><span><SparklesIcon /></span><div><small>GPT-5.5 REWRITE</small><h2 id="prompt-optimizer-title">提示词优化结果</h2></div><button type="button" onClick={props.onClose} aria-label="关闭"><CloseIcon /></button></header>
        <div className="prompt-compare"><section><span>原提示词</span><p>{props.original}</p></section><section><span>优化结果</span><p>{props.optimized}</p></section></div>
        <footer><button type="button" onClick={props.onClose}>保留原文</button><button type="button" className="primary" onClick={props.onApply}>应用优化</button></footer>
      </section>
    </div>
  )
}
