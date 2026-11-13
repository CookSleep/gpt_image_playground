import { useState, type InputHTMLAttributes } from 'react'
import { CollapseIcon, ExpandIcon } from '../icons'
import { TooltipButton } from '../TooltipButton'

type Props = Pick<InputHTMLAttributes<HTMLInputElement>, 'value' | 'disabled' | 'placeholder' | 'aria-label'> & {
  onChange: (value: string) => void
  onBlur: (value: string) => void
}

export default function ModelIdInput(props: Props) {
  const [expanded, setExpanded] = useState(false)
  const className = 'block w-full rounded-xl border border-transparent bg-black/[0.04] pl-3 pr-10 py-2.5 text-sm text-gray-700 outline-none transition-[border-color] focus:border-blue-300 dark:bg-white/[0.06] dark:text-gray-200 dark:focus:border-blue-500/50'
  const inputProps = {
    value: props.value,
    disabled: props.disabled,
    placeholder: props.placeholder,
    'aria-label': props['aria-label'],
  }

  return (
    <div className="relative">
      {expanded ? (
        <textarea
          {...inputProps}
          rows={5}
          className={`${className} min-h-[80px] max-h-[60vh] resize-y custom-scrollbar`}
          onChange={(e) => props.onChange(e.target.value.replace(/[\r\n]+/g, ' '))}
          onBlur={(e) => props.onBlur(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.preventDefault()
          }}
        />
      ) : (
        <input
          {...inputProps}
          type="text"
          className={className}
          onChange={(e) => props.onChange(e.target.value)}
          onBlur={(e) => props.onBlur(e.target.value)}
        />
      )}
      <TooltipButton
        tooltip={expanded ? '恢复输入框' : '展开输入框'}
        wrapperClassName="absolute right-2 top-2"
        className="flex items-center justify-center rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 focus:outline-none dark:hover:bg-white/[0.08] dark:hover:text-gray-200"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <CollapseIcon className="h-4 w-4" /> : <ExpandIcon className="h-4 w-4" />}
      </TooltipButton>
    </div>
  )
}
