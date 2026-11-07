import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { fmtTime, get, navigate, post } from './api'
import { Loading, useToast } from './ui'
import ProjectsPage from './pages/Projects'
import Overview from './pages/Overview'
import Inbox from './pages/Inbox'
import Pool from './pages/Pool'
import Iterations from './pages/Iterations'
import IterationDetail from './pages/IterationDetail'
import Planning from './pages/Planning'
import Tracking from './pages/Tracking'
import ReviewCenter from './pages/ReviewCenter'
import Settings from './pages/Settings'
import Workbench from './pages/Workbench'
import RequirementDetail from './pages/RequirementDetail'
import Knowledge from './pages/Knowledge'
import Shared from './pages/Shared'
import PublicForm from './pages/PublicForm'

export type SessionUser = { id: string; name: string; title: string; role: string; avatar?: string }
export type Session = { user: SessionUser | null; demoUsers: SessionUser[]; roles: string[] }

const NAV = [
  ['overview', '概览'], ['inbox', '待澄清箱'], ['pool', '需求池'], ['iterations', '迭代'],
  ['tracking', '跟进'], ['knowledge', '知识库'], ['reviews', '评审'], ['settings', '设置']
]

const ROLE_LABEL: Record<string, string> = { pm: '产品经理', reviewer: '评审人', developer: '开发', admin: '管理员', guest: '访客' }

function useRoute() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return useMemo(() => hash.replace(/^#/, '').split('/').filter(Boolean), [hash])
}

function Login({ session, onLogin }: { session: Session; onLogin: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState('')
  return (
    <div className="login-wrap">
      <div className="login-hero">
        <div className="brand" style={{ color: '#fff' }}>
          <span className="brand-mark">需</span><span className="brand-text">需求管理工作台</span>
        </div>
        <div>
          <h1>从一句想法到可评审、可开发、可交付的完整需求</h1>
          <p>把收集、澄清、分析、原型、评审、变更与规划固化在同一条有状态、有门禁的流水线里。所有写入先成为提案，确认后生效。</p>
          <div className="login-points">
            <div className="login-point"><strong>自然语言驱动</strong><span>会话生成分析、原型与说明书，右侧实时预览</span></div>
            <div className="login-point"><strong>门禁式推进</strong><span>澄清齐备才能入池，评审闭环才能进入开发</span></div>
            <div className="login-point"><strong>全程可追溯</strong><span>版本互锁、变更分级、操作审计与导出留痕</span></div>
            <div className="login-point"><strong>角色化协作</strong><span>产品、评审、开发按职责分工，权限服务端校验</span></div>
          </div>
        </div>
        <p style={{ fontSize: 12 }}>演示环境使用本地种子数据，不连接外部系统。</p>
      </div>
      <div className="login-panel">
        <div className="login-card">
          <h2>选择演示账号</h2>
          <p>切换账号可体验不同角色可见的操作与门禁。</p>
          <div className="account-list">
            {session.demoUsers.map(u => (
              <button key={u.id} className="account" disabled={Boolean(busy)} onClick={async () => { setBusy(u.id); await onLogin(u.id) }}>
                <span className="avatar">{(u.name || '?').slice(0, 1)}</span>
                <span className="meta">
                  <strong>{u.name}</strong>
                  <span>{ROLE_LABEL[u.role] || u.role} · {u.title || '—'}</span>
                </span>
                <span className="muted small">{busy === u.id ? '登录中…' : '进入 →'}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<{ unread: number; items: any[] }>({ unread: 0, items: [] })
  const load = useCallback(async () => {
    try { setData(await get('/api/notifications')) } catch { /* 静默 */ }
  }, [])
  useEffect(() => { load() }, [load])
  return (
    <div className="notif-wrap">
      <button className="icon-btn bell" onClick={async () => { setOpen(v => !v); if (!open) await load() }} aria-label="通知">
        ◔
        {data.unread > 0 && <span className="badge">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="notif-pop">
          <div className="card-head" style={{ padding: '10px 14px' }}>
            <h3>通知</h3>
            <button className="link-btn" onClick={async () => { await post('/api/notifications/read', {}); await load() }}>全部已读</button>
          </div>
          {!data.items.length && <div className="empty-state" style={{ padding: 24 }}><p>暂无通知</p></div>}
          {data.items.map(n => (
            <div key={n.id} className={`notif-item ${n.read ? '' : 'unread'}`}>
              <strong>{n.title}</strong>
              <span>{n.body}</span>
              <div className="tiny muted mt8">{fmtTime(n.created_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const route = useRoute()
  const toast = useToast()
  const [session, setSession] = useState<Session | null>(null)
  const [projects, setProjects] = useState<any[]>([])
  const [projectRole, setProjectRole] = useState('')
  const [notReady, setNotReady] = useState(true)

  const boot = useCallback(async () => {
    try {
      const s = await get<Session>('/api/session')
      setSession(s)
      if (s.user) {
        const [ps] = await Promise.all([get<any[]>('/api/projects')])
        setProjects(ps)
      }
    } catch (e: any) {
      toast.push(e.message, 'error')
    } finally { setNotReady(false) }
  }, [toast])

  useEffect(() => { boot() }, [boot])

  const projectId = route[0] === 'p' ? route[1] : ''
  const project = projects.find(p => p.id === projectId)

  useEffect(() => {
    if (!projectId || !session?.user) { setProjectRole(''); return }
    let alive = true
    get<any[]>(`/api/projects/${projectId}/members`).then(ms => {
      if (!alive) return
      const me = ms.find(m => m.id === session.user!.id)
      setProjectRole(me?.project_role || (session.user!.role === 'admin' ? 'admin' : ''))
    }).catch(() => { if (alive) setProjectRole('') })
    return () => { alive = false }
  }, [projectId, session?.user?.id])

  const login = async (userId: string) => {
    await post('/api/session', { userId })
    location.hash = '/projects'
    location.reload()
  }

  if (route[0] === 'public' && route[1] === 'form' && route[2]) return <PublicForm token={route[2]} />
  if (route[0] === 'public' && route[1]) return <Shared token={route[1]} />

  if (notReady || !session) return <div style={{ padding: 60 }}><Loading label="正在加载工作台…" /></div>
  if (!session.user) return <Login session={session} onLogin={login} />

  const refreshProjects = async () => {
    const ps = await get<any[]>('/api/projects')
    setProjects(ps)
  }

  const switching = async (id: string) => {
    const u = session.demoUsers.find(x => x.id === id)
    if (u) await login(u.id)
  }

  const nav = (
    <div className="topbar-nav">
      {projectId && NAV.map(([key, label]) => {
        const active = route[2] === key
          || (key === 'iterations' && route[2] === 'planning')
          || (key === 'pool' && route[2] === 'requirements')
          || (!route[2] && key === 'overview')
        return <button key={key} className={`nav-link ${active ? 'active' : ''}`}
          onClick={() => navigate(`/p/${projectId}/${key}`)}>{label}</button>
      })}
    </div>
  )

  let page: React.ReactNode
  if (route[0] === 'projects') {
    page = <ProjectsPage projects={projects} session={session} onRefresh={refreshProjects}
      onOpen={id => navigate(`/p/${id}/overview`)} onCreated={async id => { await refreshProjects(); navigate(`/p/${id}/overview`) }} />
  } else if (projectId && route[2] === 'req' && route[3]) {
    page = <Workbench projectId={projectId} reqId={route[3]} stage={route[4] || 'clarify'}
      session={session} projectRole={projectRole} projects={projects} onProjectsChange={refreshProjects} />
  } else if (projectId && route[2] === 'requirements' && route[3]) {
    page = <RequirementDetail projectId={projectId} reqId={route[3]} projectRole={projectRole} />
  } else if (projectId && route[2] === 'iterations' && route[3]) {
    page = <IterationDetail projectId={projectId} iterationId={route[3]} projectRole={projectRole} />
  } else if (projectId) {
    const section = route[2] || 'overview'
    const common = { projectId, session, project, projectRole }
    if (section === 'inbox') page = <Inbox {...common} />
    else if (section === 'pool') page = <Pool {...common} />
    else if (section === 'iterations') page = <Iterations {...common} />
    else if (section === 'planning') page = <Planning {...common} />
    else if (section === 'tracking') page = <Tracking {...common} />
    else if (section === 'knowledge') page = <Knowledge {...common} />
    else if (section === 'reviews') page = <ReviewCenter {...common} />
    else if (section === 'settings') page = <Settings {...common} onProjectsChange={refreshProjects} onLeave={() => navigate('/projects')} />
    else page = <Overview {...common} />
  } else {
    page = <ProjectsPage projects={projects} session={session} onRefresh={refreshProjects}
      onOpen={id => navigate(`/p/${id}/overview`)} onCreated={async id => { await refreshProjects(); navigate(`/p/${id}/overview`) }} />
  }

  const full = projectId && route[2] === 'req'

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" style={{ cursor: 'pointer' }} onClick={() => navigate('/projects')}>
          <span className="brand-mark">需</span><span className="brand-text">需求管理工作台</span>
        </div>
        {nav}
        <div className="topbar-right">
          {projectId && (
            <select className="project-switch" value={projectId} onChange={e => navigate(`/p/${e.target.value}/overview`)}>
              {!project && <option value={projectId}>当前项目</option>}
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <NotificationBell />
          <div className="user-chip">
            <span className="avatar">{session.user.name.slice(0, 1)}</span>
            <select value={session.user.id} onChange={e => switching(e.target.value)} title="切换演示账号">
              {session.demoUsers.map(u => <option key={u.id} value={u.id}>{u.name}（{ROLE_LABEL[u.role] || u.role}）</option>)}
            </select>
          </div>
        </div>
      </header>
      <main className={`main ${full ? 'full' : ''}`}>{page}</main>
    </div>
  )
}
