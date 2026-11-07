import { get, run, now, parseJson, tx, nextCounter, logEvent } from '../db.mjs'
import { buildPriority } from './priority.mjs'
import { applyMilestones, normalizeMilestones } from './milestones.mjs'
import { requesterSnapshot } from './requester.mjs'

export function confirmRequirement({ req, project, user, body = {}, requester, apps, clar, scopeAll }) {
  const source = parseJson(req.source_json, {})
  const hay = [
    req.title, source.fullText || '', source.excerpt || '',
    ...Object.values(clar?.answers || {}).map(a => a.value || '')
  ].join('\n')
  const priorityInput = body.priority || {}
  const priority = buildPriority({
    req: { ...req, requester_json: JSON.stringify(requester) },
    project, text: hay,
    input: { estimateDays: priorityInput.estimateDays ?? body.estimateDays, ...priorityInput },
    actor: user.name
  })
  if (priority.manual && !String(priority.reason || '').trim()) {
    const e = new Error('人工调整优先级必须填写理由'); e.statusCode = 400; throw e
  }
  const msResult = applyMilestones({}, {
    productManager: body.productManager || user.name,
    plan: body.plan || {}
  }, { by: user.name })
  if (!msResult.ok) {
    const e = new Error(`里程碑时间顺序冲突：${msResult.issues.map(i => i.message).join('；')}`); e.statusCode = 400; throw e
  }
  const snapshot = {
    title: req.title, clarification: clar?.answers || {}, involvedApps: apps,
    requester: requesterSnapshot(requester),
    priority: {
      model: priority.model, grade: priority.grade, gradeLabel: priority.gradeLabel,
      score: priority.score, suggestedGrade: priority.suggestedGrade,
      manual: priority.manual, reason: priority.reason, dimensions: priority.dimensions
    },
    milestones: msResult.milestones,
    sourceExcerpt: source.excerpt || '',
    projectRange: scopeAll, confirmedAt: now(), confirmedBy: user.name
  }
  const result = tx(() => {
    const seq = nextCounter(`req:${project.id}`)
    const code = `REQ-${project.code}-${String(seq).padStart(4, '0')}`
    run(`UPDATE requirements SET code = ?, status = '待需求分析', snapshot_json = ?, requester_json = ?, priority_json = ?,
         milestones_json = ?, confirmed_at = ?, confirmed_by = ?,
         owner_id = ?, updated_at = ?, stall_since = ? WHERE id = ?`,
      code, JSON.stringify(snapshot), JSON.stringify(requester), JSON.stringify(priority),
      JSON.stringify(msResult.milestones), now(), user.id,
      body.ownerId || req.owner_id || user.id, now(), now(), req.id)
    logEvent({
      projectId: project.id, requirementId: req.id, type: 'confirm',
      message: `确认需求并分配编号 ${code}`,
      payload: { code, grade: priority.grade, score: priority.score }, actorId: user.id
    })
    return { code, seq }
  })
  return { ...result, priority, milestones: msResult.milestones, snapshot, fresh: get('SELECT * FROM requirements WHERE id = ?', req.id) }
}

export function milestoneBackfillForReview(req, round, userName) {
  const milestones = normalizeMilestones(req.milestones_json)
  const before = milestones.reviewedAt || ''
  milestones.reviewedAt = now()
  milestones.history = [...(milestones.history || []), { field: 'reviewedAt', from: before, to: milestones.reviewedAt, by: userName, at: now(), source: `第 ${round} 轮评审通过` }]
  return milestones
}
