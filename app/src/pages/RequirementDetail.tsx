import React, { useEffect, useMemo, useState } from 'react'
import { downloadUrl, fmtDay, fmtTime, get, navigate, patch, post, PRIORITY_TONE } from '../api'
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader, StatusTag, Tag, useAsync, useToast } from '../ui'
import { statusLabel, STATUS_TONE } from '../status'

const LEAD_FIELDS = [
  { key: 'productManager', label: '产品经理' },
  { key: 'tech', label: '技术负责人' },
  { key: 'test', label: '测试负责人' },
  { key: 'implementation', label: '实施负责人' }
]

const DOC_GROUPS = [
  { key: 'flowcharts', label: '流程图', empty: '还没有分析版本包含功能流程。' },
  { key: 'prototypes', label: '原型', empty: '还没有生成原型。' },
  { key: 'specs', label: '需求说明书', empty: '还没有生成需求说明书。' },
  { key: 'iterationSpecs', label: '迭代说明书', empty: '该需求尚未纳入迭代说明书。' }
]

function docMeta(row: any) {
  const parts = []
  if (row.version) parts.push(`V${row.version}`)
  else if (row.analysisVersion) parts.push(`分析 V${row.analysisVersion}`)
  if (row.statusText) parts.push(row.statusText)
  if (row.stale) parts.push('待更新')
  if (row.pageCount) parts.push(`${row.pageCount} 页`)
  if (row.steps) parts.push(`${row.steps} 步`)
  return parts.join(' · ')
}

function docBadges(row: any) {
  const badges = []
  if (row.kind === 'flowchart') {
    badges.push({ tone: row.renderer === 'archify' ? 'teal' : 'gray', text: row.rendererText || '步骤清单' })
    if (row.skill) badges.push({ tone: 'indigo', text: `${row.skill.slug}@${row.skill.version}` })
    if (row.backfilled) badges.push({ tone: 'brown', text: '历史补登记' })
  }
  if (row.kind === 'spec' && row.legacy) badges.push({ tone: 'brown', text: '旧版渲染' })
  else if (row.skill && row.kind !== 'flowchart') badges.push({ tone: 'indigo', text: `${row.skill.slug}@${row.skill.version}` })
  return badges
}

function previewDoc(row: any) {
  if (row.unavailable) return
  const url = row.previewUrl || row.docxUrl
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}

export default function RequirementDetail({ projectId, reqId, projectRole }: any) {
  const toast = useToast()
  const detail = useAsync<any>(() => get(`/api/requirements/${reqId}/detail`), [reqId])
  const [profileOpen, setProfileOpen] = useState(false)
  const [progressOpen, setProgressOpen] = useState(false)
  const [statusTarget, setStatusTarget] = useState('')
  const [regenerating, setRegenerating] = useState('')

  const regenerateFlowchart = async (row: any) => {
    setRegenerating(row.id)
    try {
      const r = await post(`/api/requirements/${reqId}/analysis/${row.analysisVersionRowId}/flowchart/regenerate`, {})
      toast.push(`流程图已重新生成（${r.renderer === 'archify' ? '交互图' : '步骤清单'}）`, 'success')
      detail.reload()
    } catch (e: any) {
      toast.push(e.message || '流程图重新生成失败', 'error')
    } finally {
      setRegenerating('')
    }
  }

  if (detail.loading && !detail.data) return <Loading label="加载需求详情…" />
  if (detail.error) return <ErrorBox message={detail.error} onRetry={detail.reload} />

  const d = detail.data
  const basic = d.basic
  const docs = d.docs
  const progress = d.progress
  const perms = d.permissions
  const milestones = basic.milestones

  const refresh = () => detail.reload()

  return (
    <>
      <PageHeader back={() => navigate(`/p/${projectId}/pool`)}
        title={<span className="row wrap" style={{ gap: 8 }}>
          {basic.code ? <span className="code">{basic.code}</span> : <Tag tone="gray">未编号</Tag>}
          {basic.title}
          <StatusTag status={basic.status} />
          {basic.priority?.grade && <Tag tone={PRIORITY_TONE[basic.priority.grade] || 'gray'}>{basic.priority.gradeLabel || basic.priority.grade}</Tag>}
          {basic.status === '挂起' && progress.suspendedFrom && <Tag tone="brown">原：{statusLabel(progress.suspendedFrom)}</Tag>}
          {perms.guest && <Tag tone="slate">访客只读</Tag>}
        </span>}
        desc={<>
          {basic.submittedBy || '未登记'} {basic.submittedByOrg ? ` · ${basic.submittedByOrg}` : ''} · 提交于 {fmtTime(basic.submittedAt)}
          {basic.iteration ? ` · 迭代「${basic.iteration.name}」` : ' · 未排期'}
        </>}
        actions={<>
          <button className="btn" onClick={refresh}>刷新</button>
          {perms.batch && <button className="btn" onClick={() => navigate(`/p/${projectId}/tracking`)}>批量维护</button>}
          {perms.enterWorkbench && <button className="btn primary" onClick={() => navigate(`/p/${projectId}/req/${reqId}/analysis`)}>进入分析工作台</button>}
        </>} />

      <div className="split-2">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <div><h3>基本信息</h3><p>需求实体档案，所有下游产物共用同一份事实</p></div>
              <div className="row">
                {(perms.editDescription || perms.editApps) && <button className="btn sm" onClick={() => setProfileOpen(true)}>编辑说明与功能</button>}
                {(perms.editLeads || perms.editMilestones) && <button className="btn sm" onClick={() => setProgressOpen(true)}>维护负责人</button>}
              </div>
            </div>
            <div className="card-body stack">
              <div>
                <div className="muted small mb8">需求说明</div>
                <p className="small" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                  {basic.description || <span className="muted">暂无需求说明，可在编辑中补充，或从澄清结论沿用。</span>}
                </p>
                {basic.descriptionSource && basic.descriptionSource !== 'manual' && basic.description && (
                  <div className="tiny muted mt8">来源：{basic.descriptionSource === 'clarification' ? '澄清结论' : basic.descriptionSource === 'source' ? '原始登记材料' : basic.descriptionSource}</div>
                )}
              </div>
              <KvGrid rows={[
                ['提交人', basic.submittedBy || '—'],
                ['提交组织', basic.submittedByOrg || '—'],
                ['提交时间', fmtTime(basic.submittedAt)],
                ['所属迭代', basic.iteration?.name || '未排期'],
                ['产品经理', basic.leads?.productManager || '—'],
                ['当前状态', statusLabel(basic.status)]
              ]} />
              <div>
                <div className="muted small mb8">关联应用与功能点</div>
                {!basic.apps?.length && <p className="muted small">尚未登记关联应用。</p>}
                <div className="stack" style={{ gap: 10 }}>
                  {(basic.apps || []).map((app: any) => (
                    <div key={app.name} className="section-block">
                      <h4>
                        <span className="row" style={{ gap: 6 }}>{app.name}<Tag tone={app.kind === 'external' ? 'amber' : 'blue'}>{app.kind === 'external' ? '外部依赖' : '内部应用'}</Tag></span>
                        <span className="tiny muted">{app.functions?.length || 0} 个功能点</span>
                      </h4>
                      <div className="inner">
                        {!app.functions?.length && <p className="muted small">该应用尚未登记功能点（子需求）。</p>}
                        {app.functions?.map((fn: any, i: number) => (
                          <div key={fn.id || i} className="dep-row">
                            <span className="code">{fn.id || `FN-${i + 1}`}</span>
                            <span style={{ minWidth: 160 }}>{fn.name}</span>
                            <span className="grow muted small truncate">{fn.description || '—'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div><h3>过程文档</h3><p>流程图、原型与说明书均按版本聚合，可直接预览</p></div></div>
            <div className="card-body stack">
              {DOC_GROUPS.map(group => {
                const rows = docs[group.key] || []
                return (
                  <div key={group.key} className="section-block">
                    <h4>{group.label}<span className="tiny muted">{rows.length}</span></h4>
                    <div className="inner">
                      {!rows.length && <p className="muted small">{group.empty}</p>}
                      {rows.map(row => (
                        <div key={row.id} className="dep-row">
                          <Tag tone={row.kind === 'prototype' ? 'violet' : row.kind === 'iteration-spec' ? 'gray' : 'indigo'}>{group.label}</Tag>
                          <span className="grow truncate">{row.title}</span>
                          {docBadges(row).map((b: any) => <Tag key={b.text} tone={b.tone}>{b.text}</Tag>)}
                          <span className="tiny muted nowrap">{docMeta(row)}</span>
                          <span className="tiny muted nowrap">{fmtTime(row.updatedAt || row.createdAt)}</span>
                          {row.kind === 'flowchart' && perms.regenerateFlowchart && row.analysisVersionRowId && (
                            <button className="btn sm ghost" disabled={regenerating === row.id}
                              onClick={() => regenerateFlowchart(row)}>{regenerating === row.id ? '生成中…' : '重新生成'}</button>
                          )}
                          <button className="btn sm" disabled={Boolean(row.unavailable) || (!row.previewUrl && !row.docxUrl)}
                            onClick={() => previewDoc(row)}>预览</button>
                          {row.docxUrl && <button className="btn sm ghost" onClick={() => downloadUrl(row.docxUrl)}>Word</button>}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div><h3>需求进展</h3><p>状态轨迹、里程碑与批次记录</p></div></div>
            <div className="card-body stack">
              <div className="row wrap" style={{ gap: 6 }}>
                {progress.steps.map((s: any) => (
                  <span key={s.index} className="file-pill" style={s.upcoming ? { opacity: .45 } : undefined}>
                    {!s.upcoming && <Tag tone={s.current ? (STATUS_TONE[s.name] || 'gray') : 'green'}>{s.current ? '当前' : '✓'}</Tag>}
                    {s.label}{s.suspended ? '（挂起）' : ''}
                  </span>
                ))}
              </div>

              <div>
                <div className="muted small mb8">六个完成时间</div>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>节点</th><th>计划</th><th>实际</th><th>标记</th></tr></thead>
                    <tbody>
                      {milestones.fields.map((f: any) => (
                        <tr key={f.key}>
                          <td>{f.label}</td>
                          <td className="small muted">{f.plan ? fmtDay(f.plan) : '—'}</td>
                          <td className="small">{f.actual ? fmtDay(f.actual) : <span className="muted">未完成</span>}</td>
                          <td>
                            {f.auto && <Tag tone="blue">自动回填</Tag>}
                            {f.needsReview && <Tag tone="amber">待复核</Tag>}
                            {f.overdue && <Tag tone="red">逾期</Tag>}
                            {!f.auto && !f.needsReview && !f.overdue && <span className="muted">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {progress.batches.length > 0 && (
                <div>
                  <div className="muted small mb8">批次记录</div>
                  {progress.batches.map((b: any) => (
                    <div key={b.batchId} className="dep-row">
                      <Tag tone={b.ok ? 'green' : 'red'}>{b.ok ? '成功' : '失败'}</Tag>
                      <span className="code">{b.batchId}</span>
                      <span className="grow truncate">{b.kind === 'progress' ? '进展维护' : `状态更新 → ${b.target}`}</span>
                      <span className="tiny muted">{fmtTime(b.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div>
                <div className="muted small mb8">事件轨迹</div>
                {!progress.events.length && <Empty title="还没有进展事件" icon="○" />}
                <div className="timeline">
                  {progress.events.map((e: any) => (
                    <div key={e.id} className="timeline-item strong">
                      <div className="t-main">{e.message}</div>
                      <div className="t-meta">{e.actorName || '系统'} · {fmtTime(e.effectiveAt || e.createdAt)}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><div><h3>状态推进</h3><p>服务端逐项校验门禁，失败保留原状态</p></div></div>
            <div className="card-body stack">
              {!progress.transitions.length && <p className="muted small">当前状态没有可用的推进动作。</p>}
              {progress.transitions.map((t: any) => (
                <div key={t.status} className="section-block">
                  <h4><span>{t.label}</span>
                    {t.issues?.length ? <Tag tone="amber">{t.issues.length} 项待补</Tag> : <Tag tone="green">可推进</Tag>}
                  </h4>
                  <div className="inner">
                    {t.issues?.length ? <ul className="list-clean small">{t.issues.map((i: string) => <li key={i} className="danger-text">{i}</li>)}</ul>
                      : <p className="muted small">门禁已满足，可提交推进。</p>}
                    {perms.advanceStatus && (
                      <div className="mt8">
                        <button className="btn sm primary" disabled={t.issues?.length > 0} onClick={() => setStatusTarget(t.status)}>推进到「{t.status}」</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div className="tiny muted">进入开发中需技术负责人，进入待测试验证需测试负责人，进入待试点需实施负责人；里程碑会按阶段自动回填。</div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div><h3>负责人</h3><p>门禁与协作分派依据</p></div></div>
            <div className="card-body">
              <KvGrid rows={LEAD_FIELDS.map(f => [f.label, basic.leads?.[f.key] || '—'])} columns={1} />
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div><h3>下一步</h3><p>按当前阶段推荐动作</p></div></div>
            <div className="card-body stack">
              {milestones.overdue?.length > 0 && (
                <div className="notice warn">有 {milestones.overdue.length} 个里程碑计划已逾期：{milestones.overdue.map((o: any) => o.label).join('、')}。</div>
              )}
              {milestones.orderIssues?.length > 0 && (
                <div className="notice warn">完成时间顺序冲突：{milestones.orderIssues.map((i: any) => i.message).join('；')}。</div>
              )}
              {!milestones.overdue?.length && !milestones.orderIssues?.length && <p className="muted small">暂无时间冲突或逾期提醒。</p>}
              <div className="tiny muted">修改完成时间或负责人会写入审计与事件轨迹；回退状态时自动回填的日期会被清除，手工登记的日期标记待复核。</div>
            </div>
          </div>
        </div>
      </div>

      {profileOpen && (
        <ProfileModal projectId={projectId} reqId={reqId} basic={basic}
          onClose={() => setProfileOpen(false)}
          onSaved={async () => { setProfileOpen(false); await refresh() }} />
      )}

      {progressOpen && (
        <ProgressModal reqId={reqId} progress={progress} leads={basic.leads}
          onClose={() => setProgressOpen(false)}
          onSaved={async () => { setProgressOpen(false); await refresh() }} />
      )}

      {statusTarget && (
        <StatusModal reqId={reqId} current={basic.status} transitions={progress.transitions} initial={statusTarget}
          onClose={() => setStatusTarget('')}
          onSaved={async () => { setStatusTarget(''); await refresh() }} />
      )}
    </>
  )
}

function KvGrid({ rows, columns = 2 }: { rows: [string, React.ReactNode][]; columns?: number }) {
  return (
    <dl className="kv" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v || '—'}</dd></div>)}
    </dl>
  )
}

function ProfileModal({ projectId, reqId, basic, onClose, onSaved }: any) {
  const toast = useToast()
  const scope = useAsync<any>(() => get(`/api/projects/${projectId}/scope-apps`), [projectId])
  const [description, setDescription] = useState(basic.description || '')
  const [apps, setApps] = useState<any[]>(() => (basic.apps || []).map((a: any) => ({ ...a, functions: [...(a.functions || [])] })))
  const [busy, setBusy] = useState(false)

  const names = scope.data?.all || []
  const selected = useMemo(() => new Set(apps.map(a => a.name)), [apps])

  const toggleApp = (name: string) => {
    setApps(list => list.some(a => a.name === name)
      ? list.filter(a => a.name !== name)
      : [...list, { name, kind: 'internal', functions: [] }])
  }

  const patchFn = (appName: string, index: number, key: 'name' | 'description', value: string) => {
    setApps(list => list.map(a => a.name !== appName ? a : {
      ...a, functions: a.functions.map((f: any, i: number) => i === index ? { ...f, [key]: value } : f)
    }))
  }

  const addFn = (appName: string) => {
    setApps(list => list.map(a => a.name !== appName ? a : { ...a, functions: [...a.functions, { name: '', description: '' }] }))
  }

  const removeFn = (appName: string, index: number) => {
    setApps(list => list.map(a => a.name !== appName ? a : { ...a, functions: a.functions.filter((_: any, i: number) => i !== index) }))
  }

  const save = async () => {
    const clean = apps.map(a => ({ ...a, functions: a.functions.filter((f: any) => String(f.name || '').trim()) }))
    setBusy(true)
    try {
      await patch(`/api/requirements/${reqId}/profile`, { description, apps: clean })
      toast.push('需求说明与功能点已更新', 'success')
      await onSaved()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <Modal title="编辑需求说明与功能点" subtitle={`${basic.code || '未编号'} · ${basic.title}`} onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button></>}>
      <div className="stack">
        <Field label="需求说明" hint="下游分析、原型与说明书都会引用这段说明">
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="说明业务背景、目标与范围" />
        </Field>
        <div>
          <div className="field-label mb8">关联应用</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {!names.length && <span className="muted small">项目未配置系统范围，可直接在下方维护。</span>}
            {names.map((n: string) => (
              <button key={n} className={`btn sm ${selected.has(n) ? 'primary' : ''}`} onClick={() => toggleApp(n)}>{selected.has(n) ? '✓ ' : '+ '}{n}</button>
            ))}
          </div>
        </div>
        {!apps.length && <p className="muted small">尚未选择关联应用。</p>}
        {apps.map((app: any) => (
          <div key={app.name} className="section-block">
            <h4>
              <span className="row" style={{ gap: 6 }}>{app.name}<Tag tone={app.kind === 'external' ? 'amber' : 'blue'}>{app.kind === 'external' ? '外部依赖' : '内部应用'}</Tag></span>
              <button className="btn sm" onClick={() => addFn(app.name)}>＋ 功能点</button>
            </h4>
            <div className="inner stack" style={{ gap: 8 }}>
              {!app.functions.length && <p className="muted small">还没有功能点（子需求）。</p>}
              {app.functions.map((fn: any, i: number) => (
                <div key={i} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                  <input type="text" style={{ maxWidth: 200 }} value={fn.name} placeholder="功能名称"
                    onChange={e => patchFn(app.name, i, 'name', e.target.value)} />
                  <input type="text" value={fn.description} placeholder="功能说明（可选）"
                    onChange={e => patchFn(app.name, i, 'description', e.target.value)} />
                  <button className="btn sm ghost" onClick={() => removeFn(app.name, i)} aria-label="删除功能点">×</button>
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="notice info">应用必须落在项目系统范围内；同一应用下的功能点名称不能重复，保存时会返回具体冲突项。</div>
        {scope.error && <ErrorBox message={scope.error} />}
      </div>
    </Modal>
  )
}

function ProgressModal({ reqId, progress, leads: initialLeads, onClose, onSaved }: any) {
  const toast = useToast()
  const fields = progress.milestones.fields || []
  const [actual, setActual] = useState<any>(Object.fromEntries(fields.map((f: any) => [f.key, (f.actual || '').slice(0, 16)])))
  const [plan, setPlan] = useState<any>(Object.fromEntries(fields.map((f: any) => [f.key, (f.plan || '').slice(0, 16)])))
  const [leads, setLeads] = useState<any>({ ...(initialLeads || {}) })
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await post(`/api/requirements/${reqId}/progress`, {
        milestones: { ...actual, plan },
        leads
      })
      toast.push('负责人与完成时间已更新', 'success')
      await onSaved()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <Modal title="维护负责人与完成时间" subtitle="实际时间按顺序校验；进入对应阶段后自动回填" onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button></>}>
      <div className="stack">
        <div className="form-grid">
          {LEAD_FIELDS.map(f => (
            <Field key={f.key} label={f.label} hint="最多 20 个字符">
              <input type="text" value={leads[f.key] || ''} onChange={e => setLeads({ ...leads, [f.key]: e.target.value })} />
            </Field>
          ))}
        </div>
        <div className="form-grid">
          {fields.map((f: any) => (
            <React.Fragment key={f.key}>
              <Field label={f.label} hint={f.auto ? '自动回填，手工修改后转为人工登记' : undefined}>
                <input type="datetime-local" value={actual[f.key] || ''} onChange={e => setActual({ ...actual, [f.key]: e.target.value })} />
              </Field>
              <Field label={`计划${f.label}`}>
                <input type="datetime-local" value={plan[f.key] || ''} onChange={e => setPlan({ ...plan, [f.key]: e.target.value })} />
              </Field>
            </React.Fragment>
          ))}
        </div>
        <div className="notice info">清空某个时间会同时移除自动回填标记；时间顺序冲突会被拒绝并提示具体节点。</div>
      </div>
    </Modal>
  )
}

function StatusModal({ reqId, current, transitions, initial, onClose, onSaved }: any) {
  const toast = useToast()
  const [to, setTo] = useState(initial || transitions[0]?.status || '')
  const [note, setNote] = useState('')
  const [effectiveAt, setEffectiveAt] = useState('')
  const [busy, setBusy] = useState(false)
  const chosen = transitions.find((t: any) => t.status === to)

  const save = async () => {
    if (!to) return
    setBusy(true)
    try {
      const r = await post<any>(`/api/requirements/${reqId}/progress`, {
        to, note: note.trim(),
        effectiveAt: effectiveAt ? new Date(effectiveAt).toISOString() : null
      })
      toast.push(`已推进到「${r.statusLabel || r.status}」${r.backfilled ? '（按生效时间回填）' : ''}`, 'success')
      await onSaved()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <Modal title="推进需求状态" subtitle={`当前：${statusLabel(current)}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy || !to} onClick={save}>{busy ? '推进中…' : '确认推进'}</button></>}>
      <div className="stack">
        <Field label="目标状态" required>
          <select value={to} onChange={e => setTo(e.target.value)}>
            {transitions.map((t: any) => <option key={t.status} value={t.status}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="生效时间" hint="留空为当前时间；不得晚于当前时间">
          <input type="datetime-local" value={effectiveAt} onChange={e => setEffectiveAt(e.target.value)} />
        </Field>
        <Field label={to === '挂起' ? '挂起原因（必填）' : '说明'}>
          <textarea value={note} onChange={e => setNote(e.target.value)} placeholder={to === '挂起' ? '说明挂起原因' : '可选，写入事件轨迹'} />
        </Field>
        {chosen?.issues?.length > 0 && (
          <div className="notice warn">
            <div className="small">该目标仍有门禁未满足：</div>
            <ul className="list-clean small">{chosen.issues.map((i: string) => <li key={i}>{i}</li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
