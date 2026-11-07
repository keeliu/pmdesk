import React, { useState } from 'react'
import { fmtTime, get, post } from '../../api'
import { Empty, ErrorBox, Field, Loading, Modal, Tag, useAsync, useToast } from '../../ui'

type Props = { reqId: string; detail: any; onRefresh: () => Promise<void> }

const GRADE_TONE: Record<string, string> = { '一般': 'gray', '中等': 'amber', '重大': 'red' }
const STATUS_TONE: Record<string, string> = {
  '待应用': 'blue', '待知会': 'amber', '待决定': 'red', '已应用': 'green',
  '已重新评审': 'violet', '已转新需求': 'teal'
}

export default function ChangePanel({ reqId, detail, onRefresh }: Props) {
  const toast = useToast()
  const changes = useAsync<any[]>(() => get(`/api/requirements/${reqId}/changes`), [reqId, detail.updated_at])
  const timeline = useAsync<any[]>(() => get(`/api/requirements/${reqId}/timeline`), [reqId, detail.updated_at])
  const [form, setForm] = useState({
    reason: '', content: '', grade: '', appsChanged: false, integrationChanged: false,
    acceptanceChanged: false, functionChanged: false
  })
  const [resolveFor, setResolveFor] = useState<any>(null)
  const [handling, setHandling] = useState('重新评审')
  const [gradeFor, setGradeFor] = useState<any>(null)
  const [gradeForm, setGradeForm] = useState({ grade: '', reason: '', exemption: '' })
  const [busy, setBusy] = useState('')

  const list = changes.data || []
  const canCreate = !['需求调研中', '已关闭', '已丢弃'].includes(detail.status)
  const isPm = ['pm', 'admin'].includes(detail.role)

  const autoGrade = (form.appsChanged || form.integrationChanged || form.acceptanceChanged)
    ? '重大' : form.functionChanged ? '中等' : '一般'
  const effectiveGrade = form.grade && ['一般', '中等', '重大'].indexOf(form.grade) > ['一般', '中等', '重大'].indexOf(autoGrade)
    ? form.grade : autoGrade

  const refresh = async () => {
    await onRefresh()
    await changes.reload()
    await timeline.reload()
  }

  const submit = async () => {
    if (!form.reason.trim() || !form.content.trim()) { toast.push('请填写变更原因与变更内容', 'warn'); return }
    setBusy('create')
    try {
      const r = await post<any>(`/api/requirements/${reqId}/changes`, { ...form, grade: form.grade || undefined })
      toast.push(`已发起变更 CHG-${String(r.seq || '').padStart(3, '0') || ''}（${r.grade}）`, 'success')
      setForm({ reason: '', content: '', grade: '', appsChanged: false, integrationChanged: false, acceptanceChanged: false, functionChanged: false })
      await refresh()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const act = async (c: any, action: string, body: any = {}) => {
    setBusy(c.id + action)
    try {
      await post(`/api/changes/${c.id}/${action}`, body)
      const label: Record<string, string> = { acknowledge: '知会确认完成', apply: '变更已应用', resolve: '处理方式已登记', grade: '分级已调整' }
      toast.push(label[action] || '操作成功', 'success')
      setResolveFor(null); setGradeFor(null)
      await refresh()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  if (changes.loading && !changes.data) return <Loading label="加载变更…" />
  if (changes.error) return <ErrorBox message={changes.error} onRetry={changes.reload} />

  return (
    <div className="stack">
      {canCreate ? (
        <div className="analysis-section">
          <header><h4>发起变更</h4><span>触及应用 / 集成点 / 验收口径将强制判为重大</span></header>
          <div className="body">
            <div className="mini-form">
              <Field label="变更原因" required>
                <input type="text" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="例如：业务方要求调整办理口径" />
              </Field>
              <Field label="变更内容" required>
                <textarea value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} placeholder="描述具体要改成什么、影响哪些页面或规则" style={{ minHeight: 70 }} />
              </Field>
              <div className="row wrap" style={{ gap: 14 }}>
                <label className="checkline"><input type="checkbox" checked={form.functionChanged} onChange={e => setForm(f => ({ ...f, functionChanged: e.target.checked }))} /><span>调整功能或原型</span></label>
                <label className="checkline"><input type="checkbox" checked={form.appsChanged} onChange={e => setForm(f => ({ ...f, appsChanged: e.target.checked }))} /><span>涉及应用变化</span></label>
                <label className="checkline"><input type="checkbox" checked={form.integrationChanged} onChange={e => setForm(f => ({ ...f, integrationChanged: e.target.checked }))} /><span>集成点变化</span></label>
                <label className="checkline"><input type="checkbox" checked={form.acceptanceChanged} onChange={e => setForm(f => ({ ...f, acceptanceChanged: e.target.checked }))} /><span>验收口径变化</span></label>
              </div>
              <div className="row wrap">
                <Field label="人工分级" hint="可上调，不可下调">
                  <select value={form.grade} onChange={e => setForm(f => ({ ...f, grade: e.target.value }))} style={{ minWidth: 140 }}>
                    <option value="">按规则自动判定</option>
                    <option value="一般">一般</option>
                    <option value="中等">中等</option>
                    <option value="重大">重大</option>
                  </select>
                </Field>
                <span className="tag" style={{ alignSelf: 'flex-end', marginBottom: 8 }}>将判定为：
                  <Tag tone={GRADE_TONE[effectiveGrade]}>{effectiveGrade}</Tag>
                </span>
                <button className="btn primary sm" style={{ alignSelf: 'flex-end', marginBottom: 6, marginLeft: 'auto' }} disabled={busy !== ''} onClick={submit}>提交变更</button>
              </div>
            </div>
            <div className="notice info mt8">
              一般变更确认后直接待应用；中等变更需评审人知会确认；重大变更不能直接应用，必须重新评审、重新登记或转为新需求。
            </div>
          </div>
        </div>
      ) : <div className="notice">当前状态「{detail.status}」不能发起变更。</div>}

      <div className="section-block">
        <h4>变更记录 <span className="tag tone-gray">{list.length}</span></h4>
        <div className="inner">
          {!list.length && <p className="muted small">暂无变更记录</p>}
          {list.map(c => (
            <div key={c.id} className="suggestion-item">
              <div className="sg-head">
                <div>
                  <div className="sg-title">CHG-{String(c.seq).padStart(3, '0')} · {c.reason}</div>
                  <div className="row wrap mt8">
                    <Tag tone={GRADE_TONE[c.grade] || 'gray'}>{c.grade}</Tag>
                    <Tag tone={STATUS_TONE[c.status] || 'gray'}>{c.status}</Tag>
                    {c.handling && <span className="tiny muted">处理：{c.handling}</span>}
                    <span className="tiny muted">{fmtTime(c.created_at)}</span>
                  </div>
                </div>
              </div>
              <div className="sg-detail">{c.content}</div>
              {c.impact?.notes?.length > 0 && (
                <div className="row wrap mt8">{c.impact.notes.map((n: string) => <span key={n} className="tiny muted">· {n}</span>)}</div>
              )}
              <div className="sg-actions">
                {c.status === '待知会' && <button className="btn sm primary" disabled={busy !== ''} onClick={() => act(c, 'acknowledge')}>知会确认</button>}
                {c.status === '待应用' && <button className="btn sm primary" disabled={busy !== ''} onClick={() => act(c, 'apply')}>应用变更</button>}
                {c.status === '待决定' && isPm && (
                  <button className="btn sm primary" onClick={() => { setResolveFor(c); setHandling('重新评审') }}>选择处理方式</button>
                )}
                {['待应用', '待知会', '待决定'].includes(c.status) && (
                  <button className="btn sm" onClick={() => { setGradeFor(c); setGradeForm({ grade: c.grade, reason: '', exemption: '' }) }}>调整分级</button>
                )}
                {c.resolved_at && <span className="tiny muted">处理于 {fmtTime(c.resolved_at)}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="section-block">
        <h4>需求动态</h4>
        <div className="inner">
          <div className="timeline">
            {(timeline.data || []).slice(0, 40).map((e: any) => (
              <div key={e.id} className={`timeline-item ${['status', 'confirm', 'review-conclude', 'change', 'spec-publish'].includes(e.type) ? 'strong' : ''}`}>
                <div className="t-main">{e.message}</div>
                <div className="t-meta">{e.actorName || '系统'} · {fmtTime(e.created_at)}</div>
              </div>
            ))}
            {!timeline.data?.length && <p className="muted small">暂无动态</p>}
          </div>
        </div>
      </div>

      {resolveFor && (
        <Modal title="处理重大变更" subtitle={`CHG-${String(resolveFor.seq).padStart(3, '0')} · ${resolveFor.reason}`} onClose={() => setResolveFor(null)}
          footer={<>
            <button className="btn" onClick={() => setResolveFor(null)}>取消</button>
            <button className="btn primary" disabled={busy !== ''} onClick={() => act(resolveFor, 'resolve', { handling })}>确认处理</button>
          </>}>
          <div className="stack">
            <Field label="处理方式" required>
              <select value={handling} onChange={e => setHandling(e.target.value)}>
                <option value="重新评审">重新评审（需求回到需求评审中）</option>
                <option value="重新登记">重新登记（派生新需求，回到需求调研中）</option>
                <option value="转新需求">转新需求（派生新需求，回到需求调研中）</option>
              </select>
            </Field>
            <div className="notice">
              重新评审会把需求退回需求评审中；重新登记与转新需求会派生一条需求调研中的需求，原需求保留变更记录。重大变更不能直接应用。
            </div>
          </div>
        </Modal>
      )}

      {gradeFor && (
        <Modal title="调整变更分级" subtitle={`${gradeFor.grade} → ${gradeForm.grade}（只能上调，管理员下调需豁免说明）`} onClose={() => setGradeFor(null)}
          footer={<>
            <button className="btn" onClick={() => setGradeFor(null)}>取消</button>
            <button className="btn primary" disabled={busy !== ''} onClick={() => act(gradeFor, 'grade', gradeForm)}>保存分级</button>
          </>}>
          <div className="stack">
            <Field label="目标分级" required>
              <select value={gradeForm.grade} onChange={e => setGradeForm(f => ({ ...f, grade: e.target.value }))}>
                {['一般', '中等', '重大'].map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
            {['一般', '中等', '重大'].indexOf(gradeForm.grade) < ['一般', '中等', '重大'].indexOf(gradeFor.grade) && (
              <Field label="豁免说明" hint="下调仅管理员可操作，且必须说明理由">
                <textarea value={gradeForm.exemption} onChange={e => setGradeForm(f => ({ ...f, exemption: e.target.value }))} style={{ minHeight: 60 }} />
              </Field>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}
