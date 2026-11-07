import React, { useState } from 'react'
import { get, navigate, post, put, del } from '../api'
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader, Progress, StatusTag, Tag, useAsync, useToast } from '../ui'
import { PRIORITY_TONE } from '../api'

function Card({ r, onOpen, onRemove, canManage }: any) {
  return (
    <div className="plan-card" draggable={canManage}
      onDragStart={e => { e.dataTransfer.setData('text/plain', r.id); e.dataTransfer.effectAllowed = 'move' }}
      onClick={() => onOpen(r)}>
      <div className="pc-meta">
        {r.code && <span className="code">{r.code}</span>}
        {r.priority?.grade && <Tag tone={PRIORITY_TONE[r.priority.grade]}>{r.priority.gradeLabel || r.priority.grade}</Tag>}
        <StatusTag status={r.status} />
      </div>
      <div className="pc-title">{r.title}</div>
      <div className="pc-meta">
        <span>估 {r.priority?.estimateDays ?? 0} 人日</span>
        {r.priority?.score !== undefined && <span>{r.priority.score} 分</span>}
        {onRemove && <button className="link-btn" onClick={e => { e.stopPropagation(); onRemove(r) }}>移出</button>}
      </div>
    </div>
  )
}

export default function Planning({ projectId, projectRole }: any) {
  const toast = useToast()
  const { data, loading, error, reload } = useAsync<any>(() => get(`/api/projects/${projectId}/planning`), [projectId])
  const [dragOver, setDragOver] = useState('')
  const [editing, setEditing] = useState<any>(null)
  const [dep, setDep] = useState({ fromReq: '', toReq: '' })
  const canManage = ['pm', 'admin'].includes(projectRole)

  const schedule = async (requirementId: string, iterationId: string | null) => {
    try {
      await post(`/api/requirements/${requirementId}/schedule`, { iterationId })
      toast.push(iterationId ? '已排入迭代' : '已移出迭代', 'success')
      await reload()
    } catch (e: any) { toast.push(e.message, 'error') }
  }

  const addDep = async () => {
    if (!dep.fromReq || !dep.toReq) { toast.push('请选择前后置需求', 'warn'); return }
    try {
      await post(`/api/projects/${projectId}/dependencies`, dep)
      toast.push('依赖已添加', 'success')
      setDep({ fromReq: '', toReq: '' })
      await reload()
    } catch (e: any) { toast.push(e.message, 'error') }
  }

  const removeDep = async (id: string) => {
    try { await del(`/api/projects/${projectId}/dependencies/${id}`); await reload() } catch (e: any) { toast.push(e.message, 'error') }
  }

  if (loading) return <Loading />
  if (error) return <ErrorBox message={error} onRetry={reload} />

  const reqName = (id: string) => {
    const r = data.requirements.find((x: any) => x.id === id)
    return r ? `${r.code || ''} ${r.title}` : id
  }

  return (
    <>
      <PageHeader title="规划" desc="按七维信号评估优先级与工作量，再拖拽排期。容量超限会阻止排入；依赖关系禁止成环。"
        actions={<>
          <button className="btn" onClick={() => navigate(`/p/${projectId}/iterations`)}>← 迭代</button>
          <button className="btn" onClick={() => reload()}>刷新</button>
          {canManage && <button className="btn" onClick={() => post(`/api/projects/${projectId}/priorities/recalculate`, {}).then((r: any) => { toast.push(`已按新模型重算 ${r.updated.length} 条优先级`, 'success'); reload() }).catch((e: any) => toast.push(e.message, 'error'))}>重算优先级</button>}
        </>} />

      <div className="notice info mb12">拖拽卡片到目标迭代即可排期；单击卡片按七维信号复核优先级与工作量。未评估工作量的需求按 0 人日计算，建议先评估。</div>

      <div className="plan-board">
        <div className="plan-col"
          onDragOver={e => { if (canManage) { e.preventDefault(); setDragOver('none') } }}
          onDragLeave={() => setDragOver('')}
          onDrop={e => { e.preventDefault(); setDragOver(''); const id = e.dataTransfer.getData('text/plain'); if (id) schedule(id, null) }}>
          <header>
            <h4>未排期</h4>
            <Tag tone="gray">{data.unscheduled.length}</Tag>
          </header>
          <div className="col-body">
            {!data.unscheduled.length && <p className="muted small" style={{ padding: 8 }}>全部需求已排期</p>}
            {data.unscheduled.map((r: any) => <Card key={r.id} r={r} canManage={canManage} onOpen={setEditing} />)}
          </div>
        </div>

        {data.iterations.map((it: any) => (
          <div key={it.id} className={`plan-col ${dragOver === it.id ? 'hover' : ''}`}
            onDragOver={e => { if (canManage && it.status !== 'released') { e.preventDefault(); setDragOver(it.id) } }}
            onDragLeave={() => setDragOver('')}
            onDrop={e => { e.preventDefault(); setDragOver(''); const id = e.dataTransfer.getData('text/plain'); if (id) schedule(id, it.id) }}>
            <header>
              <div>
                <h4>{it.name}</h4>
                <span className="tiny muted">{it.start_date?.slice(0, 10) || '—'} ~ {it.end_date?.slice(0, 10) || '—'} · {it.status === 'released' ? '已发布' : it.status === 'active' ? '进行中' : '规划中'}</span>
              </div>
              <Tag tone={it.over ? 'red' : 'blue'}>{it.requirements.length} 条</Tag>
            </header>
            <div className="capacity-bar">
              <div className="capacity-label"><span>容量</span><span className={it.over ? 'danger-text' : ''}>{it.usedDays} / {it.capacity_days || '—'} 人日</span></div>
              <Progress value={it.capacity_days ? Math.min(100, it.usedDays / it.capacity_days * 100) : 0} tone={it.over ? 'orange' : 'teal'} />
            </div>
            <div className="col-body">
              {!it.requirements.length && <p className="muted small" style={{ padding: 8 }}>暂无需求，拖入卡片开始排期</p>}
              {it.requirements.map((r: any) => (
                <Card key={r.id} r={r} canManage={canManage && it.status !== 'released'} onOpen={setEditing}
                  onRemove={canManage && it.status !== 'released' ? (x: any) => schedule(x.id, null) : null} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="card mt16">
        <div className="card-head"><div><h3>需求依赖</h3><p>前置需求未上线时，后置需求应在评审中提示风险</p></div></div>
        <div className="card-body">
          {canManage && (
            <div className="row wrap mb12">
              <select style={{ width: 280 }} value={dep.fromReq} onChange={e => setDep({ ...dep, fromReq: e.target.value })}>
                <option value="">前置需求（from）</option>
                {data.requirements.map((r: any) => <option key={r.id} value={r.id}>{r.code} {r.title}</option>)}
              </select>
              <span className="muted">→</span>
              <select style={{ width: 280 }} value={dep.toReq} onChange={e => setDep({ ...dep, toReq: e.target.value })}>
                <option value="">后置需求（to）</option>
                {data.requirements.map((r: any) => <option key={r.id} value={r.id}>{r.code} {r.title}</option>)}
              </select>
              <button className="btn" onClick={addDep}>添加依赖</button>
            </div>
          )}
          {!data.dependencies.length && <p className="muted small">暂无依赖关系。</p>}
          {data.dependencies.map((d: any) => (
            <div key={d.id} className="dep-row">
              <Tag tone="blue">前置</Tag><span className="grow">{reqName(d.from_req)}</span>
              <span className="muted">→</span>
              <Tag tone="violet">后置</Tag><span className="grow">{reqName(d.to_req)}</span>
              {canManage && <button className="btn sm danger" onClick={() => removeDep(d.id)}>删除</button>}
            </div>
          ))}
        </div>
      </div>

      {editing && <PriorityModal value={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload() }} />}
    </>
  )
}

const LEVEL_TEXT: Record<string, string> = { P0: 'P0-极高', P1: 'P1-高', P2: 'P2-中', P3: 'P3-低' }

function gradeByScore(score: number) {
  if (score >= 75) return 'P0'
  if (score >= 55) return 'P1'
  if (score >= 35) return 'P2'
  return 'P3'
}

function PriorityModal({ value, onClose, onSaved }: any) {
  const toast = useToast()
  const p = value.priority || {}
  const model = useAsync<any>(() => get('/api/priorities/model'), [])
  const initialValues = p.ruleValues || Object.fromEntries((p.dimensions || []).map((d: any) => [d.key, d.value]))
  const initialEvidence = Object.fromEntries((p.dimensions || []).map((d: any) => [d.key, d.evidence]))
  const [values, setValues] = useState<any>(initialValues)
  const [evidence, setEvidence] = useState<any>(initialEvidence)
  const [estimateDays, setEstimateDays] = useState<any>(p.estimateDays ?? 5)
  const [floor, setFloor] = useState<boolean>(Boolean(p.floor))
  const [floorReason, setFloorReason] = useState<string>(p.floorReason || '')
  const [grade, setGrade] = useState<string>(p.manual ? p.grade : '')
  const [reason, setReason] = useState<string>(p.reason || '')
  const [busy, setBusy] = useState(false)

  const dims = model.data?.dimensions || []
  const optionOf = (d: any, v: string) => d.options.find((o: any) => o.value === v) || d.options[d.options.length - 1]
  const score = dims.reduce((s: number, d: any) => s + (optionOf(d, values[d.key] ?? '')?.score || 0), 0)
  const dimScore = (key: string) => {
    const d = dims.find((x: any) => x.key === key)
    return d ? optionOf(d, values[key] ?? '')?.score || 0 : 0
  }
  let suggested = gradeByScore(score)
  const capNote: string[] = []
  if (floor) {
    suggested = 'P0'
    capNote.push(floorReason || '命中合规、资金、安全或无替代路径的流程阻断，等级不低于 P0')
  } else if (dimScore('level') >= 10 && dimScore('closure') <= 15 && dimScore('breadth') <= 8
    && dimScore('business') <= 5 && dimScore('efficiency') <= 0 && dimScore('cost') <= 0) {
    if (suggested === 'P0' || suggested === 'P1') suggested = 'P2'
    capNote.push('提出人级别只贡献有限分值，不能单独把需求抬到 P0 或 P1')
  }
  const ai = p.aiCandidate
  const diffKeys = ai ? dims.filter((d: any) => (ai.values?.[d.key] || '') !== (values[d.key] || '')) : []

  const save = async () => {
    if (grade && grade !== suggested && !reason.trim()) { toast.push('人工调整优先级必须填写理由', 'warn'); return }
    setBusy(true)
    try {
      await put(`/api/requirements/${value.id}/priority`, {
        values, evidence, estimateDays: Number(estimateDays),
        floor, floorReason,
        grade: grade || undefined,
        reason: grade && grade !== suggested ? reason : undefined
      })
      toast.push(`优先级已保存为 ${LEVEL_TEXT[grade || suggested]}`, 'success')
      await onSaved()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <Modal title={`优先级评估：${value.title}`} subtitle={`${value.code || '未编号'} · 百分制七维模型，分数与规则冲突时人工调整需填理由`}
      onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || model.loading} onClick={save}>保存评估</button></>}>
      {model.loading && <Loading label="加载模型…" />}
      {model.error && <ErrorBox message={model.error} onRetry={model.reload} />}
      {!model.loading && !model.error && (
        <>
          <div className="stack">
            {dims.map((d: any) => {
              const opt = optionOf(d, values[d.key] ?? '')
              const changed = ai && (ai.values?.[d.key] || '') !== (values[d.key] || '')
              return (
                <div key={d.key} className="card">
                  <div className="card-body">
                    <div className="row wrap" style={{ justifyContent: 'space-between' }}>
                      <div className="row wrap">
                        <strong>{d.label}</strong>
                        <span className="tiny muted">权重 {d.weight || '±'}</span>
                        {changed && <Tag tone="amber">AI 候选：{optionOf(d, ai.values?.[d.key])?.label}</Tag>}
                      </div>
                      <Tag tone={opt.score < 0 ? 'red' : opt.score >= d.weight * 0.9 && d.weight > 0 ? 'green' : 'gray'}>{opt.score > 0 ? '+' : ''}{opt.score} 分</Tag>
                    </div>
                    <div className="row wrap mt8">
                      <select style={{ minWidth: 240 }} value={values[d.key] ?? ''} onChange={e => setValues({ ...values, [d.key]: e.target.value })}>
                        {d.options.map((o: any) => <option key={o.value} value={o.value}>{o.label}（{o.score > 0 ? '+' : ''}{o.score}）</option>)}
                      </select>
                      <input className="grow" style={{ minWidth: 260 }} placeholder="评分依据（自动识别的证据可修改）"
                        value={evidence[d.key] ?? ''} onChange={e => setEvidence({ ...evidence, [d.key]: e.target.value })} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="form-grid mt12">
            <Field label="排期工作量（人日）"><input type="number" min={0} step={0.5} value={estimateDays} onChange={e => setEstimateDays(e.target.value)} /></Field>
            <Field label="人工调整优先级" hint={`自动建议 ${LEVEL_TEXT[suggested]}`}>
              <select value={grade} onChange={e => setGrade(e.target.value)}>
                <option value="">采用自动建议（{LEVEL_TEXT[suggested]}）</option>
                {['P0', 'P1', 'P2', 'P3'].map(g => <option key={g} value={g}>{LEVEL_TEXT[g]}</option>)}
              </select>
            </Field>
            <div className="wide"><Field label="调整理由" hint="与自动建议不一致时必填，将写入审计与事件">
              <textarea value={reason} onChange={e => setReason(e.target.value)} disabled={!grade || grade === suggested} />
            </Field></div>
          </div>

          <label className="row small mt12" style={{ gap: 6 }}>
            <input type="checkbox" checked={floor} onChange={e => setFloor(e.target.checked)} />
            命中 P0 底线规则（合规 / 资金 / 安全 / 无替代路径的流程阻断）
          </label>
          {floor && <input className="mt8" style={{ width: '100%' }} placeholder="底线依据，例如：监管要求必须留存审批轨迹"
            value={floorReason} onChange={e => setFloorReason(e.target.value)} />}

          <div className="notice info mt12">
            当前自动得分 <strong>{score}</strong> 分 → <strong>{LEVEL_TEXT[suggested]}</strong>
            {grade && grade !== suggested && <>；人工调整为 <strong>{LEVEL_TEXT[grade]}</strong>，保存时保留建议等级与理由</>}
            {capNote.length > 0 && <div className="tiny mt8">{capNote.join('；')}</div>}
            {diffKeys.length > 0 && <div className="tiny mt8">与 AI 候选不一致：{diffKeys.map((d: any) => d.label).join('、')}</div>}
          </div>
        </>
      )}
    </Modal>
  )
}
