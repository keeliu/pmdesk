import React, { useEffect, useState } from 'react'
import { downloadUrl, fmtTime, get, navigate } from '../api'
import { Empty, ErrorBox, Loading, PageHeader, StatusTag, Tag, useAsync } from '../ui'
import { PRIORITY_TONE } from '../api'
import { STATUS_NAMES, stageOf, statusLabel } from '../status'
import BatchProgressModal from '../components/BatchProgressModal'

function nextMilestone(ms: any) {
  if (!ms?.fields) return <span className="muted">—</span>
  const overdue = (ms.overdue || [])[0]
  if (overdue) return <Tag tone="red">{overdue.label}逾期</Tag>
  const next = ms.fields.filter((f: any) => f.actual).slice(-1)[0]
  return next ? <span className="small">{next.label} {String(next.actual).slice(0, 10)}</span> : <span className="muted">—</span>
}

export default function Pool({ projectId }: any) {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [appliedQ, setAppliedQ] = useState('')
  const [app, setApp] = useState('')
  const [owner, setOwner] = useState('')
  const [users, setUsers] = useState<any[]>([])
  const [scope, setScope] = useState<any>({ all: [] })
  const [selected, setSelected] = useState<string[]>([])
  const [progressOpen, setProgressOpen] = useState(false)

  useEffect(() => { get<any[]>('/api/users').then(setUsers).catch(() => {}) }, [])
  useEffect(() => { get<any>(`/api/projects/${projectId}/scope-apps`).then(setScope).catch(() => {}) }, [projectId])

  const query = new URLSearchParams()
  if (status) query.set('status', status)
  if (appliedQ) query.set('q', appliedQ)
  if (app) query.set('app', app)
  if (owner) query.set('owner', owner)
  const { data, loading, error, reload } = useAsync<any[]>(
    () => get(`/api/projects/${projectId}/requirements${query.toString() ? '?' + query.toString() : ''}`),
    [projectId, status, appliedQ, app, owner])

  const exportList = () => downloadUrl(`/api/projects/${projectId}/requirements-export.xlsx`)

  return (
    <>
      <PageHeader title="需求池" desc="已确认需求共享统一编号，状态从需求调研到全国推广共 14 个阶段，按门禁逐步推进。"
        actions={<>
          <button className="btn" onClick={exportList}>导出 Excel</button>
          {selected.length > 0 && <button className="btn" onClick={() => setProgressOpen(true)}>批量维护进展（{selected.length}）</button>}
          <button className="btn primary" onClick={() => navigate(`/p/${projectId}/inbox`)}>＋ 登记需求</button>
        </>} />

      <div className="card mb12">
        <div className="card-body row wrap">
          <div className="row grow">
            <input type="search" style={{ maxWidth: 260 }} value={q} placeholder="搜索编号或标题，回车检索"
              onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') setAppliedQ(q.trim()) }} />
            <button className="btn" onClick={() => setAppliedQ(q.trim())}>搜索</button>
          </div>
          <select style={{ width: 150 }} value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            {STATUS_NAMES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
          <select style={{ width: 170 }} value={app} onChange={e => setApp(e.target.value)}>
            <option value="">全部应用</option>
            {(scope.all || []).map((a: string) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select style={{ width: 150 }} value={owner} onChange={e => setOwner(e.target.value)}>
            <option value="">全部负责人</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <span className="muted small">共 {data?.length ?? 0} 条</span>
        </div>
      </div>

      <div className="card">
        <div className="card-body tight">
          {loading && <Loading />}
          {error && <ErrorBox message={error} onRetry={reload} />}
          {data && !data.length && <Empty title="没有匹配的需求" desc="调整筛选条件，或先到待澄清箱登记并确认需求。" />}
          {data && data.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr>
                  <th style={{ width: 32 }}>
                    <input type="checkbox" checked={data.length > 0 && selected.length === data.length}
                      onChange={() => setSelected(selected.length === data.length ? [] : data.map((r: any) => r.id))} />
                  </th>
                  <th>编号</th><th>需求标题</th><th>状态</th><th>负责人</th><th>产品经理</th><th>涉及应用</th>
                  <th>优先级</th><th>最近里程碑</th><th>未闭环建议</th><th>更新时间</th><th></th>
                </tr></thead>
                <tbody>
                  {data.map(r => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/p/${projectId}/requirements/${r.id}`)}>
                      <td onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.includes(r.id)}
                          onChange={() => setSelected(s => s.includes(r.id) ? s.filter(x => x !== r.id) : [...s, r.id])} />
                      </td>
                      <td><button className="link-btn mono" onClick={e => { e.stopPropagation(); navigate(`/p/${projectId}/requirements/${r.id}`) }}>{r.code}</button></td>
                      <td className="title-cell">{r.title}</td>
                      <td><StatusTag status={r.status} /></td>
                      <td>{r.ownerName || '—'}</td>
                      <td>{r.milestones?.productManager || <span className="muted">—</span>}</td>
                      <td>
                        <div className="row wrap">{(r.involvedApps || []).slice(0, 2).map((a: any) => <Tag key={a.name} tone={a.kind === 'external' ? 'amber' : 'blue'}>{a.name}</Tag>)}
                          {(r.involvedApps || []).length > 2 && <Tag tone="gray">+{r.involvedApps.length - 2}</Tag>}</div>
                      </td>
                      <td>{r.priority?.grade ? <Tag tone={PRIORITY_TONE[r.priority.grade]}>{r.priority.gradeLabel || r.priority.grade}</Tag> : <span className="muted">—</span>}</td>
                      <td>{nextMilestone(r.milestones)}</td>
                      <td>{r.openSuggestions ? <Tag tone="orange">{r.openSuggestions}</Tag> : <span className="muted">0</span>}</td>
                      <td className="muted small nowrap">{fmtTime(r.updated_at)}</td>
                      <td className="actions">
                        <button className="btn sm" onClick={e => { e.stopPropagation(); navigate(`/p/${projectId}/requirements/${r.id}`) }}>查看详情</button>
                        <button className="btn sm ghost" onClick={e => { e.stopPropagation(); navigate(`/p/${projectId}/req/${r.id}/${stageOf(r.status)}`) }}>工作台</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {progressOpen && (
        <BatchProgressModal projectId={projectId} requirementIds={selected}
          scopeLabel={`已选择 ${selected.length} 条需求`}
          onClose={() => setProgressOpen(false)}
          onDone={async () => { setSelected([]); reload() }} />
      )}
    </>
  )
}
