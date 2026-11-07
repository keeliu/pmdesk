import React, { useEffect, useState } from 'react'
import { fmtDay, get, post } from '../api'
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader, Tag, useToast } from '../ui'
import ChipInput from '../components/ChipInput'
import type { Session } from '../App'

type Props = {
  projects: any[]
  session: Session
  onOpen: (id: string) => void
  onRefresh: () => Promise<void>
  onCreated: (id: string) => Promise<void>
}

const ROLE_LABEL: Record<string, string> = { pm: '产品经理', reviewer: '评审人', developer: '开发', admin: '管理员' }

const emptyForm = (userId: string) => ({
  name: '', code: '', description: '', background: '', ownerOrg: '',
  goals: [] as string[],
  systemScope: { platforms: [] as string[], applications: [] as string[], modules: [] as string[], excluded: [] as string[], notes: '' },
  enterpriseScope: { mode: 'unified', specialCompanies: [] as string[], provinceCompanies: [] as string[], personalized: [] as { company: string; difference: string }[], total: 1, notes: '' },
  members: [{ userId, role: 'pm' }] as { userId: string; role: string }[],
  conventions: { docTemplate: '标准需求分析说明书', style: '中性设计基线', note: '' }
})

export default function Projects({ projects, session, onOpen, onRefresh, onCreated }: Props) {
  const toast = useToast()
  const [wizard, setWizard] = useState(false)
  const [stats, setStats] = useState<Record<string, any>>({})
  const [users, setUsers] = useState<any[]>([])

  useEffect(() => {
    let alive = true
    Promise.all(projects.map(async p => {
      try { return [p.id, await get<any>(`/api/projects/${p.id}/overview`)] as const } catch { return [p.id, null] as const }
    })).then(rows => { if (alive) setStats(Object.fromEntries(rows)) })
    return () => { alive = false }
  }, [projects.map(p => p.id).join(',')])

  useEffect(() => {
    if (!wizard) return
    get<any[]>('/api/users').then(setUsers).catch(() => setUsers([]))
  }, [wizard])

  return (
    <>
      <PageHeader title="我的项目" desc="每个项目共享一套项目画像、系统范围与设计基线；需求在项目内经历澄清、分析、原型、评审与开发。"
        actions={<button className="btn primary" onClick={() => setWizard(true)}>＋ 新建项目</button>} />

      {!projects.length && (
        <div className="card"><Empty title="还没有项目" desc="先建立项目画像：基本信息、系统范围、企业范围与成员分工，然后再登记需求。"
          action={<button className="btn primary mt8" onClick={() => setWizard(true)}>创建第一个项目</button>} /></div>
      )}

      <div className="project-grid">
        {projects.map(p => {
          const s = stats[p.id]
          const scope = p.systemScope || {}
          const apps = [...(scope.platforms || []), ...(scope.applications || []), ...(scope.modules || [])]
          return (
            <article key={p.id} className="project-card" onClick={() => onOpen(p.id)}>
              <div className="row between">
                <h3>{p.name}</h3>
                <span className="code">{p.code}</span>
              </div>
              <p className="muted small" style={{ minHeight: 38 }}>{p.description || '未填写项目描述'}</p>
              <div className="row wrap">
                {apps.slice(0, 4).map(a => <Tag key={a} tone="blue">{a}</Tag>)}
                {apps.length > 4 && <Tag tone="gray">+{apps.length - 4}</Tag>}
                {!apps.length && <span className="muted tiny">未配置系统范围</span>}
              </div>
              <div className="stats">
                <div><strong>{s?.totals?.pool ?? '—'}</strong>需求池</div>
                <div><strong>{s?.totals?.inbox ?? '—'}</strong>待澄清</div>
                <div><strong>{s?.iterations?.length ?? '—'}</strong>迭代</div>
                <div><strong>{s?.openSuggestions ?? '—'}</strong>未闭环建议</div>
              </div>
              <div className="row between">
                <span className="tiny muted">更新于 {fmtDay(p.updated_at)}</span>
                <span className="link-btn">进入项目 →</span>
              </div>
            </article>
          )
        })}
      </div>

      {wizard && <ProjectWizard session={session} users={users} onClose={() => setWizard(false)}
        onCreated={async id => { setWizard(false); toast.push('项目已创建', 'success'); await onCreated(id) }} />}
    </>
  )
}

function ProjectWizard({ session, users, onClose, onCreated }: { session: Session; users: any[]; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const toast = useToast()
  const [step, setStep] = useState(0)
  const [form, setForm] = useState(emptyForm(session.user!.id))
  const [busy, setBusy] = useState(false)
  const set = (patch: any) => setForm(f => ({ ...f, ...patch }))
  const setScope = (patch: any) => setForm(f => ({ ...f, systemScope: { ...f.systemScope, ...patch } }))
  const setEnterprise = (patch: any) => setForm(f => ({ ...f, enterpriseScope: { ...f.enterpriseScope, ...patch } }))
  const steps = ['基本信息', '系统范围', '企业范围', '成员与约定']

  const canNext = step === 0 ? Boolean(form.name.trim() && form.code.trim()) : true

  const create = async () => {
    if (!form.name.trim()) { toast.push('请填写项目名称', 'warn'); setStep(0); return }
    setBusy(true)
    try {
      const p = await post<any>('/api/projects', form)
      await onCreated(p.id)
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy(false) }
  }

  return (
    <Modal wide title="新建项目" subtitle="项目画像是一次性的基础约定，后续需求共享同一套系统范围与设计基线。"
      onClose={onClose}
      footer={<>
        {step > 0 && <button className="btn" onClick={() => setStep(s => s - 1)}>上一步</button>}
        {step < steps.length - 1 && <button className="btn primary" disabled={!canNext} onClick={() => setStep(s => s + 1)}>下一步</button>}
        {step === steps.length - 1 && <button className="btn primary" disabled={busy} onClick={create}>{busy ? '创建中…' : '创建项目'}</button>}
      </>}>
      <div className="steps">
        {steps.map((s, i) => <div key={s} className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`}>{i + 1}. {s}</div>)}
      </div>

      {step === 0 && (
        <div className="form-grid">
          <Field label="项目名称" required><input type="text" value={form.name} onChange={e => set({ name: e.target.value })} placeholder="例如：客户关系管理平台" /></Field>
          <Field label="项目代号" required hint="2–10 位大写字母或数字"><input type="text" value={form.code} onChange={e => set({ code: e.target.value.toUpperCase() })} placeholder="例如：CRM" /></Field>
          <Field label="归属组织"><input type="text" value={form.ownerOrg} onChange={e => set({ ownerOrg: e.target.value })} placeholder="例如：数字化中心" /></Field>
          <Field label="项目描述"><input type="text" value={form.description} onChange={e => set({ description: e.target.value })} placeholder="一句话说明项目目标" /></Field>
          <div className="wide"><Field label="背景说明"><textarea value={form.background} onChange={e => set({ background: e.target.value })} placeholder="现状、问题与建设背景" /></Field></div>
          <div className="wide"><ChipInput label="项目目标" hint="回车添加" value={form.goals} onChange={goals => set({ goals })} placeholder="例如：统一客户视图" /></div>
        </div>
      )}

      {step === 1 && (
        <div className="stack">
          <div className="notice info">系统范围是后续分析中「涉及应用」的上位约束，超出范围的应用必须在分析中标记为外部依赖。</div>
          <ChipInput label="平台" value={form.systemScope.platforms} onChange={platforms => setScope({ platforms })} placeholder="例如：Web 管理端、移动端" />
          <ChipInput label="应用系统" value={form.systemScope.applications} onChange={applications => setScope({ applications })} placeholder="例如：客户中心、订单中心" />
          <ChipInput label="功能模块" value={form.systemScope.modules} onChange={modules => setScope({ modules })} placeholder="例如：客户档案、合同管理" />
          <ChipInput label="明确排除" value={form.systemScope.excluded} onChange={excluded => setScope({ excluded })} placeholder="本期不纳入的系统或模块" />
          <Field label="范围备注"><textarea value={form.systemScope.notes} onChange={e => setScope({ notes: e.target.value })} placeholder="范围划分口径、边界说明" /></Field>
        </div>
      )}

      {step === 2 && (
        <div className="stack">
          <div className="grid c2">
            <Field label="企业范围模式">
              <select value={form.enterpriseScope.mode} onChange={e => setEnterprise({ mode: e.target.value })}>
                <option value="unified">统一建设</option>
                <option value="personalized">统建 + 个性化</option>
              </select>
            </Field>
            <Field label="涉及单位总数"><input type="number" min={1} value={form.enterpriseScope.total} onChange={e => setEnterprise({ total: Number(e.target.value) })} /></Field>
          </div>
          <ChipInput label="统建单位清单" value={form.enterpriseScope.specialCompanies} onChange={specialCompanies => setEnterprise({ specialCompanies })} placeholder="参与统一建设的单位名称" />
          <ChipInput label="个性化单位" value={form.enterpriseScope.provinceCompanies} onChange={provinceCompanies => setEnterprise({ provinceCompanies })} placeholder="存在个性化差异的单位" />
          <div>
            <div className="row between mb8"><span className="section-title" style={{ margin: 0 }}>个性化差异明细</span>
              <button className="btn sm" onClick={() => setEnterprise({ personalized: [...form.enterpriseScope.personalized, { company: '', difference: '' }] })}>＋ 添加</button>
            </div>
            {!form.enterpriseScope.personalized.length && <p className="muted small">未登记差异时，按统建口径处理。</p>}
            {form.enterpriseScope.personalized.map((row, i) => (
              <div key={i} className="row mb8">
                <input type="text" value={row.company} placeholder="单位名称" onChange={e => {
                  const next = [...form.enterpriseScope.personalized]; next[i] = { ...row, company: e.target.value }; setEnterprise({ personalized: next })
                }} />
                <input type="text" value={row.difference} placeholder="差异点" onChange={e => {
                  const next = [...form.enterpriseScope.personalized]; next[i] = { ...row, difference: e.target.value }; setEnterprise({ personalized: next })
                }} />
                <button className="btn sm danger" onClick={() => setEnterprise({ personalized: form.enterpriseScope.personalized.filter((_, j) => j !== i) })}>删除</button>
              </div>
            ))}
          </div>
          <Field label="企业范围备注"><textarea value={form.enterpriseScope.notes} onChange={e => setEnterprise({ notes: e.target.value })} /></Field>
        </div>
      )}

      {step === 3 && (
        <div className="stack">
          <div>
            <div className="section-title">项目成员</div>
            {users.map(u => {
              const member = form.members.find(m => m.userId === u.id)
              return (
                <div key={u.id} className="member-row mb8">
                  <span className="avatar sm">{u.name.slice(0, 1)}</span>
                  <span className="grow">{u.name}<span className="muted small"> · {ROLE_LABEL[u.role] || u.role}</span></span>
                  {member ? (
                    <>
                      <select value={member.role} onChange={e => set({ members: form.members.map(m => m.userId === u.id ? { ...m, role: e.target.value } : m) })}>
                        <option value="pm">产品经理</option>
                        <option value="reviewer">评审人</option>
                        <option value="developer">开发</option>
                      </select>
                      <button className="btn sm" disabled={u.id === session.user!.id} onClick={() => set({ members: form.members.filter(m => m.userId !== u.id) })}>移除</button>
                    </>
                  ) : <button className="btn sm" onClick={() => set({ members: [...form.members, { userId: u.id, role: u.role === 'pm' ? 'pm' : u.role === 'developer' ? 'developer' : 'reviewer' }] })}>加入项目</button>}
                </div>
              )
            })}
          </div>
          <div className="grid c2">
            <Field label="说明书模板"><input type="text" value={form.conventions.docTemplate} onChange={e => set({ conventions: { ...form.conventions, docTemplate: e.target.value } })} /></Field>
            <Field label="设计基线"><input type="text" value={form.conventions.style} onChange={e => set({ conventions: { ...form.conventions, style: e.target.value } })} /></Field>
          </div>
          <Field label="协作约定"><textarea value={form.conventions.note} onChange={e => set({ conventions: { ...form.conventions, note: e.target.value } })} placeholder="评审节奏、完成定义、通知口径等" /></Field>
        </div>
      )}
    </Modal>
  )
}
