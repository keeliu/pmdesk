import { Router } from 'express'
import { all, get, run, now, uid, parseJson, logEvent } from '../db.mjs'
import {
  requirementFor, projectFor, requireAction, requireFields, recordAudit, deliverNotifications, allProjectPms, STATUS_INDEX
} from '../core.mjs'
import { normalizeMilestones, applyRollback } from '../services/milestones.mjs'

export const changesRouter = Router()

const GRADES = ['一般', '中等', '重大']
const rank = g => GRADES.indexOf(g)

function impactOf(req, body) {
  const flags = {
    apps: Boolean(body.appsChanged),
    integration: Boolean(body.integrationChanged),
    acceptance: Boolean(body.acceptanceChanged),
    functions: Boolean(body.functionChanged)
  }
  const text = String(body.content || '')
  if (/涉及应用|集成点|验收口径|验收标准/.test(text)) {
    if (/涉及应用|应用调整/.test(text)) flags.apps = true
    if (/集成点|接口/.test(text)) flags.integration = true
    if (/验收口径|验收标准/.test(text)) flags.acceptance = true
  }
  if (/功能|页面|原型|流程/.test(text)) flags.functions = true
  let grade = '一般'
  if (flags.functions) grade = '中等'
  if (flags.apps || flags.integration || flags.acceptance) grade = '重大'
  return {
    grade, flags,
    notes: [
      flags.apps ? '触及涉及应用' : '', flags.integration ? '触及集成点' : '',
      flags.acceptance ? '触及验收口径' : '', flags.functions ? '调整功能或原型' : ''
    ].filter(Boolean)
  }
}

function changeView(c) {
  return { ...c, impact: parseJson(c.impact_json, {}) }
}

changesRouter.get('/requirements/:id/changes', (hr, res, next) => {
  try {
    const { req } = requirementFor(hr.user, hr.params.id)
    const rows = all('SELECT * FROM changes WHERE requirement_id = ? ORDER BY seq DESC', req.id)
    res.json(rows.map(changeView))
  } catch (e) { next(e) }
})

changesRouter.get('/projects/:projectId/changes', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    const rows = all(`SELECT c.*, r.code, r.title, r.status AS req_status
      FROM changes c JOIN requirements r ON r.id = c.requirement_id
      WHERE r.project_id = ? ORDER BY c.created_at DESC`, project.id)
    res.json(rows.map(changeView))
  } catch (e) { next(e) }
})

changesRouter.post('/requirements/:id/changes', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'change.create')
    requireFields(hr.body || {}, ['reason', 'content'], '变更')
    if (!['需求分析中', '需求评审中', '待开发', '开发中', '待测试验证', '测试验证中', '待UAT', 'UAT中', '待试点', '试点中', '待上线发版', '全国推广中'].includes(req.status)) {
      const e = new Error(`当前状态「${req.status}」不能发起变更`); e.statusCode = 400; throw e
    }
    const impact = impactOf(req, hr.body)
    if (hr.body.grade && rank(hr.body.grade) > rank(impact.grade)) {
      impact.grade = hr.body.grade
      impact.notes.push('人工上调分级')
    }
    let grade = impact.grade
    if (hr.body.grade && rank(hr.body.grade) < rank(grade) && !['admin'].includes(role)) {
      const e = new Error('变更分级只能上调，不能下调'); e.statusCode = 400; throw e
    }
    const last = get('SELECT MAX(seq) AS m FROM changes WHERE requirement_id = ?', req.id)
    const id = uid('CHG-')
    const beforeSpec = get('SELECT * FROM specs WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', req.id)
    const status = grade === '重大' ? '待决定' : grade === '中等' ? '待知会' : '待应用'
    run(`INSERT INTO changes (id, requirement_id, seq, reason, content, grade, impact_json, handling, status, before_spec, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, req.id, (last?.m || 0) + 1, hr.body.reason, hr.body.content, grade,
      JSON.stringify(impact), '', status, beforeSpec?.id || '', hr.user.id, now())
    if (grade === '中等') {
      const reviewers = all("SELECT DISTINCT user_id FROM project_members WHERE project_id = ? AND role = 'reviewer'", project.id)
      deliverNotifications(project.id, reviewers.map(r => r.user_id), 'change', `变更待知会：${req.code}`, hr.body.content.slice(0, 80))
    }
    logEvent({ projectId: project.id, requirementId: req.id, type: 'change', message: `发起变更 CHG-${String((last?.m || 0) + 1).padStart(3, '0')}（${grade}）`, payload: { grade, status }, actorId: hr.user.id })
    recordAudit(hr, 'change.create', 'change', id, null, { grade, status })
    res.status(201).json({ id, seq: (last?.m || 0) + 1, grade, status, impact })
  } catch (e) { next(e) }
})

changesRouter.post('/changes/:id/acknowledge', (hr, res, next) => {
  try {
    const c = get('SELECT * FROM changes WHERE id = ?', hr.params.id)
    if (!c) { const e = new Error('变更不存在'); e.statusCode = 404; throw e }
    const { req, project, role } = requirementFor(hr.user, c.requirement_id)
    if (!['reviewer', 'pm', 'admin'].includes(role)) { const e = new Error('仅评审人或产品经理可确认变更'); e.statusCode = 403; throw e }
    if (c.status !== '待知会') { const e = new Error('当前变更无需知会'); e.statusCode = 400; throw e }
    run("UPDATE changes SET status = '待应用' WHERE id = ?", c.id)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'change-ack', message: `变更已知会确认`, payload: { changeId: c.id }, actorId: hr.user.id })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

changesRouter.post('/changes/:id/apply', (hr, res, next) => {
  try {
    const c = get('SELECT * FROM changes WHERE id = ?', hr.params.id)
    if (!c) { const e = new Error('变更不存在'); e.statusCode = 404; throw e }
    const { req, project, role } = requirementFor(hr.user, c.requirement_id)
    requireAction(role, 'change.resolve')
    if (c.grade === '重大') { const e = new Error('重大变更必须重新登记或重新评审'); e.statusCode = 400; throw e }
    if (c.status === '待知会') { const e = new Error('中等变更需评审人知会确认后才能应用'); e.statusCode = 400; throw e }
    if (c.status !== '待应用') { const e = new Error(`当前变更状态为 ${c.status}，不能应用`); e.statusCode = 400; throw e }
    const afterSpec = get('SELECT * FROM specs WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', req.id)
    run("UPDATE changes SET status = '已应用', after_spec = ?, resolved_at = ? WHERE id = ?", afterSpec?.id || '', now(), c.id)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'change-apply', message: `应用变更 CHG-${String(c.seq).padStart(3, '0')}`, payload: { changeId: c.id }, actorId: hr.user.id })
    recordAudit(hr, 'change.apply', 'change', c.id, { status: c.status }, { status: '已应用' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

changesRouter.post('/changes/:id/resolve', (hr, res, next) => {
  try {
    const c = get('SELECT * FROM changes WHERE id = ?', hr.params.id)
    if (!c) { const e = new Error('变更不存在'); e.statusCode = 404; throw e }
    const { req, project, role } = requirementFor(hr.user, c.requirement_id)
    requireAction(role, 'change.resolve')
    if (c.grade !== '重大') { const e = new Error('仅重大变更需要选择处理方式'); e.statusCode = 400; throw e }
    const handling = hr.body?.handling
    if (!['重新登记', '重新评审', '转新需求'].includes(handling)) {
      const e = new Error('处理方式必须为重新登记或重新评审'); e.statusCode = 400; throw e
    }
    if (handling === '重新评审') {
      run("UPDATE changes SET status = '已重新评审', handling = ?, resolved_at = ? WHERE id = ?", handling, now(), c.id)
      if (!['需求评审中', '需求分析中'].includes(req.status)) {
        const ms = applyRollback(normalizeMilestones(req.milestones_json), STATUS_INDEX['需求评审中'], '需求评审中')
        run("UPDATE requirements SET status = '需求评审中', milestones_json = ?, stall_since = ?, updated_at = ? WHERE id = ?",
          JSON.stringify(ms.milestones), now(), now(), req.id)
        logEvent({ projectId: project.id, requirementId: req.id, type: 'status', message: `${req.status} → 需求评审中（重大变更）`, payload: { from: req.status, to: '需求评审中', cleared: ms.cleared, flagged: ms.flagged }, actorId: hr.user.id })
      }
      const reviewers = all("SELECT user_id FROM project_members WHERE project_id = ? AND role = 'reviewer'", project.id)
      deliverNotifications(project.id, reviewers.map(r => r.user_id), 'change', `重大变更需重新评审：${req.code}`, c.content.slice(0, 80))
    } else {
      const newId = uid('REQ-')
      const ts = now()
      run(`INSERT INTO requirements (id, project_id, title, status, origin_type, source_json, clarification_json,
           involved_apps_json, owner_id, created_at, updated_at, stall_since) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        newId, project.id, `${req.title}（变更派生）`, '需求调研中', 'change',
        JSON.stringify({ type: 'change', parentRequirementId: req.id, parentCode: req.code, fullText: c.content, excerpt: c.content, reason: c.reason }),
        JSON.stringify({ answers: {}, history: [], completed: false }), JSON.stringify([]),
        req.owner_id || hr.user.id, ts, ts, ts)
      run("UPDATE changes SET status = '已转新需求', handling = ?, resolved_at = ? WHERE id = ?", handling, now(), c.id)
      logEvent({ projectId: project.id, requirementId: req.id, type: 'change-register', message: `重大变更派生新需求`, payload: { newId }, actorId: hr.user.id })
    }
    recordAudit(hr, 'change.resolve', 'change', c.id, { status: c.status }, { handling })
    res.json({ ok: true, handling })
  } catch (e) { next(e) }
})

changesRouter.post('/changes/:id/grade', (hr, res, next) => {
  try {
    const c = get('SELECT * FROM changes WHERE id = ?', hr.params.id)
    if (!c) { const e = new Error('变更不存在'); e.statusCode = 404; throw e }
    const { req, role } = requirementFor(hr.user, c.requirement_id)
    requireAction(role, 'change.resolve')
    const grade = hr.body?.grade
    if (!GRADES.includes(grade)) { const e = new Error('无效分级'); e.statusCode = 400; throw e }
    if (rank(grade) < rank(c.grade) && role !== 'admin') {
      const e = new Error('分级只能上调，下调需管理员豁免'); e.statusCode = 403; throw e
    }
    if (rank(grade) < rank(c.grade) && !hr.body?.exemption) {
      const e = new Error('管理员下调分级需填写豁免说明'); e.statusCode = 400; throw e
    }
    run('UPDATE changes SET grade = ? WHERE id = ?', grade, c.id)
    recordAudit(hr, 'change.grade', 'change', c.id, { grade: c.grade }, { grade, exemption: hr.body?.exemption || '' })
    res.json({ ok: true, grade })
  } catch (e) { next(e) }
})
