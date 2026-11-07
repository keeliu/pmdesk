import React, { useEffect, useState } from 'react'
import { fmtTime, get, post } from '../../api'
import { STATUS_INDEX } from '../../status'
import { Empty, ErrorBox, Loading, Tag, useAsync, useToast } from '../../ui'

type Props = { reqId: string; detail: any; onRefresh: () => Promise<void> }

const EVIDENCE_LABEL: Record<string, string> = {
  description: '需求描述依据', process: '业务流程依据', functions: '功能设计依据',
  integration: '集成说明依据', acceptance: '验收标准依据'
}

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="analysis-section">
      <header><h4>{title}</h4><span>{extra}</span></header>
      <div className="body">{children}</div>
    </div>
  )
}

export default function AnalysisView({ reqId, detail, onRefresh }: Props) {
  const toast = useToast()
  const analysis = useAsync<any>(() => get(`/api/requirements/${reqId}/analysis`), [reqId, detail.updated_at])
  const versions = useAsync<any[]>(() => get(`/api/requirements/${reqId}/versions`), [reqId, detail.updated_at])
  const [busy, setBusy] = useState('')
  const [openVersion, setOpenVersion] = useState('')

  if (analysis.loading && !analysis.data) return <Loading label="加载分析…" />
  if (analysis.error) return <ErrorBox message={analysis.error} onRetry={analysis.reload} />

  const data = analysis.data
  const a = data?.analysis
  const has = Boolean(data?.version)
  const check = data?.check || { ok: false, issues: [] }
  const locked = (STATUS_INDEX[detail.status] ?? -1) >= STATUS_INDEX['需求评审中'] || ['已关闭', '已丢弃'].includes(detail.status)
  const isPm = ['pm', 'admin'].includes(detail.role)

  const submit = async () => {
    setBusy('submit')
    try {
      await post(`/api/requirements/${reqId}/analysis`, { analysis: a, submit: true, note: '从工作台提交分析' })
      toast.push('分析已通过校验并提交', 'success')
      await onRefresh()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const recheck = async () => {
    setBusy('check')
    try {
      const r = await post<any>(`/api/requirements/${reqId}/analysis/check`, {})
      toast.push(r.ok ? '一致性校验通过' : `仍有 ${r.issues.filter((i: any) => i.level === 'error').length} 项阻断问题`, r.ok ? 'success' : 'warn')
      analysis.reload()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const rollback = async (version: number) => {
    if (!confirm(`回退到 V${version}？回退会生成一个新版本，不会删除历史。`)) return
    setBusy('rollback')
    try {
      await post(`/api/requirements/${reqId}/analysis/rollback`, { version })
      toast.push(`已回退到 V${version}`, 'success')
      await onRefresh()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  if (!has) {
    return (
      <Empty icon="◫" title="还没有分析版本"
        desc="在左侧会话里说「生成需求分析初稿」，或在澄清结论基础上补充功能与集成要求后生成。分析会同时生成需求描述、业务流程、功能设计与集成说明四部分；未通过质量门禁时只返回待补骨架，不会写入版本。"
        action={<span className="tag tone-gray">等待生成</span>} />
    )
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-body row wrap" style={{ justifyContent: 'space-between' }}>
          <div className="row wrap">
            <strong>分析 V{data.version}</strong>
            <span className="muted small">{fmtTime(data.created_at)}</span>
            <Tag tone={check.ok ? 'green' : 'red'}>{check.ok ? '校验通过' : `${check.issues.filter((i: any) => i.level === 'error').length} 项阻断`}</Tag>
            {locked && <Tag tone="slate">已锁版</Tag>}
          </div>
          <div className="row">
            <button className="btn sm" disabled={busy !== ''} onClick={recheck}>重新校验</button>
            <button className="btn sm primary" disabled={locked || busy !== ''} onClick={submit}>提交分析</button>
          </div>
        </div>
      </div>

      {check.issues?.length > 0 && (
        <div className="section-block">
          <h4>一致性检查 <span className="tag tone-amber">{check.issues.length}</span></h4>
          <div className="inner issue-list">
            {check.issues.map((i: any, idx: number) => (
              <div key={idx} className={`issue ${i.level === 'error' ? 'error' : 'warn'}`}>
                <span className="mono" style={{ minWidth: 116 }}>{i.field}</span><span>{i.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {a.meta?.skill && (
        <div className="section-block">
          <h4>生成依据 <span className="muted tiny">{a.meta.skill.slug} v{a.meta.skill.version}</span></h4>
          <div className="inner stack" style={{ gap: 8 }}>
            {Object.entries(a.meta.evidence || {}).map(([key, items]: any) => (
              <div key={key}>
                <div className="tiny muted">{EVIDENCE_LABEL[key] || key}</div>
                <ul className="list-clean">{(items || []).map((t: string, i: number) => <li key={i} className="small">· {t}</li>)}</ul>
              </div>
            ))}
            {a.meta.missing?.length > 0 && (
              <div className="notice warn">生成时缺失输入：{a.meta.missing.join('、')}</div>
            )}
          </div>
        </div>
      )}

      <Section title="需求描述" extra="来自澄清结论与原文">
        <div>
          <div className="section-title">现状与背景</div>
          <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{a.description.background || '—'}</p>
        </div>
        <div>
          <div className="section-title">目标与价值</div>
          <p className="small">{a.description.goal || '—'}</p>
          <p className="small muted mt8">{a.description.value || ''}</p>
        </div>
        <div>
          <div className="section-title">使用角色</div>
          <div className="row wrap">{(a.description.roles || []).map((r: string) => <Tag key={r} tone="blue">{r}</Tag>)}</div>
        </div>
      </Section>

      <Section title="业务流程说明" extra={`${a.process.steps?.length || 0} 个步骤`}>
        <p className="small">{a.process.summary || '—'}</p>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>节点</th><th>角色</th><th>动作</th><th>分支</th><th>结果</th><th>下一步</th></tr></thead>
            <tbody>
              {(a.process.steps || []).map((s: any, i: number) => (
                <tr key={i}>
                  <td>{s.no || i + 1}</td><td className="title-cell">{s.node}</td><td>{s.role}</td>
                  <td>{s.action}</td><td>{s.branch}</td><td>{s.result}</td><td>{s.next}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="功能设计" extra={`${a.functions.list?.length || 0} 项功能`}>
        <div>
          <div className="section-title">功能架构</div>
          <div className="row wrap">
            {(a.functions.architecture || []).map((n: any) => (
              <span key={n.id || n.name} className="file-pill" style={{ background: n.parent ? 'var(--surface-2)' : undefined }}>
                {n.parent ? `${n.parent} / ` : ''}{n.name}
                {n.priority && <span className="tag tone-gray" style={{ height: 18 }}>{n.priority}</span>}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="section-title">功能说明</div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>编号</th><th>功能</th><th>说明</th><th>优先级</th><th>验收要点</th></tr></thead>
              <tbody>
                {(a.functions.list || []).map((f: any) => (
                  <tr key={f.id || f.name}>
                    <td className="mono">{f.id || '—'}</td><td className="title-cell">{f.name}</td>
                    <td>{f.description}</td><td><Tag tone={f.priority === 'P0' ? 'red' : f.priority === 'P1' ? 'orange' : 'gray'}>{f.priority}</Tag></td>
                    <td>{f.acceptance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div className="section-title">功能流程图</div>
          <div className="stack" style={{ gap: 6 }}>
            {(a.functions.flow || []).map((f: any) => (
              <div key={f.id || `${f.from}-${f.to}`} className="row small wrap">
                <span className="file-pill">{f.from}</span><span>→</span>
                <span>{f.action}</span>
                {f.condition && <span className="muted">（{f.condition}）</span>}
                <span>→</span><span className="file-pill">{f.to}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="section-title">辅助支撑功能</div>
          {(a.functions.support || []).length
            ? <ul className="list-clean">{a.functions.support.map((s: any) => <li key={s.id || s.name}><strong>{s.name}</strong> · {s.description}</li>)}</ul>
            : <p className="muted small">未登记辅助支撑功能</p>}
        </div>
      </Section>

      <Section title="集成说明" extra={`${a.integration.apps?.length || 0} 个应用`}>
        <div>
          <div className="section-title">涉及应用</div>
          <div className="row wrap">
            {(a.integration.apps || []).map((app: any) => (
              <Tag key={app.name} tone={app.kind === 'external' ? 'amber' : 'indigo'}>{app.name}{app.kind === 'external' ? ' · 外部' : ''}</Tag>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>编号</th><th>应用</th><th>方向</th><th>数据对象</th><th>触发时机</th><th>备注</th></tr></thead>
            <tbody>
              {(a.integration.points || []).map((p: any) => (
                <tr key={p.id || `${p.app}-${p.object}`}>
                  <td className="mono">{p.id}</td><td>{p.app}</td><td>{p.direction}</td><td>{p.object}</td><td>{p.trigger}</td><td>{p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="验收标准" extra={a.acceptance.metrics?.length ? `${a.acceptance.metrics.length} 项指标` : ''}>
        <ol className="list-clean" style={{ paddingLeft: 18 }}>
          {(a.acceptance.steps || []).map((s: string, i: number) => <li key={i} style={{ listStyle: 'decimal' }}>{s}</li>)}
        </ol>
        <p className="small"><strong>整体完成标准：</strong>{a.acceptance.overall || '—'}</p>
        {(a.acceptance.metrics || []).length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>指标</th><th>目标</th><th>观察周期</th></tr></thead>
              <tbody>{a.acceptance.metrics.map((m: any) => <tr key={m.name}><td>{m.name}</td><td>{m.target}</td><td>{m.period}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="section-block">
        <h4>版本历史 <span className="muted tiny">回退会生成新版本</span></h4>
        <div className="inner">
          {(versions.data || []).map((v: any) => (
            <div key={v.id} className="dep-row">
              <span className="mono">V{v.version}</span>
              <span className="grow truncate">{v.note}</span>
              <span className="tiny muted nowrap">{v.created_by_name || ''} {fmtTime(v.created_at)}</span>
              {openVersion === v.id ? (
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn sm" onClick={() => setOpenVersion('')}>取消</button>
                  <button className="btn sm primary" disabled={busy !== ''} onClick={() => rollback(v.version)}>确认回退</button>
                </div>
              ) : (
                <button className="btn sm ghost" disabled={!isPm || v.version === data.version} onClick={() => setOpenVersion(v.id)}>回退到此版本</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
