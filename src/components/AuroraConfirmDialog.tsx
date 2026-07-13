import { AlertCircleIcon, CloseIcon } from './icons'

export interface AuroraConfirmAction {
  label: string
  tone?: 'default' | 'danger'
  action: () => void | Promise<void>
}

export function AuroraConfirmDialog(props: {
  title: string
  message: string
  actions: AuroraConfirmAction[]
  busy?: boolean
  onClose: () => void
}) {
  return (
    <div className="aurora-modal-backdrop" onClick={props.onClose}>
      <section className="aurora-confirm" role="alertdialog" aria-modal="true" aria-labelledby="aurora-confirm-title" onClick={(event) => event.stopPropagation()}>
        <button className="aurora-modal-close" type="button" onClick={props.onClose} aria-label="关闭"><CloseIcon /></button>
        <span className="aurora-confirm-icon"><AlertCircleIcon /></span>
        <h2 id="aurora-confirm-title">{props.title}</h2>
        <p>{props.message}</p>
        <div>
          <button type="button" disabled={props.busy} onClick={props.onClose}>取消</button>
          {props.actions.map((action) => <button key={action.label} type="button" className={action.tone === 'danger' ? 'danger' : ''} disabled={props.busy} onClick={() => void action.action()}>{action.label}</button>)}
        </div>
      </section>
    </div>
  )
}
