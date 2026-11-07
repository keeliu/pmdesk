import { parseJson } from '../db.mjs'

export const MILESTONE_FIELDS = [
  { key: 'reviewedAt', label: '评审完成时间', short: '评审完成', order: 1 },
  { key: 'submittedAt', label: '开发完成时间', short: '开发完成', order: 2 },
  { key: 'testedAt', label: '完成测试验证时间', short: '测试完成', order: 3 },
  { key: 'uatAt', label: '完成 UAT 时间', short: 'UAT 完成', order: 4 },
  { key: 'pilotAt', label: '完成试点时间', short: '试点完成', order: 5 },
  { key: 'releasedAt', label: '上线推广时间', short: '上线推广', order: 6 }
]

export const MILESTONE_LABEL = Object.fromEntries(MILESTONE_FIELDS.map(f => [f.key, f.label]))
MILESTONE_LABEL.productManager = '产品经理'

export const MILESTONE_KEYS = MILESTONE_FIELDS.map(f => f.key)

// 完成节点对应的阶段序号：评审完成 4-待开发、开发完成 6-待测试验证、测试完成 8-待UAT、
// UAT 完成 10-待试点、试点完成 12-待上线发版、上线推广 13-全国推广中。
export const MILESTONE_STAGE_THRESHOLD = {
  reviewedAt: 4,
  submittedAt: 6,
  testedAt: 8,
  uatAt: 10,
  pilotAt: 12,
  releasedAt: 13
}

export const BACKFILL_RULES = {
  '待开发': { from: '需求评审中', field: 'reviewedAt' },
  '待测试验证': { from: '开发中', field: 'submittedAt' },
  '待UAT': { from: '测试验证中', field: 'testedAt' },
  '待试点': { from: 'UAT中', field: 'uatAt' },
  '待上线发版': { from: '试点中', field: 'pilotAt' },
  '全国推广中': { from: '待上线发版', field: 'releasedAt' }
}

export function emptyMilestones() {
  return {
    productManager: '',
    reviewedAt: '', submittedAt: '', testedAt: '', uatAt: '', pilotAt: '', releasedAt: '',
    plan: {}, history: [], auto: {}, needsReview: {}
  }
}

export function normalizeMilestones(json) {
  const raw = typeof json === 'string' ? parseJson(json, {}) : (json || {})
  const base = emptyMilestones()
  return {
    ...base,
    ...raw,
    plan: { ...base.plan, ...(raw.plan || {}) },
    auto: { ...(raw.auto || {}) },
    needsReview: { ...(raw.needsReview || {}) },
    history: Array.isArray(raw.history) ? raw.history : []
  }
}

export function milestoneOrderIssues(ms) {
  const issues = []
  const filled = MILESTONE_FIELDS.filter(f => ms[f.key])
  for (let i = 1; i < filled.length; i++) {
    const prev = filled[i - 1]
    const cur = filled[i]
    if (Date.parse(ms[cur.key]) < Date.parse(ms[prev.key])) {
      issues.push({ fields: [prev.key, cur.key], message: `${cur.short}不能早于${prev.short}` })
    }
  }
  const planFilled = MILESTONE_FIELDS.filter(f => ms.plan?.[f.key])
  for (let i = 1; i < planFilled.length; i++) {
    const prev = planFilled[i - 1]
    const cur = planFilled[i]
    if (Date.parse(ms.plan[cur.key]) < Date.parse(ms.plan[prev.key])) {
      issues.push({ fields: [`plan.${prev.key}`, `plan.${cur.key}`], message: `计划${cur.short}不能早于计划${prev.short}` })
    }
  }
  return issues
}

export function milestoneGate() {
  return []
}

function pushHistory(ms, entry) {
  ms.history = [...(ms.history || []), { at: new Date().toISOString(), ...entry }]
}

export function autoBackfill(ms, { to, effectiveAt }) {
  const next = normalizeMilestones(ms)
  const rule = BACKFILL_RULES[to]
  const applied = []
  const kept = []
  if (!rule) return { milestones: next, applied, kept }
  if (next[rule.field]) {
    kept.push(rule.field)
  } else {
    next[rule.field] = effectiveAt
    next.auto = { ...next.auto, [rule.field]: true }
    delete next.needsReview[rule.field]
    applied.push(rule.field)
    pushHistory(next, { field: rule.field, from: '', to: effectiveAt, by: 'system', source: `${rule.from} → ${to}`, action: 'backfill' })
  }
  return { milestones: next, applied, kept }
}

export function applyRollback(ms, targetIndex, targetStatus = '') {
  const next = normalizeMilestones(ms)
  const target = targetIndex
  const cleared = []
  const flagged = []
  if (target === undefined || target === null) return { milestones: next, cleared, flagged }
  for (const field of MILESTONE_FIELDS) {
    const threshold = MILESTONE_STAGE_THRESHOLD[field.key]
    if (threshold === undefined) continue
    if (!next[field.key]) {
      delete next.needsReview[field.key]
      continue
    }
    if (target < threshold) {
      if (next.auto[field.key]) {
        const from = next[field.key]
        next[field.key] = ''
        next.auto = { ...next.auto }
        delete next.auto[field.key]
        cleared.push(field.key)
        pushHistory(next, { field: field.key, from, to: '', by: 'system', reason: `回退至${targetStatus}，清除自动回填`, action: 'clear' })
      } else {
        next.needsReview = { ...next.needsReview, [field.key]: true }
        flagged.push(field.key)
        pushHistory(next, { field: field.key, from: next[field.key], to: next[field.key], by: 'system', reason: `回退至${targetStatus}，人工登记日期待复核`, action: 'review' })
      }
    } else if (next.needsReview[field.key]) {
      next.needsReview = { ...next.needsReview }
      delete next.needsReview[field.key]
    }
  }
  return { milestones: next, cleared, flagged }
}

export function applyMilestones(current, patch = {}, { by = '' } = {}) {
  const ms = normalizeMilestones(current)
  const before = { ...ms, plan: { ...ms.plan }, auto: { ...ms.auto }, needsReview: { ...ms.needsReview } }
  for (const field of MILESTONE_FIELDS) {
    if (patch[field.key] !== undefined) {
      ms[field.key] = patch[field.key] || ''
      ms.auto = { ...ms.auto, [field.key]: false }
      delete ms.needsReview[field.key]
    }
  }
  if (patch.productManager !== undefined) ms.productManager = patch.productManager || ''
  if (patch.plan && typeof patch.plan === 'object') {
    ms.plan = { ...ms.plan }
    for (const field of MILESTONE_FIELDS) {
      if (patch.plan[field.key] !== undefined) ms.plan[field.key] = patch.plan[field.key] || ''
    }
  }
  const issues = milestoneOrderIssues(ms)
  if (issues.length) return { ok: false, issues, milestones: before }
  const history = []
  const nowIso = new Date().toISOString()
  for (const key of ['productManager', ...MILESTONE_KEYS]) {
    if (before[key] !== ms[key]) history.push({ field: key, from: before[key], to: ms[key], by, at: nowIso, action: 'edit' })
  }
  for (const field of MILESTONE_FIELDS) {
    const from = before.plan[field.key] || ''
    const to = ms.plan[field.key] || ''
    if (from !== to) history.push({ field: `plan.${field.key}`, from, to, by, at: nowIso, action: 'edit' })
  }
  ms.history = [...(before.history || []), ...history]
  return { ok: true, milestones: ms, changed: history }
}

export function milestoneOverdue(ms, nowMs = Date.now()) {
  const m = normalizeMilestones(ms)
  const out = []
  for (const field of MILESTONE_FIELDS) {
    const plan = m.plan?.[field.key]
    if (plan && !m[field.key] && Date.parse(plan) < nowMs) {
      out.push({ field: field.key, label: field.label, plan })
    }
  }
  return out
}

export function milestoneView(ms) {
  const m = normalizeMilestones(ms)
  const overdue = milestoneOverdue(m)
  return {
    ...m,
    fields: MILESTONE_FIELDS.map(f => ({
      ...f, plan: m.plan?.[f.key] || '', actual: m[f.key] || '',
      overdue: overdue.some(o => o.field === f.key),
      auto: Boolean(m.auto?.[f.key]),
      needsReview: Boolean(m.needsReview?.[f.key])
    })),
    overdue,
    orderIssues: milestoneOrderIssues(m)
  }
}
