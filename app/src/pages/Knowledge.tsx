import React, { useState } from 'react'
import { downloadUrl, fmtTime, get, navigate } from '../api'
import { Empty, ErrorBox, Loading, PageHeader, Tag, useAsync } from '../ui'

const TABS = [
  { key: '', label: '全部' },
  { key: 'flowchart', label: '流程图' },
  { key: 'prototype', label: '原型' },
  { key: 'spec', label: '需求说明书' }
]

const KIND_LABEL: Record<string, string> = {
  flowchart: '流程图', prototype: '原型', spec: '需求说明书', 'iteration-spec': '迭代说明书'
}

const KIND_TONE: Record<string, string> = {
  flowchart: 'indigo', prototype: 'violet', spec: 'blue', 'iteration-spec': 'gray'
}

function itemMeta(item: any) {
  const parts = []
  if (item.version) parts.push(`V${item.version}`)
  if (item.analysisVersion) parts.push(`分析 V${item.analysisVersion}`)
  if (item.kind === 'flowchart' && item.rendererText) parts.push(item.rendererText)
  if (item.pageCount) parts.push(`${item.pageCount} 页`)
  if (item.steps) parts.push(`${item.steps} 步`)
  if (item.statusText) parts.push(item.statusText)
  if (item.skill) parts.push(`${item.skill.slug}@${item.skill.version}`)
  else if (item.legacy) parts.push('旧版渲染')
  if (item.backfilled) parts.push('历史补登记')
  if (item.stale) parts.push('待更新')
  return parts.join(' · ')
}

export default function Knowledge({ projectId }: any) {
  const [category, setCategory] = useState('')
  const [q, setQ] = useState('')
  const [appliedQ, setAppliedQ] = useState('')
  const [iterationId, setIterationId] = useState('')
  const [pm, setPm] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const pageSize = 20

  const qs = new URLSearchParams()
  qs.set('page', String(page))
  qs.set('pageSize', String(pageSize))
  if (category) qs.set('category', category)
  if (appliedQ) qs.set('q', appliedQ)
  if (iterationId) qs.set('iterationId', iterationId)
  if (pm) qs.set('pm', pm)
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)

  const { data, loading, error, reload } = useAsync<any>(
    () => get(`/api/projects/${projectId}/knowledge?${qs.toString()}`),
    [projectId, category, appliedQ, iterationId, pm, from, to, page])

  const resetPage = () => setPage(1)
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const options = data?.options || { iterations: [], productManagers: [] }

  const preview = (item: any) => {
    const url = item.previewUrl || item.docxUrl
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <>
      <PageHeader title="知识库" desc="按流程图、原型、需求说明书统一管理过程产物；每条产物都标注所属需求、迭代、产品经理与创建/更新时间。"
        actions={<button className="btn" onClick={reload}>刷新</button>} />

      <div className="tabs">
        {TABS.map(t => (
          <button key={t.key} className={`tab ${category === t.key ? 'active' : ''}`}
            onClick={() => { setCategory(t.key); resetPage() }}>
            {t.label}{data?.counts && <span className="tab-badge">{t.key ? data.counts[t.key] || 0 : data.counts.all || 0}</span>}
          </button>
        ))}
      </div>

      <div className="card mb12">
        <div className="card-body row wrap">
          <div className="row grow">
            <input type="search" style={{ maxWidth: 280 }} value={q} placeholder="搜索产物、需求编号或迭代，回车检索"
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { setAppliedQ(q.trim()); resetPage() } }} />
            <button className="btn" onClick={() => { setAppliedQ(q.trim()); resetPage() }}>搜索</button>
          </div>
          <select style={{ width: 170 }} value={iterationId} onChange={e => { setIterationId(e.target.value); resetPage() }}>
            <option value="">全部迭代</option>
            {(options.iterations || []).map((it: any) => <option key={it.id} value={it.id}>{it.name}</option>)}
          </select>
          <select style={{ width: 150 }} value={pm} onChange={e => { setPm(e.target.value); resetPage() }}>
            <option value="">全部产品经理</option>
            {(options.productManagers || []).map((name: string) => <option key={name} value={name}>{name}</option>)}
          </select>
          <span className="row small muted">更新于</span>
          <input type="date" style={{ width: 150 }} value={from} onChange={e => { setFrom(e.target.value); resetPage() }} />
          <span className="muted small">~</span>
          <input type="date" style={{ width: 150 }} value={to} onChange={e => { setTo(e.target.value); resetPage() }} />
          {(appliedQ || iterationId || pm || from || to) && (
            <button className="btn sm ghost" onClick={() => { setQ(''); setAppliedQ(''); setIterationId(''); setPm(''); setFrom(''); setTo(''); resetPage() }}>清空筛选</button>
          )}
          <span className="muted small">共 {data?.total ?? 0} 项</span>
        </div>
      </div>

      <div className="card">
        <div className="card-body tight">
          {loading && !data && <Loading />}
          {error && <ErrorBox message={error} onRetry={reload} />}
          {data && !data.items.length && (
            <Empty title="没有匹配的产物" icon="◇"
              desc={category === 'flowchart' ? '分析版本提交并包含功能流程后，流程图会出现在这里。'
                : category === 'prototype' ? '生成并确认原型后，可在这里统一查看。'
                  : '生成并发布需求说明书或迭代说明书后，可在这里统一查看。'} />
          )}
          {data && data.items.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr>
                  <th>类型</th><th>产物</th><th>所属需求</th><th>迭代</th><th>产品经理</th>
                  <th>版本 / 状态</th><th>创建时间</th><th>更新时间</th><th></th>
                </tr></thead>
                <tbody>
                  {data.items.map((item: any) => (
                    <tr key={`${item.kind}-${item.id}`}>
                      <td><Tag tone={KIND_TONE[item.kind] || 'gray'}>{KIND_LABEL[item.kind] || item.kind}</Tag></td>
                      <td className="title-cell">
                        <button className="link-btn" style={{ textAlign: 'left' }} onClick={() => preview(item)}>{item.title}</button>
                        {item.unavailable && <div className="tiny muted">{item.unavailable}</div>}
                      </td>
                      <td>
                        {item.requirement ? (
                          <button className="link-btn" onClick={() => navigate(`/p/${projectId}/requirements/${item.requirement.id}`)}>
                            {item.requirement.code || item.requirement.title}
                          </button>
                        ) : <span className="muted">—</span>}
                        {item.requirement?.code && <div className="tiny muted truncate" style={{ maxWidth: 220 }}>{item.requirement.title}</div>}
                      </td>
                      <td className="small">
                        {item.iteration ? (
                          <button className="link-btn" onClick={() => navigate(`/p/${projectId}/iterations/${item.iteration.id}`)}>{item.iteration.name}</button>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td className="small">{item.productManager || <span className="muted">—</span>}</td>
                      <td className="small">{itemMeta(item) || '—'}</td>
                      <td className="small muted nowrap">{fmtTime(item.createdAt)}</td>
                      <td className="small muted nowrap">{fmtTime(item.updatedAt)}</td>
                      <td className="actions">
                        <button className="btn sm" disabled={!item.previewUrl && !item.docxUrl} onClick={() => preview(item)}>预览</button>
                        {item.docxUrl && (item.kind === 'iteration-spec' || item.status === 'published') &&
                          <button className="btn sm ghost" onClick={() => downloadUrl(item.docxUrl)}>Word</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {data && data.total > data.pageSize && (
          <div className="card-body row between" style={{ borderTop: '1px solid var(--line)' }}>
            <span className="muted small">第 {data.page} / {totalPages} 页</span>
            <div className="row">
              <button className="btn sm" disabled={data.page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>上一页</button>
              <button className="btn sm" disabled={data.page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>下一页</button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
