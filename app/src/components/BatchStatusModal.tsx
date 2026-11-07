import React, { useEffect, useState } from 'react'
import { get, post } from '../api'
import { Field, Loading, Modal, Tag, useToast } from '../ui'

const TARGETS = [
  '需求分析中', '需求评审中', '待开发', '开发中', '待测试验证', '测试验证中',
  '待UAT', 'UAT中', '待试点', '试点中', '待上线发版', '全国推广中', '已关闭', '挂起'
]
const FILTER_STATUS = [
  '待需求分析', '需求分析中', '需求评审中', '待开发', '开发中', '待测试验证',
  '测试验证中', '待UAT', 'UAT中', '待试点', '试点中', '待上线发版', '全国推广中', '挂起'
]

type Props = {
  projectId: string
  iterationId?: string
  requirementIds?: string[]
  iterations?: { id: string; name: string }[]
  scopeLabel?: string
  onClose: () => void
  onDone?: () => Promise<void> | void
}

export default function BatchStatusModal({ projectId, iterationId: fixedIteration, requirementIds, iterations = [], scopeLabel, onClose, onDone }: Props) {
  const toast = useToast()
  const [iterationId, setIterationId] = useState(fixedIteration || '')
  const [filterStatus, setFilterStatus] = useState('')
  const [to, setTo] = useState('开发中')
  const [effectiveAt, setEffectiveAt] = useState('')
  const [note, setNote] = useState('')
  const [count, setCount] = useState<number | null>(requirementIds ? requirementIds.length : null)
  const [result, setResult] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  const fixedScope = Boolean(requirementIds)

  useEffect(() => {
    if (fixedScope) return
    if (!iterationId && !filterStatus) { setCount(null); return }
    let alive = true
    const qs = new URLSearchParams()
    if (iterationId) qs.set('iteration', iterationId)
    if (filterStatus) qs.set('status', filterStatus)
    get<any[]>(`/api/projects/${projectId}/requirements?${qs.toString()}`)
      .then(rows => { if (alive) setCount(rows.length) })
      .catch(() => { if (alive) setCount(null) })
    return () => { alive = false }
  }, [projectId, iterationId, filterStatus, fixedScope])

  const submit = async () => {
    if (!fixedScope && !iterationId && !filterStatus) { toast.push('请选择迭代或状态筛选，避免误改整个项目', 'warn'); return }
    if (to === '挂起' && !note.trim()) { toast.push('挂起必须填写原因', 'warn'); return }
    setBusy(true)
    try {
      const body: any = { to, note: note.trim(), effectiveAt: effectiveAt ? new Date(effectiveAt).toISOString() : null }
      if (fixedScope) body.requirementIds = requirementIds
      else {
        if (iterationId) body.iterationId = iterationId
        if (filterStatus) body.filter = { status: filterStatus }
      }
      const r = await post<any>(`/api/projects/${projectId}/requirements/batch-status`, body)
      setResult(r)
      toast.push(`批量更新完成：成功 ${r.success.length} 条，失败 ${r.failed.length} 条`, r.failed.length ? 'warn' : 'success')
      await onDone?.()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy(false) }
  }

  const close = () => { onClose() }

  return (
    <Modal title="批量更新状态" subtitle={scopeLabel || '按迭代或状态筛选批量推进；逐条校验门禁，允许部分成功'}
      onClose={close} wide
      footer={result
        ? <button className="btn primary" onClick={close}>完成</button>
        : <><button className="btn" onClick={close}>取消</button><button className="btn primary" disabled={busy || count === 0} onClick={submit}>确认更新{count !== null ? `（${count} 条）` : ''}</button></>}>
      {!result && (
        <>
          {!fixedScope && (
            <div className="form-grid">
              <Field label="迭代范围" hint="不选迭代则按状态筛选全项目">
                <select value={iterationId} onChange={e => setIterationId(e.target.value)}>
                  <option value="">全部迭代</option>
                  {iterations.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
                </select>
              </Field>
              <Field label="状态筛选">
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                  <option value="">不筛选</option>
                  {FILTER_STATUS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
            </div>
          )}
          {fixedScope && <div className="notice info mb12">范围：{scopeLabel || `已选择 ${requirementIds?.length || 0} 条需求`}</div>}
          <div className="form-grid">
            <Field label="目标状态" required>
              <select value={to} onChange={e => setTo(e.target.value)}>
                {TARGETS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="统一生效时间" hint="留空为当前时间；不得晚于当前时间">
              <input type="datetime-local" value={effectiveAt} onChange={e => setEffectiveAt(e.target.value)} />
            </Field>
            <div className="wide"><Field label={to === '挂起' ? '原因（必填）' : '备注'}>
              <textarea value={note} onChange={e => setNote(e.target.value)} placeholder={to === '挂起' ? '说明挂起原因' : '可选，写入事件与批次记录'} />
            </Field></div>
          </div>
          <div className="notice info mt12">
            {!fixedScope && count === null && '请先选择迭代或状态筛选，系统会显示命中条数。'}
            {count !== null && <>命中 <strong>{count}</strong> 条需求。逐条执行门禁校验：里程碑缺失、建议未闭环或跨级流转会失败并保留原状态。</>}
          </div>
        </>
      )}
      {result && (
        <div className="stack">
          <div className="row wrap">
            <Tag tone="green">成功 {result.success.length}</Tag>
            <Tag tone={result.failed.length ? 'red' : 'gray'}>失败 {result.failed.length}</Tag>
            <span className="muted small">批次 {result.batchId} · 生效时间 {String(result.effectiveAt || '').slice(0, 19).replace('T', ' ')}</span>
          </div>
          {result.success.length > 0 && (
            <div>
              <div className="section-title">已更新</div>
              {result.success.map((x: any) => (
                <div key={x.id} className="dep-row"><span className="code">{x.code || '未编号'}</span><span className="grow truncate">{x.title}</span><span className="muted small">{x.from} → {x.to}</span></div>
              ))}
            </div>
          )}
          {result.failed.length > 0 && (
            <div>
              <div className="section-title">未更新</div>
              {result.failed.map((x: any) => (
                <div key={x.id} className="dep-row"><span className="code">{x.code || '未编号'}</span><span className="grow truncate">{x.title}</span><span className="danger-text small">{x.reason}</span></div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
