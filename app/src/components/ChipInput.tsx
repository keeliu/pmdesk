import React, { useState } from 'react'

export default function ChipInput({ value, onChange, placeholder, label, hint }: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  label?: string
  hint?: string
}) {
  const [draft, setDraft] = useState('')
  const add = (raw: string) => {
    const parts = raw.split(/[、,，\n]+/).map(s => s.trim()).filter(Boolean)
    if (!parts.length) return
    const next = [...value]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
    setDraft('')
  }
  return (
    <div className="chip-input">
      {label && <span className="field-label">{label}{hint && <small>{hint}</small>}</span>}
      <div className="chips">
        {value.map(v => (
          <span key={v} className="chip">{v}<button type="button" onClick={() => onChange(value.filter(x => x !== v))} aria-label={`移除 ${v}`}>×</button></span>
        ))}
        {!value.length && <span className="muted tiny">暂未填写</span>}
      </div>
      <div className="row">
        <input type="text" value={draft} placeholder={placeholder || '输入后回车添加，可用顿号分隔'}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); add(draft) }
            if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1))
          }}
          onBlur={() => { if (draft.trim()) add(draft) }} />
        <button type="button" className="btn sm" onClick={() => add(draft)} disabled={!draft.trim()}>添加</button>
      </div>
    </div>
  )
}
