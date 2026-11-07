import React, { useState } from 'react'
import { fmtTime, get, navigate } from '../api'
import { Empty, ErrorBox, Loading, PageHeader, StatusTag, Tabs, Tag, useAsync } from '../ui'

const SG_TONE: Record<string, string> = { '待处理': 'amber', '处理中': 'orange', '不采纳待确认': 'brown', '已消除': 'green', '已关闭': 'slate', '已合并': 'gray' }

export default function ReviewCenter({ projectId }: any) {
  const [tab, setTab] = useState('reviews')
  const [onlyOpen, setOnlyOpen] = useState(false)
  const reviews = useAsync<any[]>(() => get(`/api/projects/${projectId}/reviews`), [projectId])
  const suggestions = useAsync<any[]>(() => get(`/api/projects/${projectId}/suggestions`), [projectId])

  const openSg = (suggestions.data || []).filter(s => ['待处理', '处理中', '不采纳待确认'].includes(s.status))

  return (
    <>
      <PageHeader title="评审中心" desc="跨需求的评审轮次与改进建议。评审通过且建议全部闭环后，需求才能进入开发。"
        actions={<button className="btn" onClick={() => { reviews.reload(); suggestions.reload() }}>刷新</button>} />

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'reviews', label: '评审轮次', badge: reviews.data?.filter(r => r.status !== '已完成').length },
        { key: 'suggestions', label: '改进建议', badge: openSg.length }
      ]} />

      {tab === 'reviews' && (
        <div className="card"><div className="card-body tight">
          {reviews.loading && <Loading />}
          {reviews.error && <ErrorBox message={reviews.error} onRetry={reviews.reload} />}
          {reviews.data && !reviews.data.length && <Empty title="还没有评审" desc="发布说明书后，可在工作台发起评审。" />}
          {reviews.data && reviews.data.length > 0 && (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>需求</th><th>轮次</th><th>评审人</th><th>状态</th><th>结论</th><th>未闭环建议</th><th>发起时间</th><th></th></tr></thead>
              <tbody>{reviews.data.map(r => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/p/${projectId}/req/${r.requirement_id}/review`)}>
                  <td><span className="code">{r.code}</span> <span className="title-cell">{r.title}</span></td>
                  <td>第 {r.round} 轮</td>
                  <td className="small">{r.reviewerNames.join('、') || '—'}</td>
                  <td><Tag tone={r.status === '进行中' ? 'amber' : r.status === '已完成' ? 'green' : 'gray'}>{r.status}</Tag></td>
                  <td>{r.conclusion ? <Tag tone={r.conclusion === '通过' ? 'green' : 'red'}>{r.conclusion}</Tag> : <span className="muted">—</span>}</td>
                  <td>{r.openSuggestions ? <Tag tone="orange">{r.openSuggestions}</Tag> : <span className="muted">0</span>}</td>
                  <td className="muted small nowrap">{fmtTime(r.created_at)}</td>
                  <td className="actions"><button className="btn sm" onClick={e => { e.stopPropagation(); navigate(`/p/${projectId}/req/${r.requirement_id}/review`) }}>进入评审</button></td>
                </tr>))}</tbody>
            </table></div>
          )}
        </div></div>
      )}

      {tab === 'suggestions' && (
        <div className="card">
          <div className="card-head">
            <div><h3>改进建议台账</h3><p>共 {(suggestions.data || []).length} 条，未闭环 {openSg.length} 条</p></div>
            <label className="checkline"><input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} />只看未闭环</label>
          </div>
          <div className="card-body tight">
            {suggestions.loading && <Loading />}
            {suggestions.error && <ErrorBox message={suggestions.error} onRetry={suggestions.reload} />}
            {suggestions.data && !suggestions.data.length && <Empty title="暂无建议" />}
            {(onlyOpen ? openSg : suggestions.data || []).map(s => (
              <div key={s.id} className="inbox-item">
                <div className="body">
                  <h4>{s.title}</h4>
                  <div className="meta">
                    <span className="code">{s.code}</span><span className="truncate" style={{ maxWidth: 220 }}>{s.req_title}</span>
                    <StatusTag status={s.req_status} />
                    <Tag tone={SG_TONE[s.status] || 'gray'}>{s.status}</Tag>
                    <span>第 {s.round} 轮</span>
                    <span>{fmtTime(s.created_at)}</span>
                  </div>
                  <div className="excerpt" style={{ whiteSpace: 'pre-wrap' }}>{s.detail}</div>
                </div>
                <button className="btn sm" onClick={() => navigate(`/p/${projectId}/req/${s.requirement_id}/review`)}>处理</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
