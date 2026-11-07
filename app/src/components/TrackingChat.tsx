import React, { useEffect, useRef, useState } from 'react'
import { fmtTime, get, post } from '../api'
import { Tag, useAsync, useToast } from '../ui'

type Props = {
  projectId: string
  iterations?: { id: string; name: string }[]
  iterationId?: string
  disabled?: boolean
  onApplied?: () => Promise<void> | void
}

const STATUS_LABEL: Record<string, string> = { pending: '待确认', applied: '已应用', discarded: '已忽略' }

export default function TrackingChat({ projectId, iterations = [], iterationId: initialIteration, disabled = false, onApplied }: Props) {
  const toast = useToast()
  const chat = useAsync<any>(() => get(`/api/projects/${projectId}/tracking-chat`), [projectId])
  const [draft, setDraft] = useState('')
  const [iterationId, setIterationId] = useState(initialIteration || '')
  const [sending, setSending] = useState(false)
  const [busy, setBusy] = useState('')
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [chat.data?.messages?.length, sending])

  const send = async () => {
    const message = draft.trim()
    if (!message) return
    setSending(true)
    try {
      const r = await post<any>(`/api/projects/${projectId}/tracking-chat`, { message, iterationId: iterationId || undefined })
      setDraft('')
      toast.push(r.proposal ? '已生成更新提案，确认后才会执行' : '已回复', r.proposal ? 'info' : 'success')
      await chat.reload()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setSending(false) }
  }

  const applyProposal = async (p: any) => {
    setBusy(p.id)
    try {
      const r = await post<any>(`/api/project-proposals/${p.id}/apply`, {})
      toast.push(`提案已执行：成功 ${r.result.success.length} 条，失败 ${r.result.failed.length} 条`, r.result.failed.length ? 'warn' : 'success')
      await chat.reload()
      await onApplied?.()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const discardProposal = async (p: any) => {
    setBusy(p.id)
    try {
      await post(`/api/project-proposals/${p.id}/discard`, {})
      toast.push('提案已忽略', 'info')
      await chat.reload()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const messages = chat.data?.messages || []
  const proposals = chat.data?.proposals || []
  const proposalOf = (id: string) => proposals.find((p: any) => p.id === id)

  return (
    <div className="tracking-chat-inner">
      <div className="card-head" style={{ padding: '12px 14px' }}>
        <div>
          <h3>跟进会话</h3>
          <p>查询状态、生成批量更新提案；会话不会直接写库</p>
        </div>
        <Tag tone="indigo">AI</Tag>
      </div>
      {!disabled && iterations.length > 0 && (
        <div style={{ padding: '0 14px 8px' }}>
          <select style={{ width: '100%' }} value={iterationId} onChange={e => setIterationId(e.target.value)}>
            <option value="">范围：全部需求</option>
            {iterations.map(it => <option key={it.id} value={it.id}>范围：{it.name}</option>)}
          </select>
        </div>
      )}
      <div className="chat-scroll" ref={scroller} style={{ padding: '10px 14px' }}>
        {chat.loading && <p className="muted small">正在加载会话…</p>}
        {!chat.loading && !messages.length && (
          <div className="notice info">
            用自然语言查询或推进状态。例如「当前迭代有哪些风险」「把迭代内开发中的需求统一推进到待测试验证，生效时间 2026-10-20」。
          </div>
        )}
        {messages.map((m: any) => {
          const p = m.proposal_id ? proposalOf(m.proposal_id) : null
          return (
            <div key={m.id} className={`msg ${m.role === 'user' ? 'user' : ''}`}>
              <span className="avatar sm">{m.role === 'user' ? (m.created_by_name || '我').slice(0, 1) : 'AI'}</span>
              <div className="msg-wrap">
                <div className="who">{m.role === 'user' ? (m.created_by_name || '我') : '需求助手'} · {fmtTime(m.created_at)}</div>
                <div className="bubble">{m.content}</div>
                {p && (
                  <div className={`proposal-card ${p.status !== 'pending' ? 'applied' : ''}`}>
                    <div className="pc-head">
                      <span>提案 · 批量状态更新</span>
                      <span className="tag tone-gray">{STATUS_LABEL[p.status] || p.status}</span>
                    </div>
                    <div className="pc-summary">
                      目标「{p.payload?.to}」，范围 {p.payload?.iterationName ? `迭代「${p.payload.iterationName}」` : '全部需求'}，
                      {(p.diff || []).filter((x: any) => x.ok).length} 条可更新，{(p.diff || []).filter((x: any) => !x.ok).length} 条受阻。
                    </div>
                    {p.diff?.length > 0 && (
                      <details className="mt8">
                        <summary className="small muted" style={{ cursor: 'pointer' }}>查看逐条门禁</summary>
                        <div className="stack mt8" style={{ gap: 4 }}>
                          {p.diff.map((x: any) => (
                            <div key={x.id} className="row small wrap">
                              <span className="code">{x.code || '未编号'}</span>
                              <span className="truncate grow">{x.title}</span>
                              <Tag tone={x.ok ? 'green' : 'red'}>{x.ok ? '可更新' : x.issues.join('；')}</Tag>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {p.status === 'pending' && !disabled && (
                      <div className="pc-actions">
                        <button className="btn sm primary" disabled={busy !== ''} onClick={() => applyProposal(p)}>确认执行</button>
                        <button className="btn sm ghost" disabled={busy !== ''} onClick={() => discardProposal(p)}>忽略</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        {sending && <p className="muted small">正在处理…</p>}
      </div>
      <div className="chat-composer">
        <div className="composer-box">
          <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} disabled={disabled || sending}
            placeholder={disabled ? '已发布迭代不可变更状态' : '例如：把迭代内评审中需求统一推进到开发中'}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
          <button className="btn primary" disabled={disabled || sending || !draft.trim()} onClick={send}>{sending ? '处理中…' : '发送'}</button>
        </div>
      </div>
    </div>
  )
}
