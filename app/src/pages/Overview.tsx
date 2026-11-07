import React from 'react'
import { fmtTime, navigate } from '../api'
import { get } from '../api'
import { Empty, ErrorBox, Loading, PageHeader, Progress, StatusTag, Tag, useAsync } from '../ui'

export default function Overview({ projectId, project, projectRole }: any) {
  const { data, loading, error, reload } = useAsync<any>(() => get(`/api/projects/${projectId}/overview`), [projectId])
  const summary = useAsync<any>(() => get(`/api/projects/${projectId}/summary`), [projectId])
  const knowledge = useAsync<any>(() => get(`/api/projects/${projectId}/knowledge?pageSize=1`), [projectId])

  if (loading) return <Loading />
  if (error) return <ErrorBox message={error} onRetry={reload} />
  const c = data.counts || {}
  const active = data.activeIteration

  const stats: [string, number, string, string, string][] = [
    ['待澄清', c['需求调研中'] || 0, 'gray', 'inbox', '客户提交后尚未完成澄清'],
    ['需求池', data.totals.pool, 'blue', 'pool', '已确认需求'],
    ['分析中', (c['待需求分析'] || 0) + (c['需求分析中'] || 0), 'indigo', 'pool', '含待需求分析'],
    ['评审中', (c['需求评审中'] || 0) + (c['待开发'] || 0), 'amber', 'reviews', '含待开发'],
    ['开发中', (c['开发中'] || 0) + (c['待测试验证'] || 0) + (c['测试验证中'] || 0), 'teal', 'tracking', '含测试验证'],
    ['UAT / 试点', (c['待UAT'] || 0) + (c['UAT中'] || 0) + (c['待试点'] || 0) + (c['试点中'] || 0), 'cyan', 'tracking', '待UAT至试点中'],
    ['待上线发版', c['待上线发版'] || 0, 'orange', 'tracking', '等待迭代发布'],
    ['全国推广中', c['全国推广中'] || 0, 'green', 'pool', '已上线推广'],
    ['知识库', knowledge.data?.counts?.all || 0, 'violet', 'knowledge', '过程产物']
  ]

  return (
    <>
      <PageHeader title={<>{project?.name || '项目'} <StatusTag status={project?.status === 'active' ? '已确认' : project?.status || ''} /></>}
        desc={project?.description || '项目概览、风险与近期动态。'}
        actions={<>
          <button className="btn" onClick={() => navigate(`/p/${projectId}/inbox`)}>登记需求</button>
          <button className="btn primary" onClick={() => navigate(`/p/${projectId}/pool`)}>进入需求池</button>
        </>} />

      <div className="stat-grid mb12">
        {stats.map(([label, value, tone, target, sub]) => (
          <div key={label} className={`stat clickable ${label === '需求池' ? 'accent' : ''}`} onClick={() => navigate(`/p/${projectId}/${target}`)}>
            <div className="label">{label}</div>
            <div className="value" style={{ color: `var(--${tone})` }}>{value}</div>
            <div className="sub">{sub}</div>
          </div>
        ))}
      </div>

      <div className="split-2">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <div><h3>当前迭代</h3><p>进行中的迭代容量与交付进度</p></div>
              <button className="link-btn" onClick={() => navigate(`/p/${projectId}/iterations`)}>全部迭代 →</button>
            </div>
            <div className="card-body">
              {active ? (
                <div className="stack">
                  <div className="row between">
                    <div>
                      <div className="row"><strong>{active.name}</strong><Tag tone={active.status === 'active' ? 'teal' : 'gray'}>{active.status === 'active' ? '进行中' : active.status === 'released' ? '已发布' : '规划中'}</Tag></div>
                      <p className="muted small mt8">{active.goal || '未填写迭代目标'}</p>
                    </div>
                    <div className="muted small nowrap">{(active.start_date || '—').slice(0, 10)} ~ {(active.end_date || '—').slice(0, 10)}</div>
                  </div>
                  <Progress value={active.capacity_days ? Math.min(100, active.usedDays / active.capacity_days * 100) : 0} tone={active.over ? 'orange' : 'indigo'} />
                  <div className="row between small muted">
                    <span>已排 {active.usedDays} / {active.capacity_days} 人日</span>
                    <span>{active.requirementCount} 条需求</span>
                  </div>
                </div>
              ) : <Empty title="暂无迭代" desc="在规划页创建迭代并把需求排入。" icon="○" />}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div><h3>近期动态</h3><p>项目内最近发生的状态与产物变化</p></div></div>
            <div className="card-body">
              {!data.recentEvents.length && <Empty title="暂无动态" />}
              <div className="timeline">
                {data.recentEvents.map((e: any) => (
                  <div key={e.id} className="timeline-item strong">
                    <div className="t-main">{e.req_code && <span className="code mb8" style={{ marginRight: 6 }}>{e.req_code}</span>}{e.message}</div>
                    <div className="t-meta">{e.actor_name || '系统'} · {fmtTime(e.created_at)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <div><h3>风险与待办</h3><p>{data.riskTotal} 项风险，{data.unread} 条未读通知</p></div>
              <button className="link-btn" onClick={() => navigate(`/p/${projectId}/tracking`)}>跟进 →</button>
            </div>
            <div className="card-body">
              {!data.risks.length && <Empty title="暂无风险" desc="停滞、逾期与容量超限会在这里提示。" icon="✓" />}
              <div className="stack">
                {data.risks.map((r: any, i: number) => (
                  <div key={i} className="section-block">
                    <div className="inner">
                      <div className="row between">
                        <Tag tone={r.level === 'high' ? 'red' : 'amber'}>{r.level === 'high' ? '高' : '中'} · {r.type}</Tag>
                        {r.requirementId && <button className="link-btn" onClick={() => navigate(`/p/${projectId}/requirements/${r.requirementId}`)}>查看需求</button>}
                      </div>
                      <div className="mt8" style={{ fontWeight: 600 }}>{r.code} {r.title}</div>
                      <div className="small muted">{r.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div><h3>项目摘要</h3><p>确定性口径，可直接引用到周报</p></div>
              <button className="btn sm" onClick={() => summary.reload()}>刷新</button></div>
            <div className="card-body">
              {summary.loading && <Loading />}
              {summary.error && <ErrorBox message={summary.error} />}
              {summary.data && (
                <ul className="list-clean">
                  {summary.data.lines.map((l: string, i: number) => <li key={i}>{l}</li>)}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
