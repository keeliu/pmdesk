import React, { useState } from 'react'
import { downloadUrl, fmtDay, fmtTime, get, navigate, post, PRIORITY_TONE } from '../api'
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader, Progress, StatusTag, Tag, useAsync, useToast } from '../ui'
import BatchStatusModal from '../components/BatchStatusModal'
import BatchProgressModal from '../components/BatchProgressModal'

const STATUS_LABEL: Record<string, string> = { planning: '规划中', active: '进行中', released: '已发布' }
const MODE_LABEL: Record<string, string> = { draft: '草稿版', formal: '正式版' }
const SPEC_STATUS: Record<string, string> = { draft: '草稿', published: '已发布', superseded: '已被替代' }
const SOURCE_LABEL: Record<string, string> = { builtin: '内置', import: '导入', reference: '引用' }

function nextMilestone(ms: any) {
  if (!ms?.fields) return null
  return ms.fields.find((f: any) => f.plan && !f.actual) || ms.fields.find((f: any) => !f.actual) || null
}

export default function IterationDetail({ projectId, iterationId, projectRole }: any) {
  const toast = useToast()
  const detail = useAsync<any>(() => get(`/api/projects/${projectId}/iterations/${iterationId}`), [projectId, iterationId])
  const iterations = useAsync<any[]>(() => get(`/api/projects/${projectId}/iterations`), [projectId])
  const [selected, setSelected] = useState<string[]>([])
  const [batchOpen, setBatchOpen] = useState(false)
  const [progressOpen, setProgressOpen] = useState(false)
  const [specOpen, setSpecOpen] = useState(false)
  const [specMode, setSpecMode] = useState<'draft' | 'formal'>('draft')
  const [specSkills, setSpecSkills] = useState<any[]>([])
  const [specSkillId, setSpecSkillId] = useState('')
  const [specSkillLoading, setSpecSkillLoading] = useState(false)
  const [specSkillError, setSpecSkillError] = useState('')
  const [previousSkillMissing, setPreviousSkillMissing] = useState(false)
  const [missing, setMissing] = useState<any[]>([])
  const [busy, setBusy] = useState('')

  if (detail.loading && !detail.data) return <Loading label="加载迭代详情…" />
  if (detail.error) return <ErrorBox message={detail.error} onRetry={detail.reload} />

  const d = detail.data
  const it = d.iteration
  const perms = d.permissions
  const groups = d.groups || []
  const reqs = d.requirements || []
  const coverage = d.coverage
  const allSelected = reqs.length > 0 && selected.length === reqs.length

  const toggle = (id: string) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  const toggleAll = () => setSelected(allSelected ? [] : reqs.map((r: any) => r.id))

  const moveOut = async (r: any) => {
    if (!confirm(`把「${r.title}」移出本迭代？`)) return
    setBusy(r.id)
    try {
      await post(`/api/requirements/${r.id}/schedule`, { iterationId: null })
      toast.push('已移出迭代', 'success')
      await detail.reload()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const openSpec = async () => {
    setMissing([])
    setSpecOpen(true)
    setSpecSkills([])
    setSpecSkillId('')
    setSpecSkillError('')
    setPreviousSkillMissing(false)
    setSpecSkillLoading(true)
    try {
      const r = await get<any>(`/api/projects/${projectId}/skills`)
      const list = (r.skills || []).filter((s: any) => s.enabled && (s.stages || []).includes('spec'))
      setSpecSkills(list)
      const previousSkillId = (d.specs || []).find((s: any) => s.skill_binding_id)?.skill_binding_id || ''
      const previousAvailable = previousSkillId && list.some((s: any) => s.id === previousSkillId)
      if (previousSkillId && !previousAvailable) setPreviousSkillMissing(true)
      const builtin = list.find((s: any) => s.isBuiltin && s.slug === 'prd-assemble')
      const preferred = previousAvailable ? previousSkillId : (builtin?.id || (list.length === 1 ? list[0].id : ''))
      setSpecSkillId(preferred || '')
    } catch (e: any) {
      setSpecSkillError(e.message)
    } finally {
      setSpecSkillLoading(false)
    }
  }

  const generate = async () => {
    if (!specSkillId) {
      toast.push('请先选择说明书技能', 'error')
      return
    }
    setBusy('spec')
    setMissing([])
    try {
      const r = await post<any>(`/api/projects/${projectId}/iterations/${iterationId}/specs/generate`, { mode: specMode, skillBindingId: specSkillId })
      toast.push(`已生成${MODE_LABEL[r.mode]} V${r.version}，使用技能「${r.skill?.name}」V${r.skill?.version}，纳入 ${r.requirementCount} 条需求`, 'success')
      setSpecOpen(false)
      await detail.reload()
    } catch (e: any) {
      setMissing(Array.isArray(e.details?.missing) ? e.details.missing : [])
      toast.push(e.message, 'error')
    } finally { setBusy('') }
  }

  const openPreview = (s: any) => {
    window.open(`/api/iteration-specs/${s.id}/preview`, '_blank', 'noopener,noreferrer')
  }

  return (
    <>
      <PageHeader back={() => navigate(`/p/${projectId}/iterations`)}
        title={<span className="row wrap" style={{ gap: 8 }}>{it.name}
          <Tag tone={it.status === 'active' ? 'teal' : it.status === 'released' ? 'green' : 'gray'}>{STATUS_LABEL[it.status] || it.status}</Tag>
          {perms.readOnly && <Tag tone="slate">只读</Tag>}
        </span>}
        desc={<>{fmtDay(it.start_date)} ~ {fmtDay(it.end_date)} · {it.goal || '未填写迭代目标'}</>}
        actions={<>
          <button className="btn" onClick={() => detail.reload()}>刷新</button>
          {perms.canBatch && <button className="btn" onClick={() => setProgressOpen(true)}>批量维护进展{selected.length ? `（${selected.length}）` : '（全部）'}</button>}
          {perms.canBatch && <button className="btn" onClick={() => setBatchOpen(true)}>批量更新状态{selected.length ? `（${selected.length}）` : '（全部）'}</button>}
          {perms.canGenerateSpec && <button className="btn" onClick={openSpec}>生成迭代说明书</button>}
          <button className="btn" onClick={() => navigate(`/p/${projectId}/planning`)}>规划</button>
        </>} />

      {perms.readOnly && <div className="notice warn mb12">该迭代已发布，需求排期、批量状态与说明书生成均已锁定；历史说明书仍可预览与导出。</div>}
      {it.over && <div className="notice warn mb12">容量超限：已排 {it.usedDays} 人日 / 容量 {it.capacity_days} 人日，请调整范围或容量。</div>}

      <div className="grid c4 mb12">
        <div className="card"><div className="card-body">
          <div className="row between small"><span className="muted">容量占用</span><span className={it.over ? 'danger-text' : ''}>{it.usedDays} / {it.capacity_days || '—'} 人日</span></div>
          <Progress value={it.capacity_days ? Math.min(100, it.usedDays / it.capacity_days * 100) : 0} tone={it.over ? 'orange' : 'teal'} />
          <div className="tiny muted mt8">利用率 {it.utilization === null ? '—' : `${it.utilization}%`}</div>
        </div></div>
        <div className="card"><div className="card-body">
          <div className="row between small"><span className="muted">交付进度</span><span>{it.progress}%</span></div>
          <Progress value={it.progress} tone="indigo" />
          <div className="tiny muted mt8">{it.requirementCount} 条需求 · 全国推广中及已关闭计入</div>
        </div></div>
        <div className="card"><div className="card-body">
          <div className="muted small mb8">覆盖率</div>
          <div className="stack" style={{ gap: 4 }}>
            <div className="row between tiny"><span>需求分析</span><span>{coverage.analysis.done}/{coverage.analysis.total} · {coverage.analysis.pct}%</span></div>
            <div className="row between tiny"><span>原型确认</span><span>{coverage.prototype.done}/{coverage.prototype.total} · {coverage.prototype.pct}%</span></div>
            <div className="row between tiny"><span>说明书发布</span><span>{coverage.spec.done}/{coverage.spec.total} · {coverage.spec.pct}%</span></div>
          </div>
        </div></div>
        <div className="card"><div className="card-body">
          <div className="muted small mb8">风险与阻塞</div>
          <div className="row wrap"><Tag tone={d.milestones.overdueCount ? 'red' : 'gray'}>里程碑逾期 {d.milestones.overdueCount}</Tag><Tag tone={d.blockers.length ? 'amber' : 'gray'}>阻塞 {d.blockers.length}</Tag></div>
          <div className="tiny muted mt8">依赖 {d.dependencies.length} 条 · 说明书 {d.specs.length} 个版本</div>
        </div></div>
      </div>

      <div className="grid c2 mb12">
        <div className="card">
          <div className="card-head"><div><h3>状态分布</h3><p>按当前状态分组，点击表格可定位</p></div></div>
          <div className="card-body">
            {!groups.length && <p className="muted small">暂无需求</p>}
            <div className="row wrap" style={{ gap: 6 }}>
              {groups.map((g: any) => <span key={g.status} className="file-pill"><StatusTag status={g.status} /><strong>{g.count}</strong></span>)}
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div><h3>里程碑</h3><p>计划未登记实际时间的节点</p></div><Tag tone={d.milestones.overdueCount ? 'red' : 'gray'}>{d.milestones.overdueCount} 逾期</Tag></div>
          <div className="card-body tight" style={{ maxHeight: 180, overflow: 'auto' }}>
            {!d.milestones.overdue.length && !d.milestones.upcoming.length && <p className="muted small">未登记计划时间</p>}
            {d.milestones.overdue.map((m: any, i: number) => (
              <div key={`o${i}`} className="dep-row"><Tag tone="red">逾期</Tag><span className="code">{m.code || '未编号'}</span><span className="grow truncate">{m.label}</span><span className="tiny muted">{fmtDay(m.plan)}</span></div>
            ))}
            {d.milestones.upcoming.map((m: any, i: number) => (
              <div key={`u${i}`} className="dep-row"><Tag tone="blue">待办</Tag><span className="code">{m.code || '未编号'}</span><span className="grow truncate">{m.label}</span><span className="tiny muted">{fmtDay(m.plan)}</span></div>
            ))}
          </div>
        </div>
      </div>

      {d.blockers.length > 0 && (
        <div className="card mb12">
          <div className="card-head"><div><h3>阻塞项</h3><p>停滞、建议积压、里程碑逾期与容量</p></div><Tag tone="amber">{d.blockers.length}</Tag></div>
          <div className="card-body tight">
            {d.blockers.map((b: any, i: number) => (
              <div key={i} className="dep-row">
                <Tag tone={b.type === '容量超限' || b.type === '迭代逾期' ? 'red' : 'amber'}>{b.type}</Tag>
                <span className="grow">{b.code} {b.title}</span>
                <span className="muted small">{b.detail}</span>
                {b.requirementId && <button className="btn sm" onClick={() => navigate(`/p/${projectId}/req/${b.requirementId}/analysis`)}>处理</button>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card mb12">
        <div className="card-head">
          <div><h3>迭代需求</h3><p>共 {reqs.length} 条；勾选后可批量更新状态</p></div>
          <div className="row">
            {perms.canBatch && <> <button className="btn sm" onClick={toggleAll}>{allSelected ? '取消全选' : '全选'}</button>
              <button className="btn sm primary" disabled={!selected.length} onClick={() => setBatchOpen(true)}>批量更新</button></>}
          </div>
        </div>
        <div className="card-body tight">
          {!reqs.length && <Empty title="迭代内还没有需求" desc="到规划页把需求拖入本迭代。" icon="○"
            action={<button className="btn primary mt8" onClick={() => navigate(`/p/${projectId}/planning`)}>规划</button>} />}
          {reqs.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr>
                  {perms.canBatch && <th style={{ width: 32 }}><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>}
                  <th>编号</th><th>需求</th><th>状态</th><th>优先级</th><th>产品经理</th><th>负责人</th><th>里程碑</th><th>覆盖</th><th></th>
                </tr></thead>
                <tbody>
                  {reqs.map((r: any) => {
                    const ms = nextMilestone(r.milestones)
                    return (
                      <tr key={r.id}>
                        {perms.canBatch && <td><input type="checkbox" checked={selected.includes(r.id)} onChange={() => toggle(r.id)} /></td>}
                        <td className="mono tiny">{r.code ? <button className="link-btn mono" onClick={() => navigate(`/p/${projectId}/requirements/${r.id}`)}>{r.code}</button> : '—'}</td>
                        <td className="title-cell"><button className="link-btn" onClick={() => navigate(`/p/${projectId}/requirements/${r.id}`)}>{r.title}</button></td>
                        <td><StatusTag status={r.status} /></td>
                        <td>{r.priority.grade ? <Tag tone={PRIORITY_TONE[r.priority.grade]}>{r.priority.gradeLabel}</Tag> : <span className="muted">未评估</span>}</td>
                        <td className="small">{r.productManager || '—'}</td>
                        <td className="small">{r.ownerName || '—'}</td>
                        <td className="small">{ms ? `${ms.label}${ms.overdue ? ' · 逾期' : ''}` : '—'}
                          {ms && <div className="tiny muted">{fmtDay(ms.plan || ms.actual)}</div>}</td>
                        <td className="tiny muted nowrap">分析 {r.analysisVersion ? `V${r.analysisVersion}` : '—'}<br />说明书 {r.spec ? `V${r.spec.version}·${SPEC_STATUS[r.spec.status] || r.spec.status}` : '—'}</td>
                        <td className="actions">
                          <button className="btn sm" onClick={() => navigate(`/p/${projectId}/requirements/${r.id}`)}>查看详情</button>
                          <button className="btn sm ghost" onClick={() => navigate(`/p/${projectId}/req/${r.id}/analysis`)}>工作台</button>
                          {perms.canSchedule && <button className="btn sm ghost" disabled={busy === r.id} onClick={() => moveOut(r)}>移出</button>}
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

      {d.dependencies.length > 0 && (
        <div className="card mb12">
          <div className="card-head"><div><h3>跨迭代依赖</h3><p>前置未上线时应在评审中提示风险</p></div></div>
          <div className="card-body">
            {d.dependencies.map((x: any) => (
              <div key={x.id} className="dep-row">
                <Tag tone="blue">前置</Tag><span className="grow truncate">{x.from.code} {x.from.title}</span>
                <span className="muted">→</span>
                <Tag tone="violet">后置</Tag><span className="grow truncate">{x.to.code} {x.to.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div><h3>迭代需求分析说明书</h3><p>按迭代整合全部需求章节，单文件自包含 HTML，可在线预览与导出</p></div>
          {perms.canGenerateSpec && <button className="btn primary" disabled={perms.readOnly} onClick={openSpec}>生成新版本</button>}
        </div>
        <div className="card-body tight">
          {!d.specs.length && <Empty title="还没有生成迭代说明书" desc="草稿版允许存在待补项，正式版要求每条需求的分析与说明书齐备。"
            action={perms.canGenerateSpec && <button className="btn primary mt8" disabled={perms.readOnly} onClick={openSpec}>生成草稿版</button>} />}
          {d.specs.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>版本</th><th>类型</th><th>技能</th><th>状态</th><th>纳入需求</th><th>生成时间</th><th>待补 / 过期</th><th>导出</th></tr></thead>
                <tbody>
                  {d.specs.map((s: any) => (
                    <tr key={s.id}>
                      <td className="mono">V{s.version}</td>
                      <td>{MODE_LABEL[s.mode] || s.mode}</td>
                      <td className="small">{s.skill ? <span className="code">{s.skill.slug}@{s.skill.version}</span> : <span className="muted">未记录技能</span>}</td>
                      <td><Tag tone={s.status === 'published' ? 'green' : s.status === 'draft' ? 'gray' : 'slate'}>{SPEC_STATUS[s.status] || s.status}</Tag>
                        {s.stale ? <Tag tone="amber">待更新</Tag> : null}</td>
                      <td>{s.requirement_count}</td>
                      <td className="small muted">{fmtTime(s.created_at)}</td>
                      <td className="small">{s.missing?.length ? <span className="danger-text">{s.missing.length} 条待补</span> : <span className="muted">—</span>}</td>
                      <td className="actions">
                        <button className="btn sm" onClick={() => openPreview(s)}>预览</button>
                        <button className="btn sm" onClick={() => downloadUrl(`/api/iteration-specs/${s.id}/docx`)}>Word</button>
                        <button className="btn sm" onClick={() => downloadUrl(`/api/iteration-specs/${s.id}/pdf`)}>PDF</button>
                        <button className="btn sm ghost" onClick={() => downloadUrl(`/api/iteration-specs/${s.id}/markdown`)}>Markdown</button>
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
        <BatchProgressModal projectId={projectId}
          iterationId={selected.length ? undefined : iterationId}
          requirementIds={selected.length ? selected : undefined}
          scopeLabel={selected.length ? `已选择 ${selected.length} 条需求` : `迭代「${it.name}」全部需求`}
          onClose={() => setProgressOpen(false)}
          onDone={async () => { setSelected([]); await detail.reload() }} />
      )}

      {batchOpen && (
        <BatchStatusModal projectId={projectId}
          iterationId={selected.length ? undefined : iterationId}
          requirementIds={selected.length ? selected : undefined}
          iterations={iterations.data || []}
          scopeLabel={selected.length ? `已选择 ${selected.length} 条需求` : `迭代「${it.name}」全部需求`}
          onClose={() => setBatchOpen(false)}
          onDone={async () => { setSelected([]); await detail.reload() }} />
      )}

      {specOpen && (
        <Modal title="生成迭代说明书" subtitle={`迭代「${it.name}」· 章节与需求条目一一对应`} onClose={() => setSpecOpen(false)}
          footer={<><button className="btn" onClick={() => setSpecOpen(false)}>取消</button>
            <button className="btn primary" disabled={busy === 'spec' || specSkillLoading || !specSkillId} onClick={generate}>{busy === 'spec' ? '生成中…' : `生成${MODE_LABEL[specMode]}`}</button></>}>
          <div className="stack">
            <div className="section-block">
              <h4>说明书技能</h4>
              {specSkillLoading && <Loading label="加载可用技能…" />}
              {specSkillError && <ErrorBox message={specSkillError} onRetry={openSpec} />}
              {!specSkillLoading && !specSkillError && !specSkills.length && (
                <div className="notice warn">
                  当前项目没有可用的说明书技能。请先在技能管理中导入或引用技能，并把「说明书」环节纳入适用范围。
                  <div className="mt8">
                    <button className="btn sm" onClick={() => { setSpecOpen(false); navigate(`/p/${projectId}/settings`) }}>前往技能管理</button>
                  </div>
                </div>
              )}
              {!specSkillLoading && !specSkillError && specSkills.length > 0 && (
                <Field label="使用技能" hint="文档由该技能的模板组装，Word 始终按标准章节生成">
                  <select value={specSkillId} onChange={e => setSpecSkillId(e.target.value)}>
                    <option value="">请选择说明书技能</option>
                    {specSkills.map((s: any) => (
                      <option key={s.id} value={s.id}>
                        {s.name} V{s.version} · {SOURCE_LABEL[s.sourceType] || s.sourceType}{s.sourceType === 'reference' && s.sourceProject ? `（${s.sourceProject.name}）` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {previousSkillMissing && !specSkillLoading && (
                <div className="notice warn mt8">上一版本使用的技能已不可用，请重新选择本次生成使用的技能。</div>
              )}
            </div>
            <div className="row wrap" style={{ gap: 18 }}>
              <label className="row small"><input type="radio" checked={specMode === 'draft'} onChange={() => setSpecMode('draft')} /> 草稿版</label>
              <label className="row small"><input type="radio" checked={specMode === 'formal'} onChange={() => setSpecMode('formal')} /> 正式版</label>
            </div>
            <div className="notice info">
              {specMode === 'draft'
                ? `草稿版会纳入当前 ${reqs.length} 条需求，缺失分析与说明书的条目进入待补清单，仍可生成。`
                : '正式版要求每条需求都有已提交分析、已确认原型与已发布说明书，缺一即阻断并列出待补清单。'}
            </div>
            {missing.length > 0 && (
              <div className="section-block">
                <h4>待补清单 <span className="tag tone-red">{missing.length}</span></h4>
                <div className="inner issue-list">
                  {missing.map((m: any, i: number) => (
                    <div key={i} className="issue error">
                      <span className="mono" style={{ minWidth: 90 }}>{m.code || '未编号'}</span>
                      <span>{m.title}：{(m.items || []).join('、')}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}
