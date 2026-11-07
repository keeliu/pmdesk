import { Router } from 'express'
import { all, get, run, tx, now, uid, parseJson, logEvent } from '../db.mjs'
import {
  requirementFor, projectFor, requireAction, requireFields, recordAudit,
  deliverNotifications, allProjectPms
} from '../core.mjs'
import { buildPriority, comparePriority, LEVEL_LABEL, DIMENSIONS } from '../services/priority.mjs'
import { transitionRequirement } from '../services/status.mjs'

export const planningRouter = Router()

function usedDays(iterationId) {
  return Math.round(all('SELECT priority_json FROM requirements WHERE iteration_id = ? AND status NOT IN (?,?)', iterationId, '已丢弃', '需求调研中')
    .reduce((s, r) => s + (parseJson(r.priority_json, {})?.estimateDays || 0), 0) * 10) / 10
}

function iterationView(it) {
  const reqs = all("SELECT * FROM requirements WHERE iteration_id = ? AND status NOT IN ('已丢弃','需求调研中') ORDER BY created_at", it.id)
  const used = usedDays(it.id)
  return {
    ...it, usedDays: used,
    over: it.capacity_days > 0 && used > it.capacity_days,
    requirements: reqs.map(r => ({ id: r.id, code: r.code, title: r.title, status: r.status, priority: parseJson(r.priority_json, {}) }))
  }
}

planningRouter.get('/projects/:projectId/planning', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    const iterations = all('SELECT * FROM iterations WHERE project_id = ? ORDER BY start_date, created_at', project.id).map(iterationView)
    const unscheduled = all("SELECT * FROM requirements WHERE project_id = ? AND iteration_id IS NULL AND status NOT IN ('需求调研中','已丢弃') ORDER BY created_at", project.id)
      .map(r => ({ id: r.id, code: r.code, title: r.title, status: r.status, priority: parseJson(r.priority_json, {}), involvedApps: parseJson(r.involved_apps_json, []) }))
    const deps = all('SELECT * FROM dependencies WHERE project_id = ?', project.id)
    const reqs = all("SELECT id, code, title, status FROM requirements WHERE project_id = ? AND status NOT IN ('需求调研中','已丢弃','已关闭')", project.id)
    res.json({ iterations, unscheduled, dependencies: deps, requirements: reqs })
  } catch (e) { next(e) }
})

planningRouter.get('/priorities/model', (hr, res) => {
  res.json({ dimensions: DIMENSIONS, levels: LEVEL_LABEL })
})

planningRouter.put('/requirements/:id/priority', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'planning.schedule')
    const b = hr.body || {}
    const source = parseJson(req.source_json, {})
    const clar = parseJson(req.clarification_json, {})
    const hay = [req.title, source.fullText || '', source.excerpt || '', ...Object.values(clar.answers || {}).map(a => a.value || '')].join('\n')
    const priority = buildPriority({
      req, project, text: hay,
      input: {
        values: b.values, evidence: b.evidence, grade: b.grade, reason: b.reason,
        estimateDays: b.estimateDays, floor: b.floor, floorReason: b.floorReason
      },
      actor: hr.user.name
    })
    if (priority.manual && !String(priority.reason || '').trim()) {
      const e = new Error('人工调整优先级必须填写理由'); e.statusCode = 400; throw e
    }
    run('UPDATE requirements SET priority_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(priority), now(), req.id)
    logEvent({ projectId: req.project_id, requirementId: req.id, type: 'priority', message: `优先级 ${priority.gradeLabel}（${priority.score} 分）`, payload: priority, actorId: hr.user.id })
    recordAudit(hr, 'requirement.priority', 'requirement', req.id, parseJson(req.priority_json, null), priority)
    res.json(priority)
  } catch (e) { next(e) }
})

planningRouter.post('/projects/:projectId/priorities/recalculate', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'planning.schedule')
    const reqs = all("SELECT * FROM requirements WHERE project_id = ? AND status NOT IN ('需求调研中','已丢弃')", project.id)
    const updated = []
    for (const req of reqs) {
      const source = parseJson(req.source_json, {})
      const clar = parseJson(req.clarification_json, {})
      const hay = [req.title, source.fullText || '', source.excerpt || '', ...Object.values(clar.answers || {}).map(a => a.value || '')].join('\n')
      const old = parseJson(req.priority_json, null)
      const priority = buildPriority({
        req, project, text: hay,
        input: { estimateDays: old?.estimateDays, grade: old?.manual ? old.grade : undefined, reason: old?.reason },
        actor: hr.user.name
      })
      run('UPDATE requirements SET priority_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(priority), now(), req.id)
      updated.push({ id: req.id, code: req.code, from: old?.grade || '', to: priority.grade, score: priority.score })
    }
    logEvent({ projectId: project.id, type: 'priority-recalculate', message: `重算优先级 ${updated.length} 条`, payload: { updated }, actorId: hr.user.id })
    recordAudit(hr, 'priority.recalculate', 'project', project.id, null, { count: updated.length })
    res.json({ ok: true, updated })
  } catch (e) { next(e) }
})

planningRouter.post('/requirements/:id/schedule', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'planning.schedule')
    const iterationId = hr.body?.iterationId || null
    if (!iterationId) {
      run('UPDATE requirements SET iteration_id = NULL, updated_at = ? WHERE id = ?', now(), req.id)
      logEvent({ projectId: project.id, requirementId: req.id, type: 'schedule', message: '移出迭代，回到未排期', payload: {}, actorId: hr.user.id })
      return res.json({ ok: true, iterationId: null })
    }
    const it = get('SELECT * FROM iterations WHERE id = ? AND project_id = ?', iterationId, project.id)
    if (!it) { const e = new Error('迭代不存在'); e.statusCode = 404; throw e }
    if (it.status === 'released') { const e = new Error('已发布迭代不可排入需求'); e.statusCode = 400; throw e }
    if (req.status === '需求调研中' || req.status === '已丢弃') {
      const e = new Error('需求调研中或已丢弃需求不能排期'); e.statusCode = 400; throw e
    }
    const add = parseJson(req.priority_json, {})?.estimateDays || 0
    const used = usedDays(it.id) + add
    if (it.capacity_days > 0 && used > it.capacity_days) {
      const e = new Error(`容量超限：已排 ${Math.round(used * 10) / 10} 人日 / 容量 ${it.capacity_days} 人日，请调整范围`); e.statusCode = 400; throw e
    }
    run('UPDATE requirements SET iteration_id = ?, updated_at = ? WHERE id = ?', it.id, now(), req.id)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'schedule', message: `排入迭代「${it.name}」`, payload: { iterationId: it.id }, actorId: hr.user.id })
    res.json({ ok: true, iterationId: it.id, usedDays: Math.round(used * 10) / 10 })
  } catch (e) { next(e) }
})

planningRouter.post('/projects/:projectId/planning/batch-schedule', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'planning.schedule')
    const ids = hr.body?.requirementIds || []
    const iterationId = hr.body?.iterationId
    const it = get('SELECT * FROM iterations WHERE id = ? AND project_id = ?', iterationId, project.id)
    if (!it) { const e = new Error('迭代不存在'); e.statusCode = 404; throw e }
    let used = usedDays(it.id)
    const success = [], failed = []
    for (const id of ids) {
      const r = get('SELECT * FROM requirements WHERE id = ? AND project_id = ?', id, project.id)
      if (!r) { failed.push({ id, reason: '需求不存在' }); continue }
      if (['需求调研中', '已丢弃'].includes(r.status)) { failed.push({ id, code: r.code, reason: '状态不可排期' }); continue }
      const add = parseJson(r.priority_json, {})?.estimateDays || 0
      if (it.capacity_days > 0 && used + add > it.capacity_days) {
        failed.push({ id, code: r.code, reason: `容量不足（剩余 ${Math.round((it.capacity_days - used) * 10) / 10} 人日）` }); continue
      }
      run('UPDATE requirements SET iteration_id = ?, updated_at = ? WHERE id = ?', it.id, now(), r.id)
      used += add
      success.push(r.code || r.title)
    }
    logEvent({ projectId: project.id, type: 'schedule-batch', message: `批量排期 ${success.length} 条，失败 ${failed.length} 条`, payload: { iterationId: it.id, success, failed }, actorId: hr.user.id })
    res.json({ success, failed, usedDays: Math.round(used * 10) / 10 })
  } catch (e) { next(e) }
})

planningRouter.post('/projects/:projectId/dependencies', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'planning.schedule')
    const { fromReq, toReq } = hr.body || {}
    requireFields(hr.body || {}, ['fromReq', 'toReq'], '依赖')
    if (fromReq === toReq) { const e = new Error('需求不能依赖自身'); e.statusCode = 400; throw e }
    const edges = all('SELECT * FROM dependencies WHERE project_id = ?', project.id)
    const adj = new Map()
    for (const e of edges) {
      if (!adj.has(e.from_req)) adj.set(e.from_req, [])
      adj.get(e.from_req).push(e.to_req)
    }
    if (!adj.has(fromReq)) adj.set(fromReq, [])
    adj.get(fromReq).push(toReq)
    const stack = [toReq], seen = new Set()
    while (stack.length) {
      const cur = stack.pop()
      if (cur === fromReq) { const e = new Error('依赖关系形成环路，已拒绝保存'); e.statusCode = 400; throw e }
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const nxt of adj.get(cur) || []) stack.push(nxt)
    }
    const id = uid('DEP-')
    run('INSERT INTO dependencies (id, project_id, from_req, to_req, created_at) VALUES (?,?,?,?,?)', id, project.id, fromReq, toReq, now())
    logEvent({ projectId: project.id, type: 'dependency', message: '新增需求依赖', payload: { fromReq, toReq }, actorId: hr.user.id })
    res.status(201).json({ id })
  } catch (e) { next(e) }
})

planningRouter.delete('/projects/:projectId/dependencies/:id', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'planning.schedule')
    run('DELETE FROM dependencies WHERE id = ? AND project_id = ?', hr.params.id, project.id)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

planningRouter.post('/iterations/:id/release', (hr, res, next) => {
  try {
    const it = get('SELECT * FROM iterations WHERE id = ?', hr.params.id)
    if (!it) { const e = new Error('迭代不存在'); e.statusCode = 404; throw e }
    const { role } = projectFor(hr.user, it.project_id)
    requireAction(role, 'planning.schedule')
    if (it.status === 'released') { const e = new Error('迭代已发布'); e.statusCode = 400; throw e }
    const rows = all('SELECT * FROM requirements WHERE iteration_id = ?', it.id)
    const allowed = ['待上线发版', '全国推广中', '已关闭', '已丢弃']
    const bad = rows.filter(r => !allowed.includes(r.status))
    if (bad.length) {
      const e = new Error(`迭代内仍有 ${bad.length} 条需求未到待上线发版：${bad.map(b => `${b.code || b.title}（${b.status}）`).join('、')}`)
      e.statusCode = 400
      e.details = { blocked: bad.map(b => ({ id: b.id, code: b.code, title: b.title, status: b.status })) }
      throw e
    }
    const batchId = uid('BAT-')
    const promoted = []
    const failed = []
    tx(() => {
      for (const req of rows.filter(r => r.status === '待上线发版')) {
        const result = transitionRequirement({
          req, to: '全国推广中', note: `迭代「${it.name}」发布`,
          actorId: hr.user.id, batchId
        })
        if (!result.ok) {
          failed.push({ id: req.id, code: req.code, title: req.title, reason: result.reason })
          throw Object.assign(new Error(`需求「${req.code || req.title}」发布推进失败：${result.reason}`), { statusCode: 400 })
        }
        promoted.push({ id: req.id, code: req.code, title: req.title, from: result.from, to: result.to })
        run(`INSERT INTO audits (id, project_id, user_id, action, object_type, object_id, before_json, after_json, ip, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          uid('AUD-'), it.project_id, hr.user.id, 'requirement.release', 'requirement', req.id,
          JSON.stringify({ status: result.from }), JSON.stringify({ status: result.to, batchId }), hr.ip || '', now())
      }
      run("UPDATE iterations SET status = 'released' WHERE id = ?", it.id)
      run(`INSERT INTO batch_operations (id, project_id, iteration_id, target_status, effective_at, scope_json, success_json, failed_json, created_by, created_at, kind, changes_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        batchId, it.project_id, it.id, '全国推广中', now(),
        JSON.stringify({ count: promoted.length, source: 'iteration-release' }),
        JSON.stringify(promoted), JSON.stringify(failed),
        hr.user.id, now(), 'status', JSON.stringify({ promoted: promoted.length }))
    })
    logEvent({
      projectId: it.project_id, type: 'iteration-release',
      message: `发布迭代「${it.name}」，${promoted.length} 条需求进入全国推广中`,
      payload: { iterationId: it.id, batchId, promoted }, actorId: hr.user.id
    })
    recordAudit(hr, 'iteration.release', 'iteration', it.id, { status: it.status }, { status: 'released', batchId, promoted: promoted.length })
    res.json({ ok: true, batchId, promoted })
  } catch (e) { next(e) }
})
