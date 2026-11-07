import React, { useEffect, useState } from 'react'
import { fmtTime, get, post } from '../../api'
import { ErrorBox, Field, Kv, Loading, Modal, Tag, useAsync, useToast } from '../../ui'

const LABELS: Record<string, string> = {
  requester: '提出方信息', roles: '角色与岗位', goal: '目标与价值', scope: '范围', boundary: '边界', acceptance: '验收口径', involvedApps: '涉及应用'
}

const LEVEL_OPTIONS = [
  { value: 'high', label: '高层' }, { value: 'middle', label: '中层' },
  { value: 'basic', label: '基层' }, { value: 'external', label: '外部' }
]

const REQUESTER_KEYS = ['enterprise', 'department', 'name', 'level', 'position', 'contact', 'external']

function requesterEqual(a: any = {}, b: any = {}) {
  return REQUESTER_KEYS.every(k => String(a[k] ?? '') === String(b[k] ?? ''))
}

type Props = { reqId: string; detail: any; onRefresh: () => Promise<void> }

export default function ClarifyView({ reqId, detail, onRefresh }: Props) {
  const toast = useToast()
  const questions = useAsync<any>(() => get(`/api/requirements/${reqId}/clarification/questions`), [reqId, detail.updated_at])
  const infer = useAsync<any>(() => get(`/api/requirements/${reqId}/clarification/infer-apps`), [reqId])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [requester, setRequester] = useState<any>({})
  const [apps, setApps] = useState<any[]>([])
  const [appInput, setAppInput] = useState('')
  const [busy, setBusy] = useState('')
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const editable = detail.status === '需求调研中'

  useEffect(() => {
    const answers = detail.clarification?.answers || {}
    setDraft(Object.fromEntries(Object.entries(answers).map(([k, v]: [string, any]) => [k, v?.value || ''])))
    setRequester({ ...(detail.requester || {}) })
    setApps(detail.involvedApps || [])
  }, [detail.updated_at])

  const saveAnswers = async (silent = false) => {
    const existing = detail.clarification?.answers || {}
    const payload: any[] = []
    for (const [field, value] of Object.entries(draft)) {
      if (!value || value === existing[field]?.value) continue
      payload.push({ field, value })
    }
    if (!requesterEqual(requester, detail.requester || {})) {
      payload.push({ field: 'requester', value: requester })
    }
    const existingApps = (detail.involvedApps || []).map((a: any) => a.name).join('|')
    if (apps.map(a => a.name).join('|') !== existingApps) {
      payload.push({ field: 'involvedApps', value: apps })
    }
    if (!payload.length) {
      if (!silent) toast.push('没有新的澄清内容需要保存', 'warn')
      return false
    }
    await post(`/api/requirements/${reqId}/clarification/answers`, { answers: payload })
    await onRefresh()
    if (!silent) toast.push('澄清内容已保存', 'success')
    return true
  }

  const confirmRequirement = async () => {
    setBusy('confirm')
    try {
      await saveAnswers(true)
      const res = await post<any>(`/api/requirements/${reqId}/confirm`, {})
      toast.push(`需求已确认，编号 ${res.code}`, 'success')
      await onRefresh()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const reject = async () => {
    if (!rejectReason.trim()) { toast.push('请填写退回原因', 'warn'); return }
    setBusy('reject')
    try {
      await post(`/api/requirements/${reqId}/reject`, { reason: rejectReason })
      toast.push('已退回澄清', 'success')
      setRejectOpen(false); setRejectReason('')
      await onRefresh()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const discard = async () => {
    if (!window.confirm('确认丢弃这条需求？丢弃后不再进入需求池。')) return
    setBusy('discard')
    try {
      await post(`/api/requirements/${reqId}/discard`, {})
      toast.push('需求已丢弃', 'info')
      await onRefresh()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
  }

  const toggleApp = (name: string) => {
    setApps(list => list.some(a => a.name === name)
      ? list.filter(a => a.name !== name)
      : [...list, { name, kind: 'internal', source: 'manual' }])
  }

  const addApp = () => {
    const name = appInput.trim()
    if (!name) return
    if (!apps.some(a => a.name === name)) setApps(list => [...list, { name, kind: 'internal', source: 'manual' }])
    setAppInput('')
  }

  if (questions.loading && !questions.data) return <Loading label="加载澄清清单…" />
  if (questions.error) return <ErrorBox message={questions.error} onRetry={questions.reload} />

  if (!editable) {
    const answers = detail.clarification?.answers || {}
    return (
      <div className="stack">
        <div className="notice info">已确认需求为只读快照，确认后的信息会向下游分析、原型与说明书持续传递。</div>
        <div className="analysis-section">
          <header><h4>提出方信息</h4><span>{detail.requester?.levelText || '—'}</span></header>
          <div className="body">
            <Kv columns={2} items={[
              ['企业', detail.requester?.enterprise],
              ['部门', detail.requester?.department],
              ['提出人', detail.requester?.name],
              ['级别/岗位', [detail.requester?.levelText, detail.requester?.position].filter(Boolean).join(' · ')],
              ['联系方式', detail.requester?.contact],
              ['范围标记', detail.requester?.external ? '画像范围外 · 外部提出方' : '画像范围内']
            ]} />
          </div>
        </div>
        <div className="analysis-section">
          <header><h4>澄清结论</h4><span>确认于 {fmtTime(detail.confirmed_at)}</span></header>
          <div className="body">
            <Kv columns={1} items={[
              ['角色与岗位', answers.roles?.value],
              ['目标与价值', answers.goal?.value],
              ['范围', answers.scope?.value],
              ['边界', answers.boundary?.value],
              ['验收口径', answers.acceptance?.value]
            ]} />
          </div>
        </div>
        <div className="analysis-section">
          <header><h4>涉及应用</h4><span>{detail.involvedApps?.length || 0} 个</span></header>
          <div className="body">
            {detail.involvedApps?.length
              ? <div className="row wrap">{(detail.involvedApps || []).map((a: any) => (
                  <Tag key={a.name} tone={a.kind === 'external' ? 'amber' : 'indigo'}>{a.name}{a.kind === 'external' ? ' · 外部' : ''}</Tag>
                ))}</div>
              : <p className="muted small">未登记涉及应用</p>}
          </div>
        </div>
        <div className="analysis-section">
          <header><h4>需求原文摘要</h4><span>{detail.source?.fileName || '文本录入'}</span></header>
          <div className="body">
            <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{detail.source?.excerpt || '—'}</p>
          </div>
        </div>
        {detail.reject_count > 0 && <div className="notice">该需求曾被退回 {detail.reject_count} 次，最近原因：{detail.reject_reason || '—'}</div>}
      </div>
    )
  }

  const gaps: string[] = detail.gaps || []
  const list = (questions.data?.questions || []).filter((q: any) => q.field !== 'requester')
  const requesterQ = (questions.data?.questions || []).find((q: any) => q.field === 'requester')
  const enterpriseOptions: string[] = requesterQ?.fields?.find((f: any) => f.key === 'enterprise')?.options || []
  const requesterIssues = (detail.gapDetails || []).find((g: any) => g.field === 'requester')?.issues || []

  return (
    <div className="stack">
      {gaps.length > 0
        ? <div className="notice">待补齐：{gaps.map(g => LABELS[g] || g).join('、')}。六项齐备后才能确认入池并生成编号。</div>
        : <div className="notice info">澄清清单已齐备，可以确认入池。确认后将生成唯一编号并固化快照。</div>}

      <div className="analysis-section">
        <header><h4>提出方信息</h4>{requesterIssues.length > 0 ? <span className="danger-text">{requesterIssues.map((i: any) => i.message).join('；')}</span> : <span>已填</span>}</header>
        <div className="body">
          <p className="small muted">{requesterQ?.question || '该需求由哪个企业、哪个部门的谁提出？级别或岗位是什么？'}</p>
          <div className="form-grid">
            <Field label="企业" required hint="来自项目画像企业范围">
              <select value={requester.external ? '__external__' : (requester.enterprise || '')}
                onChange={e => {
                  const v = e.target.value
                  if (v === '__external__') setRequester({ ...requester, external: true, enterprise: requester.external ? requester.enterprise : '' })
                  else setRequester({ ...requester, external: false, enterprise: v })
                }}>
                <option value="">请选择企业</option>
                {enterpriseOptions.map(name => <option key={name} value={name}>{name}</option>)}
                <option value="__external__">其他企业（标记为外部提出方）</option>
              </select>
            </Field>
            {requester.external && (
              <Field label="外部企业名称" required>
                <input type="text" value={requester.enterprise || ''} onChange={e => setRequester({ ...requester, enterprise: e.target.value })} />
              </Field>
            )}
            <Field label="部门" required><input type="text" value={requester.department || ''} onChange={e => setRequester({ ...requester, department: e.target.value })} /></Field>
            <Field label="提出人姓名" required><input type="text" value={requester.name || ''} onChange={e => setRequester({ ...requester, name: e.target.value })} /></Field>
            <Field label="级别" required>
              <select value={requester.level || ''} onChange={e => setRequester({ ...requester, level: e.target.value })}>
                <option value="">请选择级别</option>
                {LEVEL_OPTIONS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </Field>
            <Field label="岗位"><input type="text" value={requester.position || ''} onChange={e => setRequester({ ...requester, position: e.target.value })} /></Field>
            <Field label="联系方式"><input type="text" value={requester.contact || ''} onChange={e => setRequester({ ...requester, contact: e.target.value })} /></Field>
          </div>
          {requester.external && <p className="tiny muted mt8">外部提出方会参与优先级中的「提出人级别/岗位」评分，并在确认快照中保留。</p>}
        </div>
      </div>

      {list.map((q: any) => (
        <div key={q.field} className="analysis-section">
          <header>
            <h4>{q.label}</h4>
            {q.existing && <span>已填</span>}
          </header>
          <div className="body">
            <p className="small muted">{q.question}</p>
            {q.field === 'involvedApps' ? (
              <>
                <div className="chips">
                  {(detail.scope?.all || []).map((name: string) => (
                    <button key={name} className={`chip ${apps.some(a => a.name === name) ? '' : 'ghost'}`}
                      style={{ border: '1px solid var(--line)', background: apps.some(a => a.name === name) ? undefined : 'var(--surface)' }}
                      onClick={() => toggleApp(name)}>{name}</button>
                  ))}
                </div>
                {infer.data?.apps?.length > 0 && (
                  <div className="row wrap small">
                    <span className="muted">系统推断：</span>
                    {infer.data.apps.map((a: any) => (
                      <button key={a.name} className="link-btn" onClick={() => toggleApp(a.name)}>
                        {a.name}（{Math.round(a.confidence * 100)}%）
                      </button>
                    ))}
                  </div>
                )}
                <div className="row">
                  <input type="text" value={appInput} placeholder="补充范围外的应用（将作为外部依赖）"
                    onChange={e => setAppInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addApp() }} />
                  <button className="btn sm" onClick={addApp}>添加</button>
                </div>
                <div className="row wrap">
                  {apps.map(a => (
                    <span key={a.name} className="file-pill">
                      {a.name}{detail.scope?.all?.includes(a.name) ? '' : ' · 外部'}
                      <button className="link-btn" style={{ color: 'inherit' }} onClick={() => setApps(list => list.filter(x => x.name !== a.name))}>×</button>
                    </span>
                  ))}
                  {!apps.length && <span className="muted small">尚未选择涉及应用</span>}
                </div>
              </>
            ) : (
              <>
                <div className="chips">
                  {(q.options || []).map((opt: string) => (
                    <button key={opt} className="chip" style={{ border: '1px solid var(--line)', background: draft[q.field] === opt ? undefined : 'var(--surface)' }}
                      onClick={() => setDraft(d => ({ ...d, [q.field]: opt }))}>{opt}</button>
                  ))}
                </div>
                <Field label="或直接填写">
                  <textarea value={draft[q.field] || ''} onChange={e => setDraft(d => ({ ...d, [q.field]: e.target.value }))}
                    placeholder="补充更准确的结论" style={{ minHeight: 62 }} />
                </Field>
              </>
            )}
          </div>
        </div>
      ))}

      <div className="card">
        <div className="card-body row wrap">
          <button className="btn primary" disabled={busy === 'confirm'} onClick={confirmRequirement}>
            {busy === 'confirm' ? '确认中…' : '确认入池并生成编号'}
          </button>
          <button className="btn" disabled={busy !== ''} onClick={() => saveAnswers()}>保存澄清</button>
          <button className="btn ghost" disabled={busy !== ''} onClick={() => setRejectOpen(true)}>退回澄清</button>
          <button className="btn danger" disabled={busy !== ''} onClick={discard}>丢弃</button>
        </div>
      </div>

      {rejectOpen && (
        <Modal title="退回澄清" subtitle="退回不改变需求状态，只记录原因并累加退回次数" onClose={() => setRejectOpen(false)}
          footer={<>
            <button className="btn" onClick={() => setRejectOpen(false)}>取消</button>
            <button className="btn danger" disabled={busy === 'reject'} onClick={reject}>确认退回</button>
          </>}>
          <Field label="退回原因" required>
            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="例如：涉及应用与系统范围不一致，需重新确认" />
          </Field>
        </Modal>
      )}
    </div>
  )
}
