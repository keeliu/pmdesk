import React, { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { TONE } from './api'
import { statusLabel } from './status'

type ToastItem = { id: number; message: string; tone: string }
const ToastCtx = createContext<{ push: (message: string, tone?: string) => void }>({ push: () => {} })

export function useToast() { return useContext(ToastCtx) }

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((message: string, tone = 'info') => {
    const id = Date.now() + Math.random()
    setItems(list => [...list, { id, message, tone }])
    setTimeout(() => setItems(list => list.filter(x => x.id !== id)), 4200)
  }, [])
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts">
        {items.map(t => <div key={t.id} className={`toast tone-${t.tone}`}>{t.message}</div>)}
      </div>
    </ToastCtx.Provider>
  )
}

export function useAsync<T = any>(fn: () => Promise<T>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    fn().then(d => { if (alive) { setData(d); setError('') } })
      .catch(e => { if (alive) setError(e.message || '加载失败') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [...deps, tick])
  return { data, loading, error, reload: () => setTick(t => t + 1), setData }
}

export function Tag({ tone = 'gray', children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`tag tone-${tone}`}>{children}</span>
}

export function StatusTag({ status }: { status: string }) {
  return <Tag tone={TONE[status] || 'gray'}>{statusLabel(status)}</Tag>
}

export function Modal({ title, subtitle, onClose, children, footer, wide = false }: {
  title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-mask" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Field({ label, hint, required, children }: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}{required && <em>*</em>}{hint && <small>{hint}</small>}</span>
      {children}
    </label>
  )
}

export function Empty({ title, desc, action, icon = '◇' }: { title: string; desc?: string; action?: React.ReactNode; icon?: string }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h4>{title}</h4>
      {desc && <p>{desc}</p>}
      {action}
    </div>
  )
}

export function Loading({ label = '加载中…' }: { label?: string }) {
  return <div className="loading"><span className="spinner" />{label}</div>
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box">
      <span>！</span>
      <div>{message}</div>
      {onRetry && <button className="btn sm" onClick={onRetry}>重试</button>}
    </div>
  )
}

export function PageHeader({ title, desc, actions, back }: { title: React.ReactNode; desc?: React.ReactNode; actions?: React.ReactNode; back?: () => void }) {
  return (
    <div className="page-head">
      <div className="page-head-main">
        {back && <button className="btn ghost sm" onClick={back}>← 返回</button>}
        <h1>{title}</h1>
        {desc && <p>{desc}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  )
}

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: React.ReactNode; badge?: number }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="tabs">
      {tabs.map(t => (
        <button key={t.key} className={`tab ${value === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}{t.badge !== undefined && <span className="tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  )
}

export function Kv({ items, columns = 2 }: { items: [string, React.ReactNode][]; columns?: number }) {
  return (
    <dl className="kv" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v || '—'}</dd></div>)}
    </dl>
  )
}

export function Progress({ value, tone = 'indigo' }: { value: number; tone?: string }) {
  return (
    <div className="progress"><div className={`progress-fill tone-${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>
  )
}

export function CopyButton({ text, label = '复制链接' }: { text: string; label?: string }) {
  const { push } = useToast()
  return (
    <button className="btn sm" onClick={async () => {
      try { await navigator.clipboard.writeText(text); push('已复制到剪贴板', 'success') }
      catch { push('复制失败，请手动选择文本', 'warn') }
    }}>{label}</button>
  )
}
