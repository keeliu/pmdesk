import { all, get, run, now, uid, parseJson, tx, audit, logEvent } from '../db.mjs'
import { canTransition } from '../core.mjs'
import { transitionRequirement, gateIssues, validateEffectiveAt, RESERVED_TARGETS, TERMINAL_STATES } from './status.mjs'
import { applyMilestones, normalizeMilestones } from './milestones.mjs'

export function resolveBatchTargets(projectId, { requirementIds, iterationId, filter = {} } = {}) {
  if (Array.isArray(requirementIds) && requirementIds.length) {
    return requirementIds.map(id => get('SELECT * FROM requirements WHERE id = ? AND project_id = ?', id, projectId)).filter(Boolean)
  }
  if (iterationId) {
    let sql = "SELECT * FROM requirements WHERE iteration_id = ? AND project_id = ? AND status NOT IN ('需求调研中','已丢弃')"
    const params = [iterationId, projectId]
    if (filter.status) { sql += ' AND status = ?'; params.push(filter.status) }
    if (filter.owner) { sql += ' AND owner_id = ?'; params.push(filter.owner) }
    if (filter.q) { sql += ' AND (title LIKE ? OR code LIKE ?)'; params.push(`%${filter.q}%`, `%${filter.q}%`) }
    return all(sql + ' ORDER BY created_at', ...params)
  }
  let sql = "SELECT * FROM requirements WHERE project_id = ? AND status NOT IN ('需求调研中','已丢弃')"
  const params = [projectId]
  if (filter.status) { sql += ' AND status = ?'; params.push(filter.status) }
  if (filter.owner) { sql += ' AND owner_id = ?'; params.push(filter.owner) }
  if (filter.q) { sql += ' AND (title LIKE ? OR code LIKE ?)'; params.push(`%${filter.q}%`, `%${filter.q}%`) }
  sql += ' ORDER BY created_at'
  return all(sql, ...params)
}

export function previewBatch(targets, to, effectiveAt) {
  return targets.map(req => {
    const issues = gateIssues(req, to)
    const iteration = req.iteration_id ? get('SELECT * FROM iterations WHERE id = ?', req.iteration_id) : null
    if (iteration?.status === 'released') issues.push(`处于已发布迭代「${iteration.name}」，不可变更状态`)
    const timeCheck = validateEffectiveAt(effectiveAt, req)
    if (timeCheck.error) issues.push(timeCheck.error)
    return {
      id: req.id, code: req.code, title: req.title, from: req.status, to,
      ok: issues.length === 0, issues
    }
  })
}

export function applyBatchStatus({
  project, user, targets, to, effectiveAt = null, note = '', batchId = null, source = 'direct'
}) {
  const id = batchId || uid('BAT-')
  const at = effectiveAt ? validateEffectiveAt(effectiveAt, { status: '批量', created_at: now() }) : { effectiveAt: null }
  if (at.error) return { ok: false, reason: at.error }
  const success = []
  const failed = []
  for (const req of targets) {
    const iteration = req.iteration_id ? get('SELECT * FROM iterations WHERE id = ?', req.iteration_id) : null
    if (iteration?.status === 'released') {
      failed.push({ id: req.id, code: req.code, title: req.title, reason: `处于已发布迭代「${iteration.name}」，不可变更状态` })
      continue
    }
    let result
    try {
      result = tx(() => transitionRequirement({
        req, to, note, effectiveAt, actorId: user.id, batchId: id
      }))
    } catch (err) {
      failed.push({ id: req.id, code: req.code, title: req.title, reason: err.message })
      continue
    }
    if (!result.ok) {
      failed.push({ id: req.id, code: req.code, title: req.title, reason: result.reason })
      continue
    }
    success.push({
      id: req.id, code: req.code, title: req.title, from: result.from, to: result.to,
      effectiveAt: result.effectiveAt, backfilled: result.backfilled, milestones: result.milestones
    })
    audit({
      projectId: project.id, userId: user.id, action: 'requirement.batch-status',
      objectType: 'requirement', objectId: req.id,
      before: { status: result.from }, after: { status: result.to, batchId: id, effectiveAt: result.effectiveAt }
    })
  }
  const record = {
    id, project_id: project.id, iteration_id: targets[0]?.iteration_id || null,
    target_status: to, effective_at: at.effectiveAt || now(),
    scope_json: JSON.stringify({ count: targets.length, source }),
    success_json: JSON.stringify(success), failed_json: JSON.stringify(failed),
    created_by: user.id, created_at: now()
  }
  run(`INSERT INTO batch_operations (id, project_id, iteration_id, target_status, effective_at, scope_json, success_json, failed_json, created_by, created_at, kind, changes_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    record.id, record.project_id, record.iteration_id, record.target_status, record.effective_at,
    record.scope_json, record.success_json, record.failed_json, record.created_by, record.created_at,
    'status', JSON.stringify({ kind: 'status', to, effectiveAt: at.effectiveAt }))
  logEvent({
    projectId: project.id, type: 'status-batch',
    message: `批量更新为「${to}」：成功 ${success.length} 条，失败 ${failed.length} 条`,
    payload: { batchId: id, target: to, effectiveAt: at.effectiveAt, success: success.length, failed: failed.length, source },
    actorId: user.id
  })
  return { ok: true, batchId: id, target: to, effectiveAt: at.effectiveAt, success, failed, total: targets.length }
}

const LEAD_PATCH_KEYS = ['tech', 'test', 'implementation']

function releasedIterationIssue(req) {
  if (!req.iteration_id) return ''
  const iteration = get('SELECT name, status FROM iterations WHERE id = ?', req.iteration_id)
  return iteration?.status === 'released' ? `处于已发布迭代「${iteration.name}」，不可变更状态` : ''
}

function prepareProgress(req, payload) {
  const issues = []
  const released = releasedIterationIssue(req)
  if (released) issues.push(released)
  let milestones = normalizeMilestones(req.milestones_json)
  if (payload.milestones) {
    const result = applyMilestones(milestones, payload.milestones, { by: payload.by || '' })
    if (!result.ok) issues.push(...result.issues.map(i => i.message))
    else milestones = result.milestones
  }
  const leads = { ...(parseJson(req.leads_json, {}) || {}) }
  const patch = payload.leads || {}
  if (patch.productManager !== undefined) {
    const result = applyMilestones(milestones, { productManager: patch.productManager }, { by: payload.by || '' })
    if (!result.ok) issues.push(...result.issues.map(i => i.message))
    else milestones = result.milestones
  }
  for (const key of LEAD_PATCH_KEYS) {
    if (patch[key] !== undefined) leads[key] = patch[key]
  }
  const working = { ...req, milestones_json: JSON.stringify(milestones), leads_json: JSON.stringify(leads) }
  if (payload.to) {
    const at = validateEffectiveAt(payload.effectiveAt, req)
    if (at.error) issues.push(at.error)
    issues.push(...gateIssues(working, payload.to))
  }
  return { ok: issues.length === 0, issues, milestones, leads, working }
}

export function previewBatchProgress(targets, payload = {}) {
  return targets.map(req => {
    const prepared = prepareProgress(req, payload)
    const problems = [...prepared.issues]
    if (payload.to && prepared.ok && req.status !== '挂起') {
      if (TERMINAL_STATES.includes(req.status)) problems.push(`需求已处于「${req.status}」，仅允许追加说明`)
      else if (RESERVED_TARGETS.includes(payload.to) && payload.to !== '恢复') problems.push('该状态只能通过确认、丢弃或登记动作产生')
      else if (!canTransition(req.status, payload.to)) problems.push(`非法状态流转：${req.status} → ${payload.to}`)
    }
    return {
      id: req.id, code: req.code, title: req.title, from: req.status,
      to: payload.to || req.status, ok: problems.length === 0, issues: problems
    }
  })
}

export function applyBatchProgress({ project, user, targets, payload = {}, source = 'direct' }) {
  const id = uid('BAT-')
  const to = payload.to || null
  const at = to ? validateEffectiveAt(payload.effectiveAt, { status: '批量', created_at: now() }) : { effectiveAt: null }
  if (at.error) return { ok: false, reason: at.error }
  const success = []
  const failed = []
  for (const req of targets) {
    const prepared = prepareProgress(req, { ...payload, effectiveAt: at.effectiveAt, by: user.name })
    if (!prepared.ok) {
      failed.push({ id: req.id, code: req.code, title: req.title, reason: prepared.issues.join('；') })
      continue
    }
    let result = null
    try {
      tx(() => {
        run('UPDATE requirements SET milestones_json = ?, leads_json = ?, updated_at = ? WHERE id = ?',
          JSON.stringify(prepared.milestones), JSON.stringify(prepared.leads), now(), req.id)
        if (to) {
          result = transitionRequirement({
            req: prepared.working, to, note: payload.note || '', effectiveAt: at.effectiveAt,
            actorId: user.id, batchId: id
          })
          if (!result.ok) {
            const e = new Error(result.reason)
            e.statusCode = 400
            throw e
          }
        }
        audit({
          projectId: project.id, userId: user.id, action: 'requirement.batch-progress',
          objectType: 'requirement', objectId: req.id,
          before: { status: req.status, milestones: normalizeMilestones(req.milestones_json), leads: parseJson(req.leads_json, {}) },
          after: { status: to || req.status, milestones: prepared.milestones, leads: prepared.leads, batchId: id }
        })
      })
    } catch (err) {
      failed.push({ id: req.id, code: req.code, title: req.title, reason: err.message })
      continue
    }
    success.push({
      id: req.id, code: req.code, title: req.title,
      from: result?.from || req.status, to: result?.to || req.status,
      effectiveAt: result?.effectiveAt || at.effectiveAt,
      backfilled: Boolean(result?.backfilled),
      milestones: result?.milestones || { applied: [], kept: [], cleared: [], flagged: [] }
    })
  }
  const changes = {
    kind: 'progress', to, effectiveAt: at.effectiveAt,
    milestones: payload.milestones || null, leads: payload.leads || null
  }
  run(`INSERT INTO batch_operations (id, project_id, iteration_id, target_status, effective_at, scope_json, success_json, failed_json, created_by, created_at, kind, changes_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, project.id, targets[0]?.iteration_id || null, to || '进展维护', at.effectiveAt || now(),
    JSON.stringify({ count: targets.length, source }),
    JSON.stringify(success), JSON.stringify(failed), user.id, now(),
    'progress', JSON.stringify(changes))
  logEvent({
    projectId: project.id, type: 'progress-batch',
    message: `批量维护进展${to ? `（目标「${to}」）` : ''}：成功 ${success.length} 条，失败 ${failed.length} 条`,
    payload: { batchId: id, ...changes, success: success.length, failed: failed.length, source },
    actorId: user.id
  })
  return { ok: true, batchId: id, target: to, effectiveAt: at.effectiveAt, success, failed, total: targets.length }
}

export function batchHistory(projectId, limit = 20) {
  return all('SELECT * FROM batch_operations WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', projectId, limit)
    .map(b => ({
      ...b,
      scope: parseJson(b.scope_json, {}),
      success: parseJson(b.success_json, []),
      failed: parseJson(b.failed_json, [])
    }))
}
