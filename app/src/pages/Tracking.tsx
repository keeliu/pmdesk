import React, { useState } from 'react'
import { fmtDay, fmtTime, get, navigate, post, PRIORITY_TONE } from '../api'
import { STATUS_NAMES, nextStatuses, statusLabel } from '../status'
import { Empty, ErrorBox, Loading, PageHeader, StatusTag, Tag, useAsync, useToast } from '../ui'
import BatchStatusModal from '../components/BatchStatusModal'
import TrackingChat from '../components/TrackingChat'

const TASK_STAGE: Record<string, string> = {
  '待澄清': 'clarify', '待分析': 'analysis', '待提交评审': 'review', '待闭环建议': 'review',
  '待评审': 'review', '待测试验证': 'change'
}

const DEVELOPER_TARGETS = ['待测试验证', '测试验证中', '开发中', '待UAT']

function nextOptions(status: string) {
  return nextStatuses(status)
}

const STATUS_GROUPS: { label: string; statuses: string[]; tone: string }[] = [
  { label: '需求调研中', statuses: ['需求调研中'], tone: 'gray' },
  { label: '待分析 / 分析中', statuses: ['待需求分析', '需求分析中'], tone: 'indigo' },
  { label: '评审 / 待开发', statuses: ['需求评审中', '待开发'], tone: 'amber' },
  { label: '开发与测试', statuses: ['开发中', '待测试验证', '测试验证中'], tone: 'teal' },
  { label: 'UAT', statuses: ['待UAT', 'UAT中'], tone: 'orange' },
  { label: '试点', statuses: ['待试点', '试点中'], tone: 'brown' },
  { label: '发版与推广', statuses: ['待上线发版', '全国推广中'], tone: 'green' },
  { label: '挂起 / 异常', statuses: ['挂起', '已关闭'], tone: 'red' }
]

export default function Tracking({ projectId, projectRole }: any) {
  const toast = useToast()
  const [filterIteration, setFilterIteration] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [batchOpen, setBatchOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const tracking = useAsync<any>(() => get(`/api/projects/${projectId}/tracking`), [projectId])
  const todos = useAsync<any>(() => get(`/api/projects/${projectId}/todos`), [projectId])
  const summary = useAsync<any>(() => get(`/api/projects/${projectId}/summary`), [projectId])
  const iterations = useAsync<any[]>(() => get(`/api/projects/${projectId}/iterations`), [projectId])
  const qs = new URLSearchParams()
  if (filterIteration) qs.set('iteration', filterIteration)
  if (filterStatus) qs.set('status', filterStatus)
  const requirements = useAsync<any[]>(() => get(`/api/projects/${projectId}/requirements${qs.toString() ? `?${qs}` : ''}`), [projectId, filterIteration, filterStatus])

  if (tracking.loading && !tracking.data) return <Loading />
  if (tracking.error) return <ErrorBox message={tracking.error} onRetry={tracking.reload} />
  const t = tracking.data

  const reloadAll = () => { tracking.reload(); todos.reload(); summary.reload(); requirements.reload() }

  const advance = async (r: any, to: string) => {
    if (!to) return
    let note = ''
    if (to === '挂起') {
      note = prompt('请填写挂起原因') || ''
      if (!note.trim()) { toast.push('挂起必须填写原因', 'warn'); return }
    }
    setBusy(r.id)
    try {
      const res = await post<any>(`/api/requirements/${r.id}/status`, { to, note })
      toast.push(`${r.code || r.title} 已更新为「${res.statusLabel || statusLabel(res.status)}」${res.backfilled ? '（已回填里程碑）' : ''}`, 'success')
      reloadAll()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  return (
    <>
      <PageHeader title="状态跟进" desc="直接推进单条需求、按迭代或筛选批量更新，或在右侧会话里让助手生成更新提案。所有写入门禁在服务端校验。"
        actions={<>
          <button className="btn" onClick={reloadAll}>刷新</button>
          {['pm', 'admin'].includes(projectRole) && <button className="btn primary" onClick={() => setBatchOpen(true)}>批量更新</button>}
        </>} />

      <div className="stat-grid mb12">
        {STATUS_GROUPS.map(g => (
          <div key={g.label} className="stat">
            <div className="label">{g.label}</div>
            <div className="value" style={{ color: `var(--${g.tone})` }}>{g.statuses.reduce((n, s) => n + (t.counts[s] || 0), 0)}</div>
            <div className="sub">条需求</div>
          </div>
        ))}
      </div>

      <div className="tracking-layout">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <div><h3>需求状态</h3><p>逐条选择目标状态直接更新；生效时间默认为当前时间</p></div>
              <div className="row wrap">
                <select value={filterIteration} onChange={e => setFilterIteration(e.target.value)}>
                  <option value="">全部迭代</option>
                  {(iterations.data || []).map((it: any) => <option key={it.id} value={it.id}>{it.name}</option>)}
                </select>
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                  <option value="">全部状态</option>
                  {STATUS_NAMES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
                </select>
              </div>
            </div>
            <div className="card-body tight">
              {requirements.loading && <Loading />}
              {requirements.error && <ErrorBox message={requirements.error} onRetry={requirements.reload} />}
              {requirements.data && !requirements.data.length && <Empty title="没有匹配的需求" desc="调整迭代或状态筛选后重试。" icon="○" />}
              {requirements.data && requirements.data.length > 0 && (
                <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
                  <table className="table">
                    <thead><tr><th>编号</th><th>需求</th><th>状态</th><th>优先级</th><th>里程碑</th><th>更新状态</th><th></th></tr></thead>
                    <tbody>
                      {requirements.data.map((r: any) => {
                        const opts = projectRole === 'developer'
                          ? nextOptions(r.status).filter((s: string) => DEVELOPER_TARGETS.includes(s))
                          : nextOptions(r.status)
                        const next = opts[0] || ''
                        return (
                          <tr key={r.id}>
                            <td className="mono tiny">{r.code || '—'}</td>
                            <td className="title-cell"><button className="link-btn" onClick={() => navigate(`/p/${projectId}/requirements/${r.id}`)}>{r.title}</button></td>
                            <td><StatusTag status={r.status} /></td>
                            <td>{r.priority?.grade ? <Tag tone={PRIORITY_TONE[r.priority.grade]}>{r.priority.gradeLabel || r.priority.grade}</Tag> : <span className="muted tiny">未评估</span>}</td>
                            <td className="tiny muted">{r.milestones?.plan?.releasedAt ? `上线计划 ${fmtDay(r.milestones.plan.releasedAt)}` : '—'}</td>
                            <td>
                              <select defaultValue={next} disabled={busy === r.id} onChange={e => advance(r, e.target.value)}>
                                {opts.map(o => <option key={o} value={o}>{o === '恢复' ? `恢复（${statusLabel(r.suspended_from || '原状态')}）` : `→ ${statusLabel(o)}`}</option>)}
                              </select>
                            </td>
                            <td className="actions">
                              <button className="btn sm" disabled={busy === r.id} onClick={() => advance(r, next)}>更新</button>
                              <button className="btn sm ghost" onClick={() => navigate(`/p/${projectId}/requirements/${r.id}`)}>详情</button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="split-2">
            <div className="stack">
              <div className="card">
                <div className="card-head"><div><h3>风险清单</h3><p>停滞、建议积压、逾期、里程碑与容量超限</p></div><Tag tone="red">{t.risks.length}</Tag></div>
            <div className="card-body tight">
              {!t.risks.length && <Empty title="没有风险项" icon="✓" />}
              {t.risks.length > 0 && (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>等级</th><th>类型</th><th>对象</th><th>说明</th><th></th></tr></thead>
                    <tbody>
                      {t.risks.map((r: any, i: number) => (
                        <tr key={i}>
                          <td><Tag tone={r.level === 'high' ? 'red' : 'amber'}>{r.level === 'high' ? '高' : '中'}</Tag></td>
                          <td>{r.type}</td>
                          <td className="title-cell">{r.code} {r.title}</td>
                          <td className="muted">{r.detail}</td>
                          <td className="actions">{r.requirementId && <button className="btn sm" onClick={() => navigate(`/p/${projectId}/req/${r.requirementId}/analysis`)}>处理</button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div><h3>项目动态</h3><p>最近 80 条事件</p></div></div>
            <div className="card-body">
              <div className="timeline">
                {t.timeline.map((e: any) => (
                  <div key={e.id} className="timeline-item strong">
                    <div className="t-main">{e.req_code && <span className="code" style={{ marginRight: 6 }}>{e.req_code}</span>}{e.message}</div>
                    <div className="t-meta">{e.actor_name || '系统'} · {fmtTime(e.created_at)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><div><h3>我的待办</h3><p>按当前项目角色生成</p></div>
              <button className="link-btn" onClick={async () => {
                await post(`/api/projects/${projectId}/notifications/read`, {})
                toast.push('通知已全部标记为已读', 'success'); todos.reload()
              }}>通知全部已读</button></div>
            <div className="card-body tight">
              {todos.loading && <Loading />}
              {todos.error && <ErrorBox message={todos.error} />}
              {todos.data && !todos.data.tasks.length && <Empty title="没有待办" desc="当前角色在项目内的动作都已处理。" icon="✓" />}
              {todos.data?.tasks.map((task: any, i: number) => (
                <div key={i} className="inbox-item">
                  <div className="body">
                    <h4>{task.title}</h4>
                    <div className="meta"><Tag tone={task.tone}>{task.type}</Tag><span className="code">{task.code}</span></div>
                  </div>
                  <button className="btn sm" onClick={() => navigate(`/p/${projectId}/req/${task.requirementId}/${TASK_STAGE[task.type] || 'analysis'}`)}>去处理</button>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div><h3>通知</h3><p>最近 50 条站内信</p></div></div>
            <div className="card-body tight" style={{ maxHeight: 320, overflow: 'auto' }}>
              {todos.data?.notifications?.length ? todos.data.notifications.map((n: any) => (
                <div key={n.id} className={`notif-item ${n.read ? '' : 'unread'}`}>
                  <strong>{n.title}</strong><span>{n.body}</span>
                  <div className="tiny muted mt8">{fmtTime(n.created_at)}</div>
                </div>
              )) : <p className="muted small" style={{ padding: 12 }}>暂无通知</p>}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div><h3>摘要</h3><p>生成于 {fmtTime(summary.data?.generatedAt)}</p></div></div>
            <div className="card-body">
              {summary.data ? <ul className="list-clean">{summary.data.lines.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul> : <Loading />}
            </div>
          </div>
        </div>
          </div>
        </div>

        <aside className="tracking-chat card">
          <TrackingChat projectId={projectId} iterations={iterations.data || []} onApplied={reloadAll} />
        </aside>
      </div>

      {batchOpen && (
        <BatchStatusModal projectId={projectId} iterations={iterations.data || []}
          onClose={() => setBatchOpen(false)} onDone={async () => { reloadAll(); await iterations.reload() }} />
      )}
    </>
  )
}
