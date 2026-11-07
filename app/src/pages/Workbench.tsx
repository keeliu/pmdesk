import React, { useCallback, useEffect, useRef, useState } from 'react'
import { downloadUrl, fmtDay, fmtTime, get, navigate, patch, post } from '../api'
import { CopyButton, ErrorBox, Field, Loading, Modal, StatusTag, useAsync, useToast } from '../ui'
import type { Session } from '../App'
import ChatPanel from '../components/ChatPanel'
import ClarifyView from '../components/workbench/ClarifyView'
import AnalysisView from '../components/workbench/AnalysisView'
import PrototypePanel from '../components/workbench/PrototypePanel'
import ReviewPanel from '../components/workbench/ReviewPanel'
import ChangePanel from '../components/workbench/ChangePanel'
import { PRIORITY_TONE, type Any } from '../api'
import { STATUS_INDEX, statusLabel } from '../status'

type Props = {
  projectId: string
  reqId: string
  stage: string
  session: Session
  projectRole: string
  projects: Any[]
  onProjectsChange: () => Promise<void>
}

const STAGES = [
  { key: 'clarify', label: '需求澄清', num: '1' },
  { key: 'analysis', label: '需求分析', num: '2' },
  { key: 'prototype', label: '原型输出', num: '3' },
  { key: 'review', label: '需求评审', num: '4' },
  { key: 'change', label: '需求调整', num: '5' }
]

const DEVELOPER_TARGETS = ['待测试验证', '测试验证中', '开发中', '待UAT']

export default function Workbench({ projectId, reqId, stage, session, projectRole, projects, onProjectsChange }: Props) {
  const toast = useToast()
  const detail = useAsync<any>(() => get(`/api/requirements/${reqId}`), [reqId])
  const messages = useAsync<any>(() => get(`/api/requirements/${reqId}/messages`), [reqId])
  const [statusOpen, setStatusOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [msOpen, setMsOpen] = useState(false)
  const [briefOpen, setBriefOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [share, setShare] = useState<any>(null)
  const [statusForm, setStatusForm] = useState({ to: '', note: '' })

  const active = STAGES.some(s => s.key === stage) ? stage : 'clarify'

  const refreshAll = useCallback(async () => {
    await Promise.all([detail.reload(), messages.reload()])
  }, [detail.reload, messages.reload])

  if (detail.loading && !detail.data) return <div style={{ padding: 40 }}><Loading label="加载需求…" /></div>
  if (detail.error) return <div style={{ padding: 24 }}><ErrorBox message={detail.error} onRetry={detail.reload} /></div>

  const d = detail.data
  if (!d) return null

  const goStage = (next: string) => navigate(`/p/${projectId}/req/${reqId}/${next}`)

  const doneOf = (key: string) => {
    if (key === 'clarify') return d.status !== '需求调研中'
    if (key === 'analysis') return (d.versions?.length || 0) > 0
    if (key === 'prototype') return d.prototype?.status === 'confirmed'
    if (key === 'review') return d.latestReview?.conclusion === '通过'
    return (STATUS_INDEX[d.status] ?? 0) >= 4 || d.status === '已关闭'
  }

  const advance = async () => {
    if (!statusForm.to) return
    setBusy('status')
    try {
      await post(`/api/requirements/${reqId}/status`, { to: statusForm.to, note: statusForm.note })
      toast.push(`已流转到 ${statusForm.to === '恢复' ? statusLabel(d.suspendedFrom || '原状态') : statusLabel(statusForm.to)}`, 'success')
      setStatusOpen(false)
      setStatusForm({ to: '', note: '' })
      await refreshAll()
      await onProjectsChange()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const createShare = async () => {
    setBusy('share')
    try {
      const s = await post<any>(`/api/projects/${projectId}/shares`, { objectType: 'requirement', objectId: reqId, days: 7 })
      setShare(s)
      toast.push('分享链接已生成，7 天内有效', 'success')
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const serverTransitions = (d.transitions || []).map((t: any) => t.status)
  const transitions = projectRole === 'developer'
    ? serverTransitions.filter((s: string) => DEVELOPER_TARGETS.includes(s))
    : serverTransitions
  const shareUrl = share ? `${location.origin}${location.pathname}#/public/${share.token}` : ''

  const panels: Record<string, React.ReactNode> = {
    clarify: <ClarifyView reqId={reqId} detail={d} onRefresh={refreshAll} />,
    analysis: <AnalysisView reqId={reqId} detail={d} onRefresh={refreshAll} />,
    prototype: <PrototypePanel reqId={reqId} detail={d} onRefresh={refreshAll} />,
    review: <ReviewPanel reqId={reqId} detail={d} onRefresh={refreshAll} />,
    change: <ChangePanel reqId={reqId} detail={d} onRefresh={refreshAll} />
  }

  const briefText = requirementBrief(d)
  const briefRequester = d.snapshot?.requester || d.requester || null
  const briefRequesterText = [briefRequester?.enterprise, briefRequester?.department, briefRequester?.name].filter(Boolean).join(' / ')
  const briefApps = (d.involvedApps || []).map((a: any) => a?.name).filter(Boolean).join('、')
  const briefMeta = [
    d.source?.fileName && { label: '来源文件', value: d.source.fileName },
    briefRequesterText && { label: '提出方', value: briefRequesterText },
    briefApps && { label: '涉及应用', value: briefApps },
    d.confirmed_at && { label: '确认时间', value: fmtTime(d.confirmed_at) },
    d.snapshot?.confirmedBy && { label: '确认人', value: d.snapshot.confirmedBy }
  ].filter(Boolean) as { label: string; value: string }[]

  return (
    <div className="wb">
      <div className="wb-head">
        <button className="btn ghost sm" onClick={() => navigate(`/p/${projectId}/pool`)}>← 需求池</button>
        <div className="wb-title">
          {d.code ? <span className="code">{d.code}</span> : <span className="tag tone-gray">未编号</span>}
          <h2 className="truncate">{d.title}</h2>
          <StatusTag status={d.status} />
          {d.priority?.grade && <span className={`tag tone-${PRIORITY_TONE[d.priority.grade] || 'gray'}`}>{d.priority.gradeLabel || d.priority.grade}</span>}
          {d.status === '挂起' && d.suspendedFrom && <span className="tag tone-brown">原：{statusLabel(d.suspendedFrom)}</span>}
          {nextMilestone(d.milestones) && (
            <span className={`tag tone-${nextMilestone(d.milestones).overdue ? 'red' : 'blue'}`}>
              {nextMilestone(d.milestones).label} {fmtDay(nextMilestone(d.milestones).plan || nextMilestone(d.milestones).actual)}
            </span>
          )}
          <span className="muted tiny">PM {d.milestones?.productManager || '未指定'}</span>
        </div>
        <div className="wb-head-actions">
          {d.related?.length > 0 && (
            <details style={{ position: 'relative' }}>
              <summary className="btn sm" style={{ listStyle: 'none' }}>相关需求 {d.related.length}</summary>
              <div className="card" style={{ position: 'absolute', right: 0, top: 36, width: 300, zIndex: 30, padding: 8 }}>
                {d.related.map((r: any) => (
                  <button key={r.id} className="account" style={{ width: '100%' }} onClick={() => navigate(`/p/${projectId}/req/${r.id}/analysis`)}>
                    <span className="meta"><strong>{r.code || r.title}</strong><span>{r.code ? r.title : r.status}</span></span>
                  </button>
                ))}
              </div>
            </details>
          )}
          <button className="btn sm" onClick={() => navigate(`/p/${projectId}/requirements/${reqId}`)}>需求详情</button>
          {['pm', 'admin', 'developer'].includes(projectRole) && <button className="btn sm" onClick={() => setMsOpen(true)}>里程碑</button>}
          {d.source?.fileName && <button className="btn sm" onClick={() => downloadUrl(`/api/requirements/${reqId}/source-file`)}>原始文件</button>}
          <button className="btn sm" onClick={() => setShareOpen(true)}>分享</button>
          {transitions.length > 0 && (
            <button className="btn sm primary" onClick={() => { setStatusForm({ to: transitions[0], note: '' }); setStatusOpen(true) }}>状态推进</button>
          )}
        </div>
      </div>

      <div className="stage-rail">
        {STAGES.map(s => (
          <button key={s.key} className={`stage-btn ${active === s.key ? 'active' : ''}`} onClick={() => goStage(s.key)}>
            <span className="stage-num">{doneOf(s.key) && active !== s.key ? '✓' : s.num}</span>
            {s.label}
          </button>
        ))}
      </div>

      <div className="wb-body">
        <div className="wb-chat">
          <ChatPanel reqId={reqId} stage={active} detail={d} messages={messages}
            session={session} onRefreshAll={refreshAll} />
        </div>
        <div className="wb-preview">
          <div className="preview-sticky">
            <div className="preview-head">
              <strong style={{ fontSize: 13.5 }}>{STAGES.find(s => s.key === active)?.label}预览</strong>
              <span className="readonly-badge">只读 · 通过左侧会话修改</span>
              <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={refreshAll}>刷新</button>
            </div>
            {active !== 'clarify' && <PinnedBrief text={briefText} onOpen={() => setBriefOpen(true)} />}
          </div>
          <div className="preview-body">{panels[active]}</div>
        </div>
      </div>

      {statusOpen && (
        <Modal title="推进需求状态" subtitle={`当前：${statusLabel(d.status)}${d.code ? ` · ${d.code}` : ''}`} onClose={() => setStatusOpen(false)}
          footer={<>
            <button className="btn" onClick={() => setStatusOpen(false)}>取消</button>
            <button className="btn primary" disabled={!statusForm.to || busy === 'status'} onClick={advance}>确认推进</button>
          </>}>
          <div className="stack">
            <Field label="目标状态" required>
              <select value={statusForm.to} onChange={e => setStatusForm(f => ({ ...f, to: e.target.value }))}>
                {transitions.map(t => <option key={t} value={t}>{t === '恢复' ? `恢复为 ${statusLabel(d.suspendedFrom || '原状态')}` : statusLabel(t)}</option>)}
              </select>
            </Field>
            <Field label="说明" hint={statusForm.to === '挂起' ? '挂起必须填写原因' : '可选'}>
              <textarea value={statusForm.note} onChange={e => setStatusForm(f => ({ ...f, note: e.target.value }))}
                placeholder="例如：等待上游系统提供接口" />
            </Field>
            <div className="notice info">
              状态推进仍会经过服务端门禁校验：进入需求评审中需原型已确认且说明书已发布；进入待开发需评审通过且建议全部闭环；进入开发中、待测试验证、待试点分别需要技术、测试、实施负责人。
            </div>
          </div>
        </Modal>
      )}

      {msOpen && (
        <MilestoneModal reqId={reqId} detail={d} onClose={() => setMsOpen(false)}
          onSaved={async () => { setMsOpen(false); await refreshAll() }} />
      )}

      {briefOpen && (
        <Modal title="需求描述" subtitle={`${d.code || '未编号'} · ${d.title}`} wide onClose={() => setBriefOpen(false)}
          footer={<button className="btn" onClick={() => setBriefOpen(false)}>关闭</button>}>
          <div className="stack">
            <p className="small" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{briefText}</p>
            {briefMeta.length > 0 && (
              <div className="stack" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                {briefMeta.map(m => <KvLine key={m.label} label={m.label} value={m.value} />)}
              </div>
            )}
          </div>
        </Modal>
      )}

      {shareOpen && (
        <Modal title="生成只读分享链接" subtitle={`${d.code || '未编号'} · ${d.title}`} onClose={() => { setShareOpen(false); setShare(null) }}
          footer={<>
            <button className="btn" onClick={() => { setShareOpen(false); setShare(null) }}>关闭</button>
            {!share && <button className="btn primary" disabled={busy === 'share'} onClick={createShare}>生成 7 天链接</button>}
            {share && <CopyButton text={shareUrl} label="复制链接" />}
          </>}>
          {!share ? (
            <div className="stack">
              <p className="small muted">链接面向外部干系人，只能查看澄清结论、四段分析、当前说明书与原型，不能进行任何写操作，链接 7 天后自动失效。</p>
              <div className="notice">分享内容包含当前已发布版本，生成后不可随需求变更实时更新。</div>
            </div>
          ) : (
            <div className="stack">
              <div className="share-url">{shareUrl}</div>
              <KvLine label="有效期至" value={fmtTime(share.expiresAt)} />
              <div className="notice info">可直接在浏览器中打开预览，或复制给评审相关方。</div>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}

function nextMilestone(ms: any) {
  if (!ms?.fields) return null
  return ms.fields.find((f: any) => f.plan && !f.actual) || ms.fields.find((f: any) => !f.actual) || null
}

function requirementBrief(d: any) {
  const snapshot = d.snapshot || {}
  const source = d.source || {}
  const answers = d.clarification?.answers || {}
  const clarified = ['goal', 'scope', 'boundary'].map(k => answers[k]?.value).filter(Boolean).join('\n')
  return String(snapshot.sourceExcerpt || source.excerpt || source.fullText || clarified || '').trim()
    || '暂无需求描述，可在澄清环节补充。'
}

function PinnedBrief({ text, onOpen }: { text: string; onOpen: () => void }) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [overflow, setOverflow] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setOverflow(el.scrollHeight > el.clientHeight + 1 || text.length > 90)
    check()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null
    observer?.observe(el)
    window.addEventListener('resize', check)
    return () => { observer?.disconnect(); window.removeEventListener('resize', check) }
  }, [text])
  return (
    <div className="preview-brief">
      <p ref={ref} className="brief-text">{text}</p>
      {overflow && <button className="btn sm ghost" onClick={onOpen}>查看详情</button>}
    </div>
  )
}

function MilestoneModal({ reqId, detail, onClose, onSaved }: any) {
  const toast = useToast()
  const fields = detail.milestoneFields || []
  const ms = detail.milestones || {}
  const [pm, setPm] = useState(ms.productManager || '')
  const [actual, setActual] = useState<any>(Object.fromEntries(fields.map((f: any) => [f.key, (ms[f.key] || '').slice(0, 16)])))
  const [plan, setPlan] = useState<any>(Object.fromEntries(fields.map((f: any) => [f.key, (ms.plan?.[f.key] || '').slice(0, 16)])))
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await patch(`/api/requirements/${reqId}/milestones`, {
        productManager: pm,
        ...actual,
        plan
      })
      toast.push('里程碑已更新', 'success')
      await onSaved()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <Modal title="里程碑与产品经理" subtitle="实际时间按顺序校验；进入待上线发版与全国推广前会检查必要节点" onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={save}>保存</button></>}>
      <div className="form-grid">
        <div className="wide"><Field label="产品经理"><input type="text" value={pm} onChange={e => setPm(e.target.value)} placeholder="负责该需求的产品经理姓名" /></Field></div>
        {fields.map((f: any) => (
          <React.Fragment key={f.key}>
            <Field label={f.label} hint={ms.overdue?.some((o: any) => o.field === f.key) ? '计划已逾期' : undefined}>
              <input type="datetime-local" value={actual[f.key] || ''} onChange={e => setActual({ ...actual, [f.key]: e.target.value })} />
            </Field>
            <Field label={`计划${f.label}`}>
              <input type="datetime-local" value={plan[f.key] || ''} onChange={e => setPlan({ ...plan, [f.key]: e.target.value })} />
            </Field>
          </React.Fragment>
        ))}
      </div>
      <div className="notice info mt12">六个完成时间按顺序校验；推进到待开发、待测试验证、待UAT、待试点、待上线发版、全国推广中时会自动回填对应时间。回退时自动回填值会被清除，人工登记值标记待复核。</div>
    </Modal>
  )
}

function KvLine({ label, value }: { label: string; value: string }) {
  return <div className="row small"><span className="muted" style={{ width: 78 }}>{label}</span><span>{value}</span></div>
}
