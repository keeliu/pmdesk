import React, { useState } from 'react'
import { fmtTime, get } from '../api'
import { Empty, ErrorBox, Loading, StatusTag, Tag, useAsync } from '../ui'

export default function Shared({ token }: { token: string }) {
  const { data, loading, error } = useAsync<any>(() => get(`/api/public/shares/${token}`), [token])
  const [pageId, setPageId] = useState('')
  if (loading) return <div style={{ padding: 60 }}><Loading label="正在加载分享内容…" /></div>
  if (error) return <div className="shared-page"><ErrorBox message={error} /></div>
  const a = data.analysis?.data
  const page = data.prototype?.pages?.find((p: any) => p.id === pageId) || data.prototype?.pages?.[0]
  return (
    <div className="shared-page">
      <div className="shared-head">
        <div className="row between">
          <div className="brand"><span className="brand-mark">需</span>{data.project.name} · 需求说明</div>
          <span className="shared-badge">只读分享 · 有效期至 {fmtTime(data.expiresAt)}</span>
        </div>
        <h1 style={{ marginTop: 18, fontSize: 24 }}>{data.requirement.code || '未编号'} {data.requirement.title}</h1>
        <div className="row wrap mt8">
          <StatusTag status={data.requirement.status} />
          {data.analysis && <Tag tone="blue">分析 V{data.analysis.version}</Tag>}
          {data.spec && <Tag tone="violet">说明书 V{data.spec.version}</Tag>}
          {data.prototype && <Tag tone="teal">原型 V{data.prototype.version}</Tag>}
        </div>
      </div>

      {data.requirement.snapshot?.clarification && (
        <div className="card mb12">
          <div className="card-head"><div><h3>澄清结论</h3><p>确认入池时的不可变快照</p></div></div>
          <div className="card-body">
            <dl className="kv" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
              {[['角色与岗位', 'roles'], ['目标与价值', 'goal'], ['范围', 'scope'], ['边界', 'boundary'], ['验收口径', 'acceptance']].map(([label, key]) => (
                <div key={key}><dt>{label}</dt><dd>{data.requirement.snapshot.clarification[key]?.value || '—'}</dd></div>
              ))}
            </dl>
            <div className="row wrap mt12">{(data.requirement.involvedApps || []).map((x: any) => <Tag key={x.name} tone={x.kind === 'external' ? 'amber' : 'blue'}>{x.name}{x.kind === 'external' ? '（外部）' : ''}</Tag>)}</div>
          </div>
        </div>
      )}

      {a && (
        <div className="stack mb12">
          <div className="analysis-section">
            <header><h4>一、需求描述</h4><span>分析与正文一致</span></header>
            <div className="body">
              <dl className="kv" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                <div><dt>背景</dt><dd>{a.description.background || '—'}</dd></div>
                <div><dt>目标</dt><dd>{a.description.goal || '—'}</dd></div>
                <div><dt>价值</dt><dd>{a.description.value || '—'}</dd></div>
                <div><dt>角色</dt><dd>{(a.description.roles || []).join('、') || '—'}</dd></div>
              </dl>
            </div>
          </div>
          <div className="analysis-section">
            <header><h4>二、业务流程说明</h4><span>{a.process.steps?.length || 0} 个节点</span></header>
            <div className="body">
              <p className="muted">{a.process.summary}</p>
              <div className="table-wrap"><table className="table">
                <thead><tr><th>节点</th><th>角色</th><th>动作</th><th>分支</th><th>结果</th><th>下一节点</th></tr></thead>
                <tbody>{(a.process.steps || []).map((s: any, i: number) => (
                  <tr key={i}><td>{s.node}</td><td>{s.role}</td><td>{s.action}</td><td>{s.branch || '—'}</td><td>{s.result || '—'}</td><td>{s.next || '—'}</td></tr>))}</tbody>
              </table></div>
            </div>
          </div>
          <div className="analysis-section">
            <header><h4>三、功能设计</h4><span>{a.functions.list?.length || 0} 项功能</span></header>
            <div className="body">
              <div className="table-wrap"><table className="table">
                <thead><tr><th>功能</th><th>说明</th><th>优先级</th><th>验收要点</th></tr></thead>
                <tbody>{(a.functions.list || []).map((f: any) => (
                  <tr key={f.id || f.name}><td className="title-cell">{f.name}</td><td>{f.description}</td><td>{f.priority}</td><td>{f.acceptance}</td></tr>))}</tbody>
              </table></div>
            </div>
          </div>
          <div className="analysis-section">
            <header><h4>四、集成说明</h4><span>{a.integration.apps?.length || 0} 个应用</span></header>
            <div className="body">
              <div className="row wrap">{(a.integration.apps || []).map((x: any) => <Tag key={x.name} tone={x.kind === 'external' ? 'amber' : 'blue'}>{x.name}{x.kind === 'external' ? '（外部依赖）' : ''}</Tag>)}</div>
              <div className="table-wrap"><table className="table">
                <thead><tr><th>应用</th><th>方向</th><th>数据对象</th><th>触发时机</th></tr></thead>
                <tbody>{(a.integration.points || []).map((p: any) => <tr key={p.id}><td>{p.app}</td><td>{p.direction}</td><td>{p.object}</td><td>{p.trigger}</td></tr>)}</tbody>
              </table></div>
            </div>
          </div>
        </div>
      )}

      {data.spec && (
        <div className="card mb12">
          <div className="card-head"><div><h3>需求分析说明书 V{data.spec.version}</h3><p>只读预览</p></div></div>
          <div className="card-body">
            <iframe className="spec-frame" srcDoc={data.spec.html} title="说明书预览" sandbox="allow-same-origin" />
          </div>
        </div>
      )}

      {data.prototype && (
        <div className="card mb12">
          <div className="card-head"><div><h3>界面原型 V{data.prototype.version}</h3><p>点击页面切换预览，不产生任何写入</p></div></div>
          <div className="card-body">
            <div className="proto-tabs mb8">{data.prototype.pages.map((p: any) => (
              <button key={p.id} className={`proto-tab ${page?.id === p.id ? 'active' : ''}`} onClick={() => setPageId(p.id)}>{p.name}</button>))}</div>
            {page && <div className="proto-frame-wrap"><div className="frame-bar"><span className="dots"><i /><i /><i /></span>{page.name}</div>
              <iframe src={`/api/public/shares/${token}/pages/${page.id}`} title={page.name} /></div>}
          </div>
        </div>
      )}

      {!data.spec && !data.prototype && !a && <Empty title="暂无可展示内容" desc="需求还在澄清或分析阶段。" />}
      <p className="muted small" style={{ textAlign: 'center', marginTop: 24 }}>此页面为只读分享，内容以分享时刻的项目数据为准。</p>
    </div>
  )
}
