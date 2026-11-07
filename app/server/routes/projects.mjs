import { Router } from 'express'
import { all, get, run, now, uid, parseJson } from '../db.mjs'
import {
  projectFor, requireAction, requireFields, recordAudit, projectView,
  deliverNotifications, allProjectPms, STATES, STATUS_FILTERS, STATUS_INDEX, STATUS_TONE, statusLabel
} from '../core.mjs'
import { milestoneOverdue, normalizeMilestones, milestoneView } from '../services/milestones.mjs'
import { ensureBuiltinBindings } from '../services/skills.mjs'
import { knowledgeQuery, knowledgeOptions } from '../services/artifacts.mjs'

export const projectsRouter = Router()

function requireProjectMember(hr, res, next) {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    hr.project = project
    hr.projectId = project.id
    hr.projectRole = role
    next()
  } catch (e) { next(e) }
}

projectsRouter.use('/:projectId', requireProjectMember)

projectsRouter.get('/:projectId/knowledge', (hr, res, next) => {
  try {
    const result = knowledgeQuery(hr.project.id, hr.projectRole, hr.query || {})
    res.json({ ...result, options: knowledgeOptions(hr.project.id) })
  } catch (e) { next(e) }
})

projectsRouter.get('/:projectId/knowledge/meta', (hr, res, next) => {
  try {
    res.json(knowledgeOptions(hr.project.id))
  } catch (e) { next(e) }
})

projectsRouter.get('/', (hr, res) => {
  const rows = hr.user.role === 'admin'
    ? all('SELECT * FROM projects ORDER BY created_at DESC')
    : all(`SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id
           WHERE m.user_id = ? ORDER BY p.created_at DESC`, hr.user.id)
  res.json(rows.map(projectView))
})

projectsRouter.post('/', (hr, res, next) => {
  try {
    const body = hr.body || {}
    requireFields(body, ['name'], '项目')
    const code = (body.code || '').trim().toUpperCase()
    if (code && !/^[A-Z][A-Z0-9]{1,9}$/.test(code)) {
      const e = new Error('项目代号需为 2–10 位大写字母或数字，并以字母开头'); e.statusCode = 400; throw e
    }
    const finalCode = code || ('P' + String(Date.now()).slice(-6))
    if (get('SELECT id FROM projects WHERE code = ?', finalCode)) {
      const e = new Error('项目代号已存在'); e.statusCode = 400; throw e
    }
    const id = uid('PRJ-')
    const ts = now()
    const systems = body.systemScope || {}
    run(`INSERT INTO projects (id, code, name, description, background, goals_json, owner_org, owner_id,
         system_scope_json, enterprise_scope_json, conventions_json, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, finalCode, body.name.trim(), body.description || '', body.background || '',
      JSON.stringify(body.goals || []), body.ownerOrg || '', hr.user.id,
      JSON.stringify({
        platforms: systems.platforms || [], applications: systems.applications || [],
        modules: systems.modules || [], excluded: systems.excluded || [],
        notes: systems.notes || ''
      }),
      JSON.stringify(body.enterpriseScope || { mode: 'unified', specialCompanies: [], provinceCompanies: [], total: 1, personalized: [], notes: '' }),
      JSON.stringify(body.conventions || {}), 'active', ts, ts)

    const members = body.members && body.members.length ? body.members : []
    if (!members.some(m => m.userId === hr.user.id)) members.unshift({ userId: hr.user.id, role: 'pm' })
    for (const m of members) {
      if (!get('SELECT id FROM users WHERE id = ?', m.userId)) continue
      run('INSERT OR REPLACE INTO project_members (project_id, user_id, role, created_at) VALUES (?,?,?,?)',
        id, m.userId, m.role || 'developer', ts)
    }
    ensureBuiltinBindings(id)
    recordAudit(hr, 'project.create', 'project', id, null, { name: body.name, code: finalCode })
    res.status(201).json(projectView(get('SELECT * FROM projects WHERE id = ?', id)))
  } catch (e) { next(e) }
})

projectsRouter.patch('/:projectId', (hr, res, next) => {
  try {
    requireAction(hr.projectRole, 'project.edit')
    const before = projectView(hr.project)
    const body = hr.body || {}
    const fields = []
    const params = []
    const map = {
      name: 'name', description: 'description', background: 'background', ownerOrg: 'owner_org'
    }
    for (const [key, col] of Object.entries(map)) {
      if (body[key] !== undefined) { fields.push(`${col} = ?`); params.push(body[key]) }
    }
    if (body.goals !== undefined) { fields.push('goals_json = ?'); params.push(JSON.stringify(body.goals)) }
    if (body.systemScope !== undefined) { fields.push('system_scope_json = ?'); params.push(JSON.stringify(body.systemScope)) }
    if (body.enterpriseScope !== undefined) { fields.push('enterprise_scope_json = ?'); params.push(JSON.stringify(body.enterpriseScope)) }
    if (body.conventions !== undefined) { fields.push('conventions_json = ?'); params.push(JSON.stringify(body.conventions)) }
    if (!fields.length) { const e = new Error('没有可更新的字段'); e.statusCode = 400; throw e }
    fields.push('updated_at = ?'); params.push(now(), hr.params.projectId)
    run(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, ...params)
    const after = projectView(get('SELECT * FROM projects WHERE id = ?', hr.params.projectId))
    recordAudit(hr, 'project.update', 'project', hr.params.projectId, before, after)
    res.json(after)
  } catch (e) { next(e) }
})

projectsRouter.get('/:projectId', (hr, res) => {
  res.json(projectView(hr.project))
})

projectsRouter.get('/:projectId/members', (hr, res) => {
  const rows = all(`SELECT m.role AS project_role, m.created_at AS joined_at, u.id, u.name, u.title, u.role, u.avatar
    FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.created_at`, hr.projectId)
  res.json(rows)
})

projectsRouter.post('/:projectId/members', (hr, res, next) => {
  try {
    requireAction(hr.projectRole, 'member.manage')
    const { userId, role } = hr.body || {}
    requireFields(hr.body || {}, ['userId', 'role'], '成员')
    if (!get('SELECT id FROM users WHERE id = ?', userId)) { const e = new Error('用户不存在'); e.statusCode = 404; throw e }
    run('INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?,?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role = excluded.role',
      hr.projectId, userId, role, now())
    recordAudit(hr, 'member.upsert', 'member', userId, null, { role })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

projectsRouter.delete('/:projectId/members/:userId', (hr, res, next) => {
  try {
    requireAction(hr.projectRole, 'member.manage')
    if (hr.params.userId === hr.project.owner_id) { const e = new Error('不能移除项目负责人'); e.statusCode = 400; throw e }
    run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', hr.projectId, hr.params.userId)
    recordAudit(hr, 'member.remove', 'member', hr.params.userId, null, null)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

projectsRouter.get('/:projectId/iterations', (hr, res) => {
  const rows = all('SELECT * FROM iterations WHERE project_id = ? ORDER BY start_date DESC, created_at DESC', hr.projectId)
  res.json(rows.map(it => {
    const reqs = all('SELECT id, status, priority_json FROM requirements WHERE iteration_id = ? AND status NOT IN (?,?)',
      it.id, '已丢弃', '需求调研中')
    const used = reqs.reduce((sum, r) => sum + (parseJson(r.priority_json, {})?.estimateDays || 0), 0)
    return {
      ...it, requirementCount: reqs.length, usedDays: Math.round(used * 10) / 10,
      progress: reqs.length ? Math.round(reqs.filter(r => ['全国推广中', '已关闭'].includes(r.status)).length / reqs.length * 100) : 0
    }
  }))
})

function iterationRequirements(iterationId) {
  const rows = all("SELECT * FROM requirements WHERE iteration_id = ? AND status NOT IN ('已丢弃') ORDER BY created_at", iterationId)
  const users = all('SELECT id, name FROM users')
  return rows.map(r => {
    const priority = parseJson(r.priority_json, {})
    const latestAnalysisRow = get('SELECT version FROM requirement_versions WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', r.id)
    const proto = get('SELECT version, status FROM prototypes WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', r.id)
    const spec = get('SELECT id, version, status FROM specs WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', r.id)
    const ms = normalizeMilestones(r.milestones_json)
    return {
      id: r.id, code: r.code, title: r.title, status: r.status,
      statusLabel: statusLabel(r.status), statusIndex: STATUS_INDEX[r.status] ?? null,
      priority: {
        grade: priority.grade || '', gradeLabel: priority.gradeLabel || priority.grade || '未定',
        score: priority.score ?? null, estimateDays: priority.estimateDays || 0
      },
      productManager: ms.productManager || '',
      ownerName: users.find(u => u.id === r.owner_id)?.name || '',
      milestones: milestoneView(r.milestones_json),
      analysisVersion: latestAnalysisRow?.version || 0,
      prototype: proto ? { version: proto.version, status: proto.status } : null,
      spec: spec ? { id: spec.id, version: spec.version, status: spec.status } : null,
      involvedApps: parseJson(r.involved_apps_json, []),
      stallDays: r.stall_since ? Math.floor((Date.now() - Date.parse(r.stall_since)) / 86400000) : 0,
      updatedAt: r.updated_at
    }
  })
}

projectsRouter.get('/:projectId/iterations/:iterationId', (hr, res, next) => {
  try {
    const it = get('SELECT * FROM iterations WHERE id = ? AND project_id = ?', hr.params.iterationId, hr.projectId)
    if (!it) { const e = new Error('迭代不存在'); e.statusCode = 404; throw e }
    const requirements = iterationRequirements(it.id)
    const scoped = requirements.filter(r => r.status !== '需求调研中')
    const used = Math.round(scoped.reduce((s, r) => s + (r.priority.estimateDays || 0), 0) * 10) / 10
    const statusOrder = STATES.filter(s => s !== '已丢弃')
    const groups = statusOrder.map(status => ({
      status, statusLabel: statusLabel(status), count: requirements.filter(r => r.status === status).length,
      requirements: requirements.filter(r => r.status === status)
    })).filter(g => g.count > 0)
    const statusDistribution = groups.map(g => ({ status: g.status, statusLabel: g.statusLabel, count: g.count }))

    const nowMs = Date.now()
    const upcoming = []
    const overdue = []
    for (const r of requirements) {
      for (const f of r.milestones.fields) {
        if (f.plan && !f.actual) {
          const item = { requirementId: r.id, code: r.code, title: r.title, field: f.key, label: f.label, plan: f.plan }
          if (Date.parse(f.plan) < nowMs) overdue.push(item)
          else upcoming.push(item)
        }
      }
    }
    upcoming.sort((a, b) => Date.parse(a.plan) - Date.parse(b.plan))
    overdue.sort((a, b) => Date.parse(a.plan) - Date.parse(b.plan))

    const ids = requirements.map(r => r.id)
    const dependencies = ids.length
      ? all(`SELECT d.*, fr.code AS from_code, fr.title AS from_title, tr.code AS to_code, tr.title AS to_title
             FROM dependencies d LEFT JOIN requirements fr ON fr.id = d.from_req LEFT JOIN requirements tr ON tr.id = d.to_req
             WHERE d.from_req IN (${ids.map(() => '?').join(',')}) OR d.to_req IN (${ids.map(() => '?').join(',')})`,
          ...ids, ...ids)
      : []
    const blockers = []
    for (const r of requirements) {
      if (r.stallDays >= 7 && !['全国推广中', '已关闭', '已丢弃'].includes(r.status)) {
        blockers.push({ type: '停滞', requirementId: r.id, code: r.code, title: r.title, detail: `停留在「${statusLabel(r.status)}」${r.stallDays} 天` })
      }
      if (r.status === '需求评审中') {
        const open = get("SELECT COUNT(*) AS c FROM suggestions WHERE requirement_id = ? AND status IN ('待处理','处理中','不采纳待确认')", r.id)
        if (open.c > 0) blockers.push({ type: '建议积压', requirementId: r.id, code: r.code, title: r.title, detail: `${open.c} 条建议未闭环` })
      }
      if (r.milestones.overdue.length) {
        blockers.push({ type: '里程碑逾期', requirementId: r.id, code: r.code, title: r.title, detail: r.milestones.overdue.map(o => `${o.label}（计划 ${o.plan.slice(0, 10)}）`).join('、') })
      }
    }
    if (it.end_date && Date.parse(it.end_date) < nowMs && !['released', 'closed'].includes(it.status)) {
      blockers.unshift({ type: '迭代逾期', requirementId: null, code: it.name, title: '迭代已超过结束日期', detail: `结束日期 ${it.end_date.slice(0, 10)}` })
    }
    if (it.capacity_days > 0 && used > it.capacity_days) {
      blockers.unshift({ type: '容量超限', requirementId: null, code: it.name, title: '迭代容量超限', detail: `已排 ${used} 人日 / 容量 ${it.capacity_days} 人日` })
    }

    const total = requirements.length
    const pct = n => (total ? Math.round(n / total * 100) : 0)
    const coverage = {
      total,
      analysis: { done: requirements.filter(r => r.analysisVersion > 0).length, total, pct: pct(requirements.filter(r => r.analysisVersion > 0).length) },
      prototype: { done: requirements.filter(r => r.prototype?.status === 'confirmed').length, total, pct: pct(requirements.filter(r => r.prototype?.status === 'confirmed').length) },
      spec: { done: requirements.filter(r => r.spec?.status === 'published').length, total, pct: pct(requirements.filter(r => r.spec?.status === 'published').length) }
    }

    const guest = hr.projectRole === 'guest'
    const specRows = all(`SELECT id, version, mode, status, requirement_count, missing_json, stale, created_by, created_at,
      skill_slug, skill_version, docx_size FROM iteration_specs WHERE iteration_id = ? ORDER BY version DESC`, it.id)
    const visibleSpecs = guest ? specRows.filter(s => s.status !== 'draft') : specRows
    const canManage = ['pm', 'admin'].includes(hr.projectRole) && it.status !== 'released'

    res.json({
      iteration: {
        ...it, usedDays: used, over: it.capacity_days > 0 && used > it.capacity_days,
        utilization: it.capacity_days > 0 ? Math.round(used / it.capacity_days * 100) : null,
        requirementCount: total,
        progress: scoped.length ? Math.round(scoped.filter(r => ['全国推广中', '已关闭'].includes(r.status)).length / scoped.length * 100) : 0
      },
      statusDistribution, groups, requirements,
      milestones: { upcoming: upcoming.slice(0, 10), overdue, overdueCount: overdue.length },
      dependencies: dependencies.map(d => ({
        id: d.id, from: { id: d.from_req, code: d.from_code, title: d.from_title },
        to: { id: d.to_req, code: d.to_code, title: d.to_title }
      })),
      blockers,
      coverage,
      specs: visibleSpecs.map(s => ({
        ...s,
        missing: parseJson(s.missing_json, []),
        skill: s.skill_slug ? { slug: s.skill_slug, version: s.skill_version } : null,
        docxSize: s.docx_size || null
      })),
      permissions: {
        canSchedule: canManage,
        canBatch: canManage,
        canGenerateSpec: canManage,
        readOnly: it.status === 'released',
        role: hr.projectRole
      }
    })
  } catch (e) { next(e) }
})

projectsRouter.post('/:projectId/iterations', (hr, res, next) => {
  try {
    requireAction(hr.projectRole, 'planning.schedule')
    const b = hr.body || {}
    requireFields(b, ['name'], '迭代')
    const id = uid('IT-')
    run(`INSERT INTO iterations (id, project_id, name, goal, start_date, end_date, capacity_days, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      id, hr.projectId, b.name, b.goal || '', b.startDate || '', b.endDate || '',
      Number(b.capacityDays || 0), b.status || 'planning', now())
    recordAudit(hr, 'iteration.create', 'iteration', id, null, b)
    res.status(201).json(get('SELECT * FROM iterations WHERE id = ?', id))
  } catch (e) { next(e) }
})

projectsRouter.patch('/:projectId/iterations/:iterationId', (hr, res, next) => {
  try {
    requireAction(hr.projectRole, 'planning.schedule')
    const b = hr.body || {}
    const it = get('SELECT * FROM iterations WHERE id = ? AND project_id = ?', hr.params.iterationId, hr.projectId)
    if (!it) { const e = new Error('迭代不存在'); e.statusCode = 404; throw e }
    if (it.status === 'released' && b.status !== undefined) {
      const e = new Error('已发布迭代不可修改状态'); e.statusCode = 400; throw e
    }
    run(`UPDATE iterations SET name = ?, goal = ?, start_date = ?, end_date = ?, capacity_days = ?, status = ? WHERE id = ?`,
      b.name ?? it.name, b.goal ?? it.goal, b.startDate ?? it.start_date, b.endDate ?? it.end_date,
      b.capacityDays !== undefined ? Number(b.capacityDays) : it.capacity_days, b.status ?? it.status, it.id)
    recordAudit(hr, 'iteration.update', 'iteration', it.id, it, b)
    res.json(get('SELECT * FROM iterations WHERE id = ?', it.id))
  } catch (e) { next(e) }
})

function riskList(projectId) {
  const risks = []
  const reqs = all('SELECT * FROM requirements WHERE project_id = ? AND status NOT IN (?,?,?)', projectId, '已关闭', '已丢弃', '需求调研中')
  const nowMs = Date.now()
  for (const r of reqs) {
    const stallDays = r.stall_since ? Math.floor((nowMs - Date.parse(r.stall_since)) / 86400000) : 0
    if (stallDays >= 7 && !['全国推广中'].includes(r.status)) {
      risks.push({ level: stallDays >= 14 ? 'high' : 'medium', type: '停滞', requirementId: r.id, code: r.code, title: r.title, detail: `停留在「${statusLabel(r.status)}」${stallDays} 天` })
    }
    if (r.status === '需求评审中') {
      const open = get("SELECT COUNT(*) AS c FROM suggestions WHERE requirement_id = ? AND status IN ('待处理','处理中','不采纳待确认')", r.id)
      const days = r.stall_since ? Math.floor((nowMs - Date.parse(r.stall_since)) / 86400000) : 0
      if (open.c > 0 && days >= 3) risks.push({ level: 'medium', type: '建议积压', requirementId: r.id, code: r.code, title: r.title, detail: `${open.c} 条建议未闭环 ${days} 天` })
    }
    for (const overdue of milestoneOverdue(r.milestones_json, nowMs)) {
      risks.push({
        level: 'medium', type: '里程碑逾期', requirementId: r.id, code: r.code, title: r.title,
        detail: `${overdue.label}计划 ${String(overdue.plan).slice(0, 10)} 已过，尚未登记实际时间`, milestone: overdue.field
      })
    }
    const it = r.iteration_id ? get('SELECT * FROM iterations WHERE id = ?', r.iteration_id) : null
    if (it && it.end_date && Date.parse(it.end_date) < nowMs && !['全国推广中', '已关闭'].includes(r.status)) {
      risks.push({ level: 'high', type: '逾期', requirementId: r.id, code: r.code, title: r.title, detail: `迭代「${it.name}」已于 ${it.end_date.slice(0, 10)} 结束` })
    }
  }
  const iterations = all('SELECT * FROM iterations WHERE project_id = ?', projectId)
  for (const it of iterations) {
    const reqs2 = all('SELECT priority_json FROM requirements WHERE iteration_id = ? AND status NOT IN (?,?)', it.id, '已丢弃', '需求调研中')
    const used = reqs2.reduce((s, r) => s + (parseJson(r.priority_json, {})?.estimateDays || 0), 0)
    if (it.capacity_days > 0 && used > it.capacity_days) {
      risks.push({ level: 'high', type: '容量超限', requirementId: null, code: it.name, title: '迭代容量超限', detail: `已排 ${used} 人日 / 容量 ${it.capacity_days} 人日` })
    }
  }
  return risks
}

projectsRouter.get('/:projectId/overview', (hr, res) => {
  const reqs = all('SELECT status, code FROM requirements WHERE project_id = ? AND status != ?', hr.projectId, '已丢弃')
  const counts = {}
  for (const s of STATUS_FILTERS) counts[s] = 0
  reqs.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1 })
  const iterations = all('SELECT * FROM iterations WHERE project_id = ? ORDER BY created_at DESC', hr.projectId)
  const active = iterations.find(i => i.status === 'active') || iterations[0] || null
  const openSuggestions = get(`SELECT COUNT(*) AS c FROM suggestions s JOIN requirements r ON r.id = s.requirement_id
     WHERE r.project_id = ? AND s.status IN ('待处理','处理中','不采纳待确认')`, hr.projectId)
  const risks = riskList(hr.projectId)
  const recent = all(`SELECT e.*, u.name AS actor_name, r.code AS req_code FROM events e
     LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN requirements r ON r.id = e.requirement_id
     WHERE e.project_id = ? ORDER BY e.created_at DESC LIMIT 12`, hr.projectId)
  const todos = get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND project_id = ? AND read = 0', hr.user.id, hr.projectId)
  res.json({
    counts, iterations, activeIteration: active, openSuggestions: openSuggestions.c,
    risks: risks.slice(0, 8), riskTotal: risks.length,
    recentEvents: recent.map(e => ({ ...e, payload: parseJson(e.payload_json, {}) })),
    unread: todos.c,
    statusFilters: STATUS_FILTERS.map(s => ({ name: s, label: statusLabel(s), index: STATUS_INDEX[s] ?? null, tone: STATUS_TONE[s] || 'gray', count: counts[s] || 0 })),
    totals: {
      all: reqs.length, pool: reqs.filter(r => r.code).length,
      inbox: counts['需求调研中'] || 0
    }
  })
})

projectsRouter.get('/:projectId/risks', (hr, res) => {
  res.json(riskList(hr.projectId))
})

projectsRouter.get('/:projectId/todos', (hr, res) => {
  const notes = all('SELECT * FROM notifications WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 50', hr.user.id, hr.projectId)
  const tasks = []
  const role = hr.projectRole
  if (['pm', 'admin'].includes(role)) {
    for (const r of all("SELECT * FROM requirements WHERE project_id = ? AND status = '需求调研中' ORDER BY created_at", hr.projectId)) {
      tasks.push({ type: '待澄清', title: r.title, requirementId: r.id, code: r.code || '未编号', tone: 'gray' })
    }
    for (const r of all("SELECT * FROM requirements WHERE project_id = ? AND status = '待需求分析' ORDER BY created_at", hr.projectId)) {
      tasks.push({ type: '待分析', title: r.title, requirementId: r.id, code: r.code, tone: 'blue' })
    }
    for (const r of all("SELECT * FROM requirements WHERE project_id = ? AND status = '需求分析中' ORDER BY created_at", hr.projectId)) {
      tasks.push({ type: '待提交评审', title: r.title, requirementId: r.id, code: r.code, tone: 'violet' })
    }
    for (const s of all(`SELECT s.*, r.code, r.title FROM suggestions s JOIN requirements r ON r.id = s.requirement_id
      WHERE r.project_id = ? AND s.status IN ('待处理','处理中','不采纳待确认') ORDER BY s.created_at`, hr.projectId)) {
      tasks.push({ type: '待闭环建议', title: s.title, requirementId: s.requirement_id, code: s.code, tone: 'orange', suggestionId: s.id })
    }
  }
  if (role === 'reviewer' || role === 'admin') {
    for (const rv of all(`SELECT rv.*, r.code, r.title FROM reviews rv JOIN requirements r ON r.id = rv.requirement_id
      WHERE r.project_id = ? AND rv.status = '进行中' AND (rv.reviewers_json LIKE ? OR ? = 'admin')`, hr.projectId, `%${hr.user.id}%`, role)) {
      tasks.push({ type: '待评审', title: rv.title, requirementId: rv.requirement_id, code: rv.code, tone: 'amber', reviewId: rv.id })
    }
  }
  if (role === 'developer' || role === 'admin') {
    for (const r of all("SELECT * FROM requirements WHERE project_id = ? AND status = '待测试验证'", hr.projectId)) {
      tasks.push({ type: '待测试验证', title: r.title, requirementId: r.id, code: r.code, tone: 'cyan' })
    }
  }
  res.json({ tasks, notifications: notes })
})

projectsRouter.get('/:projectId/tracking', (hr, res) => {
  const counts = {}
  const reqs = all('SELECT * FROM requirements WHERE project_id = ? AND status != ?', hr.projectId, '已丢弃')
  reqs.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1 })
  const timeline = all(`SELECT e.*, u.name AS actor_name, r.code AS req_code FROM events e
    LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN requirements r ON r.id = e.requirement_id
    WHERE e.project_id = ? ORDER BY e.created_at DESC LIMIT 80`, hr.projectId)
  res.json({
    counts, total: reqs.length,
    risks: riskList(hr.projectId),
    timeline: timeline.map(e => ({ ...e, payload: parseJson(e.payload_json, {}) })),
    generatedAt: now()
  })
})

projectsRouter.post('/:projectId/notifications/read', (hr, res) => {
  run('UPDATE notifications SET read = 1 WHERE user_id = ? AND project_id = ?', hr.user.id, hr.projectId)
  res.json({ ok: true })
})

projectsRouter.get('/:projectId/search', (hr, res) => {
  const q = `%${(hr.query.q || '').trim()}%`
  const rows = all(`SELECT id, code, title, status FROM requirements
    WHERE project_id = ? AND status != '已丢弃' AND (title LIKE ? OR code LIKE ?) ORDER BY updated_at DESC LIMIT 20`,
    hr.projectId, q, q)
  res.json(rows)
})

export { riskList, allProjectPms, deliverNotifications, requireProjectMember }
