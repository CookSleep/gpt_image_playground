import React from 'react'

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: React.ReactNode
  tone?: 'primary' | 'danger'
}

export function Checkbox({ checked, onChange, label, tone = 'primary', className, ...props }: CheckboxProps) {
  const toneClasses = tone === 'danger'
    ? 'border-red-300/80 hover:border-red-400/80 checked:bg-red-500/85 checked:border-transparent focus:ring-red-500/20 dark:border-red-500/30 dark:hover:border-red-500/50 dark:checked:bg-red-500/60 dark:checked:border-transparent'
    : 'border-gray-300 hover:border-gray-400 checked:bg-blue-500 checked:border-blue-500 focus:ring-blue-500/20 dark:border-white/15 dark:hover:border-white/30 dark:checked:bg-blue-500 dark:checked:border-transparent'
  return (
    <label className={`flex items-center gap-2.5 cursor-pointer group ${className || ''}`}>
      <div className="relative flex items-center justify-center">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className={`peer appearance-none w-4 h-4 rounded-[4px] border bg-white focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-offset-white dark:bg-white/5 dark:focus:ring-offset-gray-900 transition-all cursor-pointer ${toneClasses}`}
          {...props}
        />
        <svg
          className="absolute w-2.5 h-2.5 pointer-events-none opacity-0 peer-checked:opacity-100 scale-50 peer-checked:scale-100 transition-all duration-200 text-white"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.5l3.5 3.5L19 6.5" />
        </svg>
      </div>
      {label && <span className="text-[13px] font-medium text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-gray-100 transition-colors select-none">{label}</span>}
    </label>
  )
}
