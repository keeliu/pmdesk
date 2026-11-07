import React, { useEffect, useRef, useState } from 'react'
import { post } from '../api'
import { useToast } from '../ui'
import type { Session } from '../App'

type Props = {
  reqId: string
  stage: string
  detail: any
  messages: any
  session: Session
  onRefreshAll: () => Promise<void>
}

const QUICK: Record<string, { label: string; text: string; send?: boolean }[]> = {
  clarify: [
    { label: '角色与岗位', text: '角色：业务发起人提出、运营人员使用、业务管理员审批' },
    { label: '目标与价值', text: '目标：减少人工处理时间并补齐缺失能力' },
    { label: '范围', text: '范围：本期覆盖核心流程与配置能力' },
    { label: '边界', text: '边界：本期不做历史数据迁移' },
    { label: '验收口径', text: '验收：关键流程可完整走通' },
    { label: '涉及应用', text: '涉及应用：' },
    { label: '确认入池', text: '确认需求，进入需求池', send: true }
  ],
  analysis: [
    { label: '生成分析初稿', text: '生成需求分析初稿', send: true },
    { label: '新增功能', text: '新增功能「导出报表」', send: true },
    { label: '补充验收', text: '补充验收标准：关键流程可完整走通，异常场景有明确提示', send: true },
    { label: '新增集成点', text: '对接消息中心', send: true },
    { label: '调整目标', text: '目标改为：支撑业务全流程线上化' , send: true }
  ],
  prototype: [
    { label: '生成原型', text: '生成界面原型', send: true },
    { label: '新增页面', text: '调整原型：新增页面「审批详情」', send: true },
    { label: '改为表格', text: '调整原型：页面改为表格布局', send: true },
    { label: '确认原型', text: '确认原型定稿', send: true },
    { label: '生成说明书', text: '生成需求分析说明书', send: true },
    { label: '发布说明书', text: '发布说明书', send: true }
  ],
  review: [
    { label: '评审意见', text: '评审意见：功能设计的验收口径需要补充异常分支' },
    { label: '关闭建议', text: '关闭建议', send: true },
    { label: '发起变更', text: '变更：验收口径调整为客户可自助办理' },
    { label: '进入开发', text: '进入开发', send: true }
  ],
  change: [
    { label: '发起变更', text: '变更：验收口径调整为客户可自助办理' },
    { label: '提交验收', text: '提交验收', send: true },
    { label: '上线', text: '上线', send: true },
    { label: '关闭需求', text: '关闭需求', send: true },
    { label: '关联需求', text: '关联相关需求', send: true }
  ]
}

const STATUS_LABEL: Record<string, string> = { pending: '待确认', applied: '已应用', discarded: '已忽略' }

export default function ChatPanel({ reqId, stage, detail, messages, session, onRefreshAll }: Props) {
  const toast = useToast()
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [engine, setEngine] = useState('')
  const [busy, setBusy] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [messages.data?.messages?.length, sending])

  const send = async (text?: string) => {
    const message = (text ?? draft).trim()
    if (!message) return
    setSending(true)
    try {
      const res = await post<any>(`/api/requirements/${reqId}/chat`, { message, stage })
      setDraft('')
      setEngine(res.engine)
      await messages.reload()
      if (res.proposal) toast.push('已生成提案，确认后才会写入', 'info')
    } catch (e: any) { toast.push(e.message, 'error') } finally { setSending(false) }
  }

  const applyProposal = async (p: any) => {
    setBusy(p.id)
    try {
      const r = await post<any>(`/api/proposals/${p.id}/apply`, {})
      const result = r.result || {}
      if (result.saved === false) {
        const errors = (result.quality?.issues || []).filter((i: any) => i.level === 'error').map((i: any) => i.message)
        toast.push(result.message || `分析未通过质量门禁，未写入版本${errors.length ? `：${errors.join('；')}` : ''}`, 'warn')
      } else if (result.version) {
        const warnings = (result.quality?.issues || []).filter((i: any) => i.level === 'warn').length
        toast.push(`已写入分析 V${result.version}${warnings ? `（${warnings} 条建议待处理）` : '，质量门禁通过'}`, 'success')
      } else if (result.message) {
        toast.push(result.message, 'success')
      } else {
        toast.push('提案已应用', 'success')
      }
      await messages.reload()
      await onRefreshAll()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const discardProposal = async (p: any) => {
    setBusy(p.id)
    try {
      await post(`/api/proposals/${p.id}/discard`, {})
      await messages.reload()
      toast.push('提案已忽略', 'info')
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const list = messages.data?.messages || []
  const quick = QUICK[stage] || QUICK.analysis

  return (
    <>
      <div className="chat-scroll" ref={scroller}>
        {messages.loading && <p className="muted small">正在加载会话…</p>}
        {!list.length && !messages.loading && (
          <div className="notice info">
            用自然语言描述你的意图。例如「角色：运营人员独立完成」「生成需求分析初稿」「新增功能『导出报表』」。
            所有写操作先生成提案，点「应用」才会落库。
          </div>
        )}
        {list.map((m: any) => (
          <div key={m.id} className={`msg ${m.role === 'user' ? 'user' : ''}`}>
            <span className="avatar sm">{m.role === 'user' ? session.user!.name.slice(0, 1) : 'AI'}</span>
            <div className="msg-wrap">
              <div className="who">{m.role === 'user' ? session.user!.name : '需求助手'}</div>
              <div className="bubble">{m.content}</div>
              {m.proposal && (
                <div className={`proposal-card ${m.proposal.status !== 'pending' ? 'applied' : ''}`}>
                  <div className="pc-head">
                    <span>提案 · {m.proposal.label || m.proposal.action}</span>
                    <span className="tag tone-gray">{STATUS_LABEL[m.proposal.status] || m.proposal.status}</span>
                  </div>
                  <div className="pc-summary">{m.proposal.diff?.summary || m.proposal.summary}</div>
                  {m.proposal.payload && Object.keys(m.proposal.payload).length > 0 && (
                    <details className="mt8">
                      <summary className="small muted" style={{ cursor: 'pointer' }}>查看参数</summary>
                      <pre className="mono mt8" style={{ whiteSpace: 'pre-wrap', background: '#fff', padding: 8, borderRadius: 6, border: '1px solid var(--line)' }}>{JSON.stringify(m.proposal.payload, null, 2)}</pre>
                    </details>
                  )}
                  {m.proposal.status === 'pending' && (
                    <div className="pc-actions">
                      <button className="btn sm primary" disabled={busy === m.proposal.id} onClick={() => applyProposal(m.proposal)}>应用提案</button>
                      <button className="btn sm" disabled={busy === m.proposal.id} onClick={() => discardProposal(m.proposal)}>忽略</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {sending && <div className="msg"><span className="avatar sm">AI</span><div className="msg-wrap"><div className="who">需求助手</div><div className="bubble"><span className="spinner" /> 思考中…</div></div></div>}
      </div>

      <div className="chat-composer">
        <div className="quick-chips">
          {quick.map(q => (
            <button key={q.label} className="quick-chip" onClick={() => {
              if (q.send) send(q.text)
              else { setDraft(q.text); inputRef.current?.focus() }
            }}>{q.label}</button>
          ))}
        </div>
        <div className="composer-box">
          <textarea ref={inputRef} value={draft} placeholder="描述你要做的事，Enter 发送，Shift+Enter 换行"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            }} />
          <button className="btn primary" disabled={sending || !draft.trim()} onClick={() => send()}>发送</button>
        </div>
        <div className="engine-note">
          <span>{engine ? `最近一次：${engine === 'model' ? '模型引擎' : '规则引擎'}` : '写操作均生成提案，确认后生效'}</span>
          <span>需求状态：{detail?.status || '—'}</span>
        </div>
      </div>
    </>
  )
}
