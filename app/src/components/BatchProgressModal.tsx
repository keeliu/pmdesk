import React, { useState } from 'react'
import { post } from '../api'
import { Field, Loading, Modal, Tag, useToast } from '../ui'

const LEAD_FIELDS = [
  { key: 'productManager', label: '产品经理' },
  { key: 'tech', label: '技术负责人' },
  { key: 'test', label: '测试负责人' },
  { key: 'implementation', label: '实施负责人' }
]

const MILESTONE_FIELDS = [
  { key: 'reviewedAt', label: '评审完成时间' },
  { key: 'submittedAt', label: '开发完成时间' },
  { key: 'testedAt', label: '完成测试验证时间' },
  { key: 'uatAt', label: '完成 UAT 时间' },
  { key: 'pilotAt', label: '完成试点时间' },
  { key: 'releasedAt', label: '上线推广时间' }
]

type Props = {
  projectId: string
  requirementIds?: string[]
  iterationId?: string
  scopeLabel: string
  onClose: () => void
  onDone?: () => Promise<void> | void
}

export default function BatchProgressModal({ projectId, requirementIds, iterationId, scopeLabel, onClose, onDone }: Props) {
  const toast = useToast()
  const [leads, setLeads] = useState<Record<string, string>>({})
  const [actual, setActual] = useState<Record<string, string>>({})
  const [plan, setPlan] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [preview, setPreview] = useState<any>(null)
  const [result, setResult] = useState<any>(null)
  const [busy, setBusy] = useState('')

  const payload = () => {
    const body: any = {}
    if (requirementIds?.length) body.requirementIds = requirementIds
    else if (iterationId) body.iterationId = iterationId
    const leadPatch: Record<string, string> = {}
    for (const f of LEAD_FIELDS) if (leads[f.key] !== undefined && leads[f.key] !== '') leadPatch[f.key] = leads[f.key].trim()
    const milestonePatch: any = {}
    for (const f of MILESTONE_FIELDS) if (actual[f.key]) milestonePatch[f.key] = actual[f.key]
    const planPatch: any = {}
    for (const f of MILESTONE_FIELDS) if (plan[f.key]) planPatch[f.key] = plan[f.key]
    if (Object.keys(planPatch).length) milestonePatch.plan = planPatch
    if (Object.keys(leadPatch).length) body.leads = leadPatch
    if (Object.keys(milestonePatch).length) body.milestones = milestonePatch
    if (note.trim()) body.note = note.trim()
    return body
  }

  const touched = () => Boolean(payload().leads || payload().milestones)

  const runPreview = async () => {
    if (!touched()) { toast.push('请至少填写一项负责人或完成时间', 'warn'); return }
    setBusy('preview')
    try {
      const r = await post<any>(`/api/projects/${projectId}/requirements/batch-progress/preview`, payload())
      setPreview(r)
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const submit = async () => {
    setBusy('apply')
    try {
      const r = await post<any>(`/api/projects/${projectId}/requirements/batch-progress`, payload())
      setResult(r)
      toast.push(`批量维护完成：成功 ${r.success.length} 条，失败 ${r.failed.length} 条`, r.failed.length ? 'warn' : 'success')
      await onDone?.()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  return (
    <Modal title="批量维护进展" subtitle={scopeLabel} onClose={onClose} wide
      footer={result
        ? <button className="btn primary" onClick={onClose}>完成</button>
        : preview
          ? <><button className="btn" onClick={() => setPreview(null)}>返回修改</button>
            <button className="btn primary" disabled={busy === 'apply' || !preview.ok} onClick={submit}>{busy === 'apply' ? '执行中…' : `确认执行（可执行 ${preview.ok} 条）`}</button></>
          : <><button className="btn" onClick={onClose}>取消</button>
            <button className="btn primary" disabled={busy === 'preview'} onClick={runPreview}>{busy === 'preview' ? '校验中…' : '校验并预览'}</button></>}>
      {!preview && !result && (
        <div className="stack">
          <div className="notice info">只提交填写的项，留空表示不修改。逐条按时间顺序与门禁校验，允许部分成功。</div>
          <div className="form-grid">
            {LEAD_FIELDS.map(f => (
              <Field key={f.key} label={f.label} hint="留空不修改">
                <input type="text" value={leads[f.key] || ''} placeholder="统一设置负责人"
                  onChange={e => setLeads({ ...leads, [f.key]: e.target.value })} />
              </Field>
            ))}
          </div>
          <div className="muted small">实际完成时间（留空不修改）</div>
          <div className="form-grid">
            {MILESTONE_FIELDS.map(f => (
              <Field key={f.key} label={f.label}>
                <input type="datetime-local" value={actual[f.key] || ''} onChange={e => setActual({ ...actual, [f.key]: e.target.value })} />
              </Field>
            ))}
          </div>
          <div className="muted small">计划时间（留空不修改）</div>
          <div className="form-grid">
            {MILESTONE_FIELDS.map(f => (
              <Field key={f.key} label={`计划${f.label}`}>
                <input type="datetime-local" value={plan[f.key] || ''} onChange={e => setPlan({ ...plan, [f.key]: e.target.value })} />
              </Field>
            ))}
          </div>
          <Field label="备注"><textarea value={note} onChange={e => setNote(e.target.value)} placeholder="可选，写入批次记录与事件" /></Field>
        </div>
      )}

      {preview && !result && (
        <div className="stack">
          <div className="row wrap">
            <Tag tone="green">可执行 {preview.ok}</Tag>
            <Tag tone={preview.failed ? 'red' : 'gray'}>被拦截 {preview.failed}</Tag>
            <span className="muted small">共 {preview.items.length} 条</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>编号</th><th>需求</th><th>当前状态</th><th>结果</th><th>原因</th></tr></thead>
              <tbody>
                {preview.items.map((item: any) => (
                  <tr key={item.id}>
                    <td className="mono tiny">{item.code || '—'}</td>
                    <td className="title-cell truncate" style={{ maxWidth: 260 }}>{item.title}</td>
                    <td className="small">{item.from}</td>
                    <td><Tag tone={item.ok ? 'green' : 'red'}>{item.ok ? '可执行' : '被拦截'}</Tag></td>
                    <td className="small danger-text">{item.issues?.join('；') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <div className="stack">
          <div className="row wrap">
            <Tag tone="green">成功 {result.success.length}</Tag>
            <Tag tone={result.failed.length ? 'red' : 'gray'}>失败 {result.failed.length}</Tag>
            <span className="muted small">批次 {result.batchId}</span>
          </div>
          {result.success.map((x: any) => (
            <div key={x.id} className="dep-row">
              <span className="code">{x.code || '未编号'}</span>
              <span className="grow truncate">{x.title}</span>
              <span className="muted small">{x.from === x.to ? '仅更新进展' : `${x.from} → ${x.to}`}</span>
            </div>
          ))}
          {result.failed.map((x: any) => (
            <div key={x.id} className="dep-row">
              <span className="code">{x.code || '未编号'}</span>
              <span className="grow truncate">{x.title}</span>
              <span className="danger-text small">{x.reason}</span>
            </div>
          ))}
        </div>
      )}

      {busy && !preview && !result && <div className="mt12"><Loading label="处理中…" /></div>}
    </Modal>
  )
}
