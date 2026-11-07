import React, { useEffect, useState } from 'react'
import { downloadUrl, fmtTime, get, patch, post, put, del, readFile } from '../api'
import { Empty, ErrorBox, Field, Loading, Modal, PageHeader, Tabs, Tag, useAsync, useToast, CopyButton } from '../ui'
import ChipInput from '../components/ChipInput'

const TABS = [
  { key: 'profile', label: '项目画像' }, { key: 'members', label: '成员与角色' },
  { key: 'model', label: '模型网关' }, { key: 'skills', label: '技能管理' },
  { key: 'audits', label: '审计日志' }, { key: 'exports', label: '导出记录' }, { key: 'shares', label: '分享链接' }
]
const ROLE_LABEL: Record<string, string> = { pm: '产品经理', reviewer: '评审人', developer: '开发', admin: '管理员' }
const STAGE_LABEL: Record<string, string> = { clarify: '澄清', analysis: '分析', prototype: '原型', review: '评审', change: '变更', spec: '说明书' }

export default function Settings({ projectId, project, projectRole, session, onProjectsChange }: any) {
  const [tab, setTab] = useState('profile')
  const canManage = ['pm', 'admin'].includes(projectRole)
  return (
    <>
      <PageHeader title="项目设置" desc={`${project?.name || ''} · ${project?.code || ''}。画像与范围的变化会影响后续分析与一致性校验。`}
        actions={<Tag tone={canManage ? 'blue' : 'gray'}>{ROLE_LABEL[projectRole] || '只读'}</Tag>} />
      <Tabs value={tab} onChange={setTab} tabs={TABS} />
      {tab === 'profile' && <ProfileTab projectId={projectId} project={project} canManage={canManage} onProjectsChange={onProjectsChange} />}
      {tab === 'members' && <MembersTab projectId={projectId} canManage={canManage} session={session} />}
      {tab === 'model' && <ModelTab projectId={projectId} canManage={canManage} />}
      {tab === 'skills' && <SkillsTab projectId={projectId} canManage={canManage} />}
      {tab === 'audits' && <AuditsTab projectId={projectId} />}
      {tab === 'exports' && <ExportsTab projectId={projectId} />}
      {tab === 'shares' && <SharesTab projectId={projectId} canManage={canManage} />}
    </>
  )
}

function ProfileTab({ projectId, project, canManage, onProjectsChange }: any) {
  const toast = useToast()
  const [form, setForm] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (project) setForm({
      name: project.name, description: project.description || '', background: project.background || '', ownerOrg: project.owner_org || '',
      goals: project.goals || [],
      systemScope: { platforms: [], applications: [], modules: [], excluded: [], notes: '', ...(project.systemScope || {}) },
      enterpriseScope: { mode: 'unified', specialCompanies: [], provinceCompanies: [], personalized: [], total: 1, notes: '', ...(project.enterpriseScope || {}) },
      conventions: project.conventions || {}
    })
  }, [project?.id, project?.updated_at])
  if (!form) return <Loading />
  const setScope = (p: any) => setForm({ ...form, systemScope: { ...form.systemScope, ...p } })
  const setEnt = (p: any) => setForm({ ...form, enterpriseScope: { ...form.enterpriseScope, ...p } })
  const save = async () => {
    setBusy(true)
    try {
      await patch(`/api/projects/${projectId}`, form)
      toast.push('项目画像已保存', 'success')
      await onProjectsChange()
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy(false) }
  }
  return (
    <div className="grid c2">
      <div className="card">
        <div className="card-head"><div><h3>基本信息</h3><p>只有产品经理或管理员可修改</p></div></div>
        <div className="card-body stack">
          <Field label="项目名称"><input type="text" disabled={!canManage} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="归属组织"><input type="text" disabled={!canManage} value={form.ownerOrg} onChange={e => setForm({ ...form, ownerOrg: e.target.value })} /></Field>
          <Field label="项目描述"><input type="text" disabled={!canManage} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></Field>
          <Field label="背景说明"><textarea disabled={!canManage} value={form.background} onChange={e => setForm({ ...form, background: e.target.value })} /></Field>
          <ChipInput label="项目目标" value={form.goals} onChange={goals => setForm({ ...form, goals })} />
          <div className="grid c2">
            <Field label="说明书模板"><input type="text" disabled={!canManage} value={form.conventions.docTemplate || ''} onChange={e => setForm({ ...form, conventions: { ...form.conventions, docTemplate: e.target.value } })} /></Field>
            <Field label="设计基线"><input type="text" disabled={!canManage} value={form.conventions.style || ''} onChange={e => setForm({ ...form, conventions: { ...form.conventions, style: e.target.value } })} /></Field>
          </div>
          <Field label="协作约定"><textarea disabled={!canManage} value={form.conventions.note || ''} onChange={e => setForm({ ...form, conventions: { ...form.conventions, note: e.target.value } })} /></Field>
          {canManage && <div className="row end"><button className="btn primary" disabled={busy} onClick={save}>保存画像</button></div>}
        </div>
      </div>
      <div className="stack">
        <div className="card">
          <div className="card-head"><div><h3>系统范围</h3><p>分析中涉及应用的上位约束</p></div></div>
          <div className="card-body stack">
            <ChipInput label="平台" value={form.systemScope.platforms} onChange={v => setScope({ platforms: v })} />
            <ChipInput label="应用系统" value={form.systemScope.applications} onChange={v => setScope({ applications: v })} />
            <ChipInput label="功能模块" value={form.systemScope.modules} onChange={v => setScope({ modules: v })} />
            <ChipInput label="明确排除" value={form.systemScope.excluded} onChange={v => setScope({ excluded: v })} />
            <Field label="范围备注"><textarea disabled={!canManage} value={form.systemScope.notes || ''} onChange={e => setScope({ notes: e.target.value })} /></Field>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><div><h3>企业范围</h3><p>统建与个性化单位口径</p></div></div>
          <div className="card-body stack">
            <div className="grid c2">
              <Field label="模式"><select disabled={!canManage} value={form.enterpriseScope.mode} onChange={e => setEnt({ mode: e.target.value })}>
                <option value="unified">统一建设</option><option value="personalized">统建 + 个性化</option></select></Field>
              <Field label="单位总数"><input type="number" disabled={!canManage} value={form.enterpriseScope.total} onChange={e => setEnt({ total: Number(e.target.value) })} /></Field>
            </div>
            <ChipInput label="统建单位" value={form.enterpriseScope.specialCompanies} onChange={v => setEnt({ specialCompanies: v })} />
            <ChipInput label="个性化单位" value={form.enterpriseScope.provinceCompanies} onChange={v => setEnt({ provinceCompanies: v })} />
            <Field label="企业范围备注"><textarea disabled={!canManage} value={form.enterpriseScope.notes || ''} onChange={e => setEnt({ notes: e.target.value })} /></Field>
          </div>
        </div>
      </div>
    </div>
  )
}

function MembersTab({ projectId, canManage, session }: any) {
  const toast = useToast()
  const members = useAsync<any[]>(() => get(`/api/projects/${projectId}/members`), [projectId])
  const [users, setUsers] = useState<any[]>([])
  const [adding, setAdding] = useState({ userId: '', role: 'developer' })
  useEffect(() => { get<any[]>('/api/users').then(setUsers).catch(() => {}) }, [])
  if (members.loading) return <Loading />
  if (members.error) return <ErrorBox message={members.error} onRetry={members.reload} />
  const candidates = users.filter(u => !members.data!.some(m => m.id === u.id))
  return (
    <div className="card">
      <div className="card-head"><div><h3>项目成员</h3><p>角色决定可执行的动作；服务端逐次校验</p></div></div>
      <div className="card-body">
        {members.data!.map(m => (
          <div key={m.id} className="member-row mb8">
            <span className="avatar sm">{m.name.slice(0, 1)}</span>
            <span className="grow">{m.name}<span className="muted small"> · {m.title || '—'}</span></span>
            {canManage ? <select value={m.project_role} onChange={async e => {
              try { await post(`/api/projects/${projectId}/members`, { userId: m.id, role: e.target.value }); members.reload() } catch (err: any) { toast.push(err.message, 'error') }
            }}>
              <option value="pm">产品经理</option><option value="reviewer">评审人</option><option value="developer">开发</option>
            </select> : <Tag tone="gray">{ROLE_LABEL[m.project_role] || m.project_role}</Tag>}
            {canManage && m.id !== session.user.id && <button className="btn sm danger" onClick={async () => {
              if (!confirm(`移除成员 ${m.name}？`)) return
              try { await del(`/api/projects/${projectId}/members/${m.id}`); members.reload() } catch (err: any) { toast.push(err.message, 'error') }
            }}>移除</button>}
          </div>
        ))}
        {canManage && (
          <div className="row mt16">
            <select style={{ maxWidth: 240 }} value={adding.userId} onChange={e => setAdding({ ...adding, userId: e.target.value })}>
              <option value="">选择要加入的用户</option>
              {candidates.map(u => <option key={u.id} value={u.id}>{u.name}（{ROLE_LABEL[u.role] || u.role}）</option>)}
            </select>
            <select style={{ width: 140 }} value={adding.role} onChange={e => setAdding({ ...adding, role: e.target.value })}>
              <option value="pm">产品经理</option><option value="reviewer">评审人</option><option value="developer">开发</option>
            </select>
            <button className="btn" disabled={!adding.userId} onClick={async () => {
              try { await post(`/api/projects/${projectId}/members`, adding); setAdding({ userId: '', role: 'developer' }); members.reload(); toast.push('成员已更新', 'success') }
              catch (err: any) { toast.push(err.message, 'error') }
            }}>加入项目</button>
          </div>
        )}
      </div>
    </div>
  )
}

function ModelTab({ projectId, canManage }: any) {
  const toast = useToast()
  const cfg = useAsync<any>(() => get(`/api/projects/${projectId}/model`), [projectId])
  const calls = useAsync<any>(() => get(`/api/projects/${projectId}/llm-calls`), [projectId])
  const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '' })
  const [busy, setBusy] = useState('')
  useEffect(() => { if (cfg.data) setForm({ baseUrl: cfg.data.baseUrl || '', model: cfg.data.model || '', apiKey: '' }) }, [cfg.data?.configured])
  if (cfg.loading) return <Loading />
  return (
    <div className="split-2">
      <div className="card">
        <div className="card-head"><div><h3>模型网关</h3><p>OpenAI 兼容接口；密钥 AES-256-GCM 加密存储，不下发前端</p></div>
          <Tag tone={cfg.data?.configured ? 'green' : 'gray'}>{cfg.data?.configured ? '已配置' : '未配置（使用规则引擎）'}</Tag></div>
        <div className="card-body stack">
          <Field label="Base URL"><input type="url" disabled={!canManage} value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
          <Field label="模型名称"><input type="text" disabled={!canManage} value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} placeholder="例如：gpt-4o-mini" /></Field>
          <Field label="API Key" hint={cfg.data?.hasKey ? '已保存；留空表示不修改' : '首次配置需填写'}>
            <input type="password" disabled={!canManage} value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} placeholder={cfg.data?.keyMasked || 'sk-…'} />
          </Field>
          {canManage && <div className="row end">
            <button className="btn" disabled={busy === 'test'} onClick={async () => {
              setBusy('test')
              try { await post(`/api/projects/${projectId}/model/test`, {}); toast.push('模型服务连接正常', 'success') }
              catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
            }}>测试连接</button>
            <button className="btn primary" disabled={busy === 'save'} onClick={async () => {
              setBusy('save')
              try { await put(`/api/projects/${projectId}/model`, form); toast.push('模型配置已保存', 'success'); cfg.reload() }
              catch (e: any) { toast.push(e.message, 'error') } finally { setBusy('') }
            }}>保存配置</button>
          </div>}
          <div className="notice info">未配置或调用失败时，会话自动切换规则引擎，仍可生成提案；不影响门禁与审计。</div>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><div><h3>调用统计</h3><p>Prompt {calls.data?.total.prompt || 0} / Completion {calls.data?.total.completion || 0} tokens</p></div></div>
        <div className="card-body tight" style={{ maxHeight: 360, overflow: 'auto' }}>
          {!calls.data?.calls.length && <Empty title="暂无调用记录" />}
          {calls.data?.calls.map((c: any) => (
            <div key={c.id} className="notif-item">
              <strong>{c.skill_slug || 'chat'} · {c.model || '—'}</strong>
              <span>{c.prompt_tokens} + {c.completion_tokens} tokens · {c.status}</span>
              <div className="tiny muted mt8">{fmtTime(c.created_at)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const SOURCE_LABEL: Record<string, string> = { builtin: '内置', import: '导入', reference: '引用' }

function StagesPicker({ value, onChange, disabled }: any) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row wrap">
        {Object.entries(STAGE_LABEL).map(([key, label]) => (
          <label key={key} className="checkline">
            <input type="checkbox" checked={value.includes(key)} disabled={disabled}
              onChange={e => onChange(e.target.checked ? [...value, key] : value.filter((x: string) => x !== key))} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {!value.length && <span className="tiny muted">不选择时：会话技能由大模型按内容识别；说明书组装只使用勾选「说明书」的技能</span>}
    </div>
  )
}

function sourceTone(s: any) {
  if (!s.sourceAvailable) return 'red'
  if (!s.bindingEnabled) return 'gray'
  return s.packageEnabled ? 'green' : 'amber'
}

function sourceText(s: any) {
  if (!s.sourceAvailable) return '来源不可用'
  if (!s.bindingEnabled) return '已停用'
  return s.packageEnabled ? '已启用' : '技能包停用'
}

function SkillsTab({ projectId, canManage }: any) {
  const toast = useToast()
  const skills = useAsync<any>(() => get(`/api/projects/${projectId}/skills`), [projectId])
  const [adding, setAdding] = useState(false)
  const [mode, setMode] = useState('upload')
  const [stages, setStages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [archive, setArchive] = useState<any>(null)
  const [folderFiles, setFolderFiles] = useState<any[] | null>(null)
  const [folderName, setFolderName] = useState('')
  const [candidates, setCandidates] = useState<any[]>([])
  const [candidateError, setCandidateError] = useState('')
  const [sourceProjectId, setSourceProjectId] = useState('')
  const [sourceBindingId, setSourceBindingId] = useState('')
  const [configuring, setConfiguring] = useState<any>(null)
  const [configStages, setConfigStages] = useState<string[]>([])

  const rows: any[] = skills.data?.skills || []

  useEffect(() => {
    if (!adding || !canManage || mode !== 'reference') return
    let alive = true
    setCandidateError('')
    get<any>(`/api/projects/${projectId}/skills/reference-candidates`)
      .then(r => { if (alive) setCandidates(r.candidates || []) })
      .catch(e => { if (alive) setCandidateError(e.message) })
    return () => { alive = false }
  }, [adding, canManage, mode, projectId])

  const resetAdd = () => {
    setMode('upload'); setStages([]); setArchive(null); setFolderFiles(null); setFolderName('')
    setSourceProjectId(''); setSourceBindingId(''); setCandidates([]); setCandidateError('')
  }
  const openAdd = () => { resetAdd(); setAdding(true) }

  const pickArchive = async (file?: File) => {
    if (!file) return
    if (file.size > 20 * 1024 * 1024) { toast.push('技能包不能超过 20 MB', 'error'); return }
    try {
      const data = await readFile(file)
      setArchive({ name: file.name, base64: data.base64 })
      setFolderFiles(null); setFolderName('')
    } catch (e: any) { toast.push(e.message, 'error') }
  }

  const pickFolder = async (files: FileList | null) => {
    if (!files?.length) return
    if (files.length > 200) { toast.push('技能包文件数量不能超过 200', 'error'); return }
    try {
      const entries: any[] = []
      for (const file of Array.from(files)) {
        const data = await readFile(file)
        entries.push({ path: (file as any).webkitRelativePath || file.name, base64: data.base64 })
      }
      setFolderFiles(entries)
      setFolderName(((files[0] as any).webkitRelativePath || '').split('/')[0])
      setArchive(null)
    } catch (e: any) { toast.push(e.message, 'error') }
  }

  const grouped = candidates.reduce((acc: Record<string, any>, item: any) => {
    const key = item.sourceProject?.id || ''
    if (!acc[key]) acc[key] = { project: item.sourceProject, items: [] }
    acc[key].items.push(item)
    return acc
  }, {})
  const visibleCandidates = sourceProjectId ? (grouped[sourceProjectId]?.items || []) : []

  const submit = async () => {
    if (mode === 'upload' && !archive && !folderFiles) { toast.push('请先选择技能包 zip 或文件夹', 'warn'); return }
    if (mode === 'reference' && !sourceBindingId) { toast.push('请选择要引用的技能', 'warn'); return }
    setBusy(true)
    try {
      if (mode === 'upload') {
        await post(`/api/projects/${projectId}/skills/import`, {
          ...(archive ? { archiveBase64: archive.base64 } : {}),
          ...(folderFiles ? { files: folderFiles } : {}),
          stages
        })
      } else {
        await post(`/api/projects/${projectId}/skills/reference`, { sourceBindingId, stages })
      }
      setAdding(false); resetAdd(); skills.reload(); toast.push('技能已添加', 'success')
    } catch (e: any) { toast.push(e.message, 'error') } finally { setBusy(false) }
  }

  const toggle = async (s: any) => {
    try {
      await patch(`/api/projects/${projectId}/skills/${s.id}`, { enabled: !s.bindingEnabled })
      skills.reload()
    } catch (e: any) { toast.push(e.message, 'error') }
  }

  const saveConfig = async () => {
    try {
      await patch(`/api/projects/${projectId}/skills/${configuring.id}`, { stages: configStages })
      setConfiguring(null); skills.reload(); toast.push('技能环节已更新', 'success')
    } catch (e: any) { toast.push(e.message, 'error') }
  }

  const remove = async (s: any) => {
    if (!confirm(`移除技能「${s.name}」？引用方将标记来源不可用。`)) return
    try {
      await del(`/api/projects/${projectId}/skills/${s.id}`)
      skills.reload(); toast.push('技能已移除', 'info')
    } catch (e: any) { toast.push(e.message, 'error') }
  }

  return (
    <div className="card">
      <div className="card-head">
        <div><h3>项目技能</h3><p>技能只生成提案，不直接写库；导入与引用按当前项目生效</p></div>
        {canManage && <button className="btn primary sm" onClick={openAdd}>＋ 添加技能</button>}
      </div>
      <div className="card-body tight">
        {skills.loading && <Loading />}
        {skills.error && <ErrorBox message={skills.error} onRetry={skills.reload} />}
        {!skills.loading && !skills.error && !rows.length && <Empty title="暂无项目技能" />}
        {rows.map(s => (
          <div key={s.id} className="inbox-item">
            <div className="body">
              <h4>{s.name} <span className="code">{s.slug}@{s.version}</span></h4>
              <div className="excerpt">{s.description || '无说明'}</div>
              <div className="meta">
                <Tag tone={s.sourceType === 'builtin' ? 'blue' : s.sourceType === 'import' ? 'indigo' : 'violet'}>
                  {SOURCE_LABEL[s.sourceType] || s.sourceType}{s.sourceType === 'reference' && s.sourceProject ? ` · ${s.sourceProject.name}` : ''}
                </Tag>
                {s.stages.length
                  ? s.stages.map((key: string) => <Tag key={key} tone="gray">{STAGE_LABEL[key] || key}</Tag>)
                  : <Tag tone="gray">自动识别</Tag>}
                <Tag tone={sourceTone(s)}>{sourceText(s)}</Tag>
                {!s.sourceAvailable && s.sourceReason && <span className="tiny muted">{s.sourceReason}</span>}
              </div>
            </div>
            {canManage && (
              <div className="row">
                <button className="btn sm" onClick={() => { setConfiguring(s); setConfigStages(s.stages || []) }}>配置</button>
                <button className="btn sm" onClick={() => toggle(s)} disabled={!s.sourceAvailable}>{s.bindingEnabled ? '停用' : '启用'}</button>
                {s.sourceType !== 'builtin' && <button className="btn sm danger" onClick={() => remove(s)}>移除</button>}
              </div>
            )}
          </div>
        ))}
      </div>

      {adding && (
        <Modal wide title="添加技能" subtitle="上传技能包或引用其它项目已启用的技能；不会执行包内脚本。" onClose={() => setAdding(false)}
          footer={<><button className="btn" onClick={() => setAdding(false)}>取消</button>
            <button className="btn primary" disabled={busy} onClick={submit}>添加</button></>}>
          <div className="stack">
            <div className="row">
              <button className={`btn sm ${mode === 'upload' ? 'primary' : ''}`} onClick={() => setMode('upload')}>上传技能包</button>
              <button className={`btn sm ${mode === 'reference' ? 'primary' : ''}`} onClick={() => setMode('reference')}>引用其它项目</button>
            </div>

            {mode === 'upload' ? (
              <div className="stack">
                <label className="upload-box"
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); pickArchive(e.dataTransfer.files?.[0]) }}>
                  <input type="file" accept=".zip" hidden onChange={e => { pickArchive(e.target.files?.[0]); e.target.value = '' }} />
                  <strong>{archive ? archive.name : '拖入 zip 技能包，或点击选择'}</strong>
                  <span className="tiny muted">根目录需包含 skill.json；单包不超过 200 个文件、20 MB</span>
                </label>
                <div className="row wrap">
                  <label className="btn sm">选择文件夹
                    <input type="file" hidden multiple
                      {...({ webkitdirectory: '', directory: '' } as any)}
                      onChange={e => { pickFolder(e.target.files); e.target.value = '' }} />
                  </label>
                  {folderName && <span className="small">已选择文件夹：{folderName}（{folderFiles?.length || 0} 个文件）</span>}
                  {(archive || folderFiles) && <button className="btn sm" onClick={() => { setArchive(null); setFolderFiles(null); setFolderName('') }}>清除</button>}
                </div>
              </div>
            ) : (
              <div className="stack">
                {candidateError && <div className="notice warn">{candidateError}</div>}
                {!candidateError && !candidates.length && <Empty title="没有可引用的技能" desc="只显示你是成员的项目中已启用的导入或引用技能" />}
                {candidates.length > 0 && (
                  <div className="form-grid">
                    <Field label="来源项目">
                      <select value={sourceProjectId} onChange={e => { setSourceProjectId(e.target.value); setSourceBindingId('') }}>
                        <option value="">选择来源项目</option>
                        {Object.values(grouped).map((g: any) => <option key={g.project?.id || ''} value={g.project?.id || ''}>{g.project?.name || '未知项目'}</option>)}
                      </select>
                    </Field>
                    <Field label="技能">
                      <select value={sourceBindingId} onChange={e => setSourceBindingId(e.target.value)} disabled={!sourceProjectId}>
                        <option value="">{sourceProjectId ? '选择技能' : '请先选择来源项目'}</option>
                        {visibleCandidates.map((c: any) => <option key={c.sourceBindingId} value={c.sourceBindingId}>{c.name}（{c.slug}@{c.version}）</option>)}
                      </select>
                    </Field>
                  </div>
                )}
                {sourceBindingId && (() => {
                  const c = visibleCandidates.find((x: any) => x.sourceBindingId === sourceBindingId)
                  return c ? <div className="notice info">{c.description || '无说明'}；来源项目：{c.sourceProject?.name || '—'}</div> : null
                })()}
              </div>
            )}

            <div className="stack" style={{ gap: 6 }}>
              <span className="field-label">适用环节<small>不选择则由大模型识别</small></span>
              <StagesPicker value={stages} onChange={setStages} />
            </div>
          </div>
        </Modal>
      )}

      {configuring && (
        <Modal title={`配置「${configuring.name}」`} subtitle="适用环节决定技能在哪些环节出现与可执行" onClose={() => setConfiguring(null)}
          footer={<><button className="btn" onClick={() => setConfiguring(null)}>取消</button>
            <button className="btn primary" onClick={saveConfig}>保存</button></>}>
          <StagesPicker value={configStages} onChange={setConfigStages} />
        </Modal>
      )}
    </div>
  )
}

function AuditsTab({ projectId }: any) {
  const [action, setAction] = useState('')
  const audit = useAsync<any[]>(() => get(`/api/projects/${projectId}/audits?limit=150${action ? `&action=${encodeURIComponent(action)}` : ''}`), [projectId, action])
  return (
    <div className="card">
      <div className="card-head">
        <div><h3>审计日志</h3><p>敏感写入、状态推进、导出与分享均留痕</p></div>
        <div className="row">
          <input type="search" style={{ width: 200 }} placeholder="按动作筛选，回车" defaultValue={action}
            onKeyDown={e => { if (e.key === 'Enter') setAction((e.target as HTMLInputElement).value.trim()) }} />
          <button className="btn sm" onClick={() => downloadUrl(`/api/projects/${projectId}/audits/export`)}>导出 CSV</button>
        </div>
      </div>
      <div className="card-body tight">
        {audit.loading && <Loading />}
        {audit.error && <ErrorBox message={audit.error} onRetry={audit.reload} />}
        {audit.data && !audit.data.length && <Empty title="暂无审计记录" />}
        {audit.data && audit.data.length > 0 && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>时间</th><th>动作</th><th>对象</th><th>操作人</th><th>变更</th></tr></thead>
            <tbody>{audit.data.map(a => (
              <tr key={a.id}>
                <td className="muted small nowrap">{fmtTime(a.created_at)}</td>
                <td><span className="code">{a.action}</span></td>
                <td className="small">{a.object_type} / {a.object_id}</td>
                <td>{a.user_name || '—'}</td>
                <td className="small muted" style={{ maxWidth: 360, wordBreak: 'break-word' }}>{a.after_json || a.before_json || '—'}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  )
}

function ExportsTab({ projectId }: any) {
  const rows = useAsync<any[]>(() => get(`/api/projects/${projectId}/exports`), [projectId])
  return (
    <div className="card">
      <div className="card-head"><div><h3>导出记录</h3><p>说明书 Word、需求清单 Excel 与审计 CSV</p></div>
        <button className="btn sm" onClick={() => downloadUrl(`/api/projects/${projectId}/requirements-export.xlsx`)}>导出需求清单</button></div>
      <div className="card-body tight">
        {rows.loading && <Loading />}
        {rows.error && <ErrorBox message={rows.error} onRetry={rows.reload} />}
        {rows.data && !rows.data.length && <Empty title="暂无导出记录" />}
        {rows.data?.map(e => (
          <div key={e.id} className="inbox-item">
            <div className="body"><h4>{e.type} · {e.format.toUpperCase()}</h4>
              <div className="meta"><span>{e.user_name}</span><span>{fmtTime(e.created_at)}</span><span className="code">{JSON.stringify(e.scope)}</span></div></div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SharesTab({ projectId, canManage }: any) {
  const toast = useToast()
  const shares = useAsync<any[]>(() => get(`/api/projects/${projectId}/shares`), [projectId])
  const forms = useAsync<any[]>(() => get(`/api/projects/${projectId}/forms`), [projectId])
  const reqs = useAsync<any[]>(() => get(`/api/projects/${projectId}/requirements`), [projectId])
  const [form, setForm] = useState({ objectId: '', days: 7 })
  const urlOf = (t: string) => `${location.origin}/#/public/${t}`
  const formUrlOf = (t: string) => `${location.origin}/#/public/form/${t}`
  return (
    <div className="card">
      <div className="card-head"><div><h3>分享链接</h3><p>只读快照，有效期 1–30 天；可随时撤回</p></div></div>
      <div className="card-body stack">
        {canManage && (
          <div className="row wrap">
            <select style={{ maxWidth: 360 }} value={form.objectId} onChange={e => setForm({ ...form, objectId: e.target.value })}>
              <option value="">选择要分享的需求</option>
              {reqs.data?.map((r: any) => <option key={r.id} value={r.id}>{r.code || '未编号'} {r.title}</option>)}
            </select>
            <select style={{ width: 130 }} value={form.days} onChange={e => setForm({ ...form, days: Number(e.target.value) })}>
              {[1, 3, 7, 14, 30].map(d => <option key={d} value={d}>{d} 天</option>)}
            </select>
            <button className="btn primary" disabled={!form.objectId} onClick={async () => {
              try { await post(`/api/projects/${projectId}/shares`, { ...form, objectType: 'requirement' }); toast.push('分享链接已创建', 'success'); shares.reload() }
              catch (e: any) { toast.push(e.message, 'error') }
            }}>创建分享</button>
          </div>
        )}
        {canManage && (
          <div className="row wrap">
            <button className="btn" onClick={async () => {
              try { await post(`/api/projects/${projectId}/forms`, { days: 30 }); toast.push('对外表单已创建', 'success'); forms.reload() }
              catch (e: any) { toast.push(e.message, 'error') }
            }}>创建对外登记表单</button>
            <span className="tiny muted">业务方无需登录即可提交需求，提交后进入待澄清箱</span>
          </div>
        )}
        {shares.loading && <Loading />}
        {shares.error && <ErrorBox message={shares.error} onRetry={shares.reload} />}
        {shares.data && !shares.data.length && <Empty title="暂无分享链接" />}
        {shares.data?.map(s => {
          const req = reqs.data?.find((r: any) => r.id === s.object_id)
          return (
            <div key={s.id} className="share-card">
              <div className="row between mb8">
                <strong>{req ? `${req.code || '未编号'} ${req.title}` : s.object_id}</strong>
                <div className="row">
                  <Tag tone={s.revoked ? 'gray' : s.expired ? 'red' : 'green'}>{s.revoked ? '已撤回' : s.expired ? '已过期' : '有效'}</Tag>
                  <span className="tiny muted">{s.views} 次访问 · 至 {fmtTime(s.expires_at)}</span>
                </div>
              </div>
              <div className="share-url">{urlOf(s.token)}</div>
              <div className="row mt8">
                <CopyButton text={urlOf(s.token)} />
                <button className="btn sm" onClick={() => window.open(urlOf(s.token), '_blank')}>打开</button>
                {canManage && !s.revoked && <button className="btn sm danger" onClick={async () => {
                  try { await post(`/api/shares/${s.id}/revoke`, {}); shares.reload() } catch (e: any) { toast.push(e.message, 'error') }
                }}>撤回</button>}
              </div>
            </div>
          )
        })}
        {forms.data?.map(s => (
          <div key={s.id} className="share-card">
            <div className="row between mb8">
              <strong>对外登记表单</strong>
              <div className="row">
                <Tag tone={s.revoked ? 'gray' : s.expired ? 'red' : 'green'}>{s.revoked ? '已撤回' : s.expired ? '已过期' : '有效'}</Tag>
                <span className="tiny muted">{s.views} 次访问 · 至 {fmtTime(s.expires_at)}</span>
              </div>
            </div>
            <div className="share-url">{formUrlOf(s.token)}</div>
            <div className="row mt8">
              <CopyButton text={formUrlOf(s.token)} />
              <button className="btn sm" onClick={() => window.open(formUrlOf(s.token), '_blank')}>打开</button>
              {canManage && !s.revoked && <button className="btn sm danger" onClick={async () => {
                try { await post(`/api/shares/${s.id}/revoke`, {}); forms.reload() } catch (e: any) { toast.push(e.message, 'error') }
              }}>撤回</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
