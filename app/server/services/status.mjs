import { get, run, now, parseJson, logEvent } from '../db.mjs'
import { canTransition, STATUS_INDEX, TRANSITIONS } from '../core.mjs'
import { autoBackfill, applyRollback, normalizeMilestones, milestoneOrderIssues } from './milestones.mjs'

export const RESERVED_TARGETS = ['待需求分析', '已丢弃', '需求调研中', '恢复']

export const TERMINAL_STATES = ['已关闭', '已丢弃']

const LEAD_GATES = {
  '开发中': { key: 'tech', label: '技术负责人' },
  '待测试验证': { key: 'test', label: '测试负责人' },
  '待试点': { key: 'implementation', label: '实施负责人' }
}

export function validateEffectiveAt(effectiveAt, req, nowMs = Date.now()) {
  if (!effectiveAt) return { effectiveAt: new Date(nowMs).toISOString(), backfilled: false }
  const parsed = Date.parse(effectiveAt)
  if (Number.isNaN(parsed)) return { error: '生效时间格式无效' }
  if (parsed > nowMs + 1000) return { error: '生效时间不能晚于当前时间' }
  const entered = Date.parse(req.stall_since || req.updated_at || req.created_at)
  if (entered && parsed < entered - 1000) {
    return { error: `生效时间不能早于进入「${req.status}」的时间` }
  }
  return { effectiveAt: new Date(parsed).toISOString(), backfilled: true }
}

function leadOf(req, key) {
  const leads = parseJson(req.leads_json, {}) || {}
  return String(leads[key] || '').trim()
}

export function gateIssues(req, to) {
  const issues = []
  if (to === '需求评审中') {
    const p = get("SELECT * FROM prototypes WHERE requirement_id = ? AND status = 'confirmed' ORDER BY version DESC LIMIT 1", req.id)
    const s = get("SELECT * FROM specs WHERE requirement_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1", req.id)
    if (!p) issues.push('原型未确认，无法进入需求评审')
    if (!s) issues.push('说明书未发布，无法进入需求评审')
  }
  if (to === '待开发') {
    const open = get("SELECT COUNT(*) AS c FROM suggestions WHERE requirement_id = ? AND status IN ('待处理','处理中','不采纳待确认')", req.id)
    const passed = get("SELECT * FROM reviews WHERE requirement_id = ? AND conclusion = '通过' ORDER BY round DESC LIMIT 1", req.id)
    if (open.c > 0) issues.push(`仍有 ${open.c} 条建议未闭环，不能进入待开发`)
    if (!passed) issues.push('评审尚未通过，不能进入待开发')
  }
  const leadGate = LEAD_GATES[to]
  if (leadGate && !leadOf(req, leadGate.key)) {
    issues.push(`缺少${leadGate.label}，不能进入「${to}」`)
  }
  return issues
}

export function nextStatuses(status, suspendedFrom = '') {
  if (status === '挂起') return suspendedFrom ? [suspendedFrom] : []
  return Object.keys(TRANSITIONS[status] || {}).filter(s => s !== '*')
}

export function transitionRequirement({
  req, to, note = '', effectiveAt = null, actorId = null, batchId = null,
  allowResume = true
}) {
  if (!to) return { ok: false, reason: '缺少目标状态' }
  if (RESERVED_TARGETS.includes(to) && to !== '恢复') {
    return { ok: false, reason: '该状态只能通过确认、丢弃或登记动作产生' }
  }
  if (TERMINAL_STATES.includes(req.status)) {
    return { ok: false, reason: `需求已处于「${req.status}」，仅允许追加说明` }
  }
  const at = validateEffectiveAt(effectiveAt, req)
  if (at.error) return { ok: false, reason: at.error }
  const before = { status: req.status, milestones: normalizeMilestones(req.milestones_json) }

  if (to === '挂起') {
    if (!note) return { ok: false, reason: '挂起需填写原因' }
    run('UPDATE requirements SET suspended_from = ?, status = ?, updated_at = ? WHERE id = ?', req.status, '挂起', now(), req.id)
    logEvent({
      projectId: req.project_id, requirementId: req.id, type: 'status',
      message: `挂起：${note}`, payload: { from: req.status, to: '挂起', note, effectiveAt: at.effectiveAt, writtenAt: now(), backfilled: at.backfilled },
      actorId, effectiveAt: at.effectiveAt, batchId
    })
    return { ok: true, from: req.status, to: '挂起', effectiveAt: at.effectiveAt, backfilled: at.backfilled }
  }

  if (req.status === '挂起') {
    if (!allowResume) return { ok: false, reason: '挂起需求需先恢复' }
    const target = to === '恢复' ? req.suspended_from : to
    if (!target) return { ok: false, reason: '缺少恢复目标状态' }
    if (TERMINAL_STATES.includes(target)) return { ok: false, reason: `不能恢复为「${target}」` }
    run('UPDATE requirements SET status = ?, suspended_from = NULL, updated_at = ?, stall_since = ? WHERE id = ?', target, now(), now(), req.id)
    logEvent({
      projectId: req.project_id, requirementId: req.id, type: 'status',
      message: `恢复为 ${target}`, payload: { from: '挂起', to: target, effectiveAt: at.effectiveAt, writtenAt: now(), backfilled: at.backfilled },
      actorId, effectiveAt: at.effectiveAt, batchId
    })
    return { ok: true, from: '挂起', to: target, effectiveAt: at.effectiveAt, backfilled: at.backfilled }
  }

  if (!canTransition(req.status, to)) {
    return { ok: false, reason: `非法状态流转：${req.status} → ${to}`, from: req.status, to }
  }
  const issues = gateIssues(req, to)
  if (issues.length) return { ok: false, reason: issues.join('；'), issues, from: req.status, to }

  const fromIndex = STATUS_INDEX[req.status]
  const toIndex = STATUS_INDEX[to]
  let milestones = normalizeMilestones(req.milestones_json)
  const rolledBack = { cleared: [], flagged: [] }
  if (fromIndex !== undefined && toIndex !== undefined && toIndex < fromIndex) {
    const result = applyRollback(milestones, toIndex, to)
    milestones = result.milestones
    rolledBack.cleared = result.cleared
    rolledBack.flagged = result.flagged
  }
  const filled = autoBackfill(milestones, { to, effectiveAt: at.effectiveAt })
  milestones = filled.milestones

  run('UPDATE requirements SET status = ?, milestones_json = ?, stall_since = ?, updated_at = ? WHERE id = ?',
    to, JSON.stringify(milestones), now(), now(), req.id)
  logEvent({
    projectId: req.project_id, requirementId: req.id, type: 'status',
    message: `${req.status} → ${to}${note ? '：' + note : ''}`,
    payload: {
      from: req.status, to, note, effectiveAt: at.effectiveAt, writtenAt: now(),
      backfilled: at.backfilled,
      milestones: {
        applied: filled.applied, kept: filled.kept,
        cleared: rolledBack.cleared, flagged: rolledBack.flagged
      }
    },
    actorId, effectiveAt: at.effectiveAt, batchId
  })
  return {
    ok: true, from: req.status, to, effectiveAt: at.effectiveAt, backfilled: at.backfilled,
    before, after: { status: to, milestones },
    milestones: { applied: filled.applied, kept: filled.kept, cleared: rolledBack.cleared, flagged: rolledBack.flagged }
  }
}

export function statusActionOf(role) {
  return role === 'developer' ? 'status.submit_acceptance' : 'status.advance'
}

export const DEVELOPER_TARGETS = ['待测试验证', '测试验证中', '开发中', '待UAT']

export function canRoleTransition(role, to) {
  if (role === 'admin') return true
  if (role === 'developer') return DEVELOPER_TARGETS.includes(to)
  return role === 'pm'
}

export function parseJsonSafe(value, fallback) {
  return parseJson(value, fallback)
}

export { milestoneOrderIssues }
