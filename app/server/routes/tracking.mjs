import { Router } from 'express'
import { all, get, run, now, uid, parseJson, logEvent } from '../db.mjs'
import { projectFor, requireAction, requireFields, recordAudit, STATUS_FILTERS, statusLabel } from '../core.mjs'
import { resolveBatchTargets, applyBatchStatus, previewBatch, batchHistory, previewBatchProgress, applyBatchProgress } from '../services/batch.mjs'
import { DEVELOPER_TARGETS } from '../services/status.mjs'
import { normalizeLeads } from '../services/requirement-profile.mjs'
import { milestoneOverdue } from '../services/milestones.mjs'
import { LEVEL_LABEL } from '../services/priority.mjs'

export const trackingRouter = Router()

const UPDATE_VERB = /批量|全部|推进|更新|改为|设为|调整为|变更为|切换到|统一/
const QUERY_HINT = /哪些|多少|进展|统计|阻塞|风险|情况|列表|汇总|查询/

const STATUS_ALT = STATUS_FILTERS.join('|')

function targetStatusOf(text) {
  const explicit = text.match(new RegExp(`(?:改为|改成|设为|设置为|调整为|变更为|切换到|推进到|更新为|统一为|变成|到)\\s*[「“"]?(${STATUS_ALT})`))
  if (explicit) return explicit[1]
  if (/全国推广|推广中/.test(text)) return '全国推广中'
  if (/待上线|发版/.test(text)) return '待上线发版'
  if (/试点中/.test(text)) return '试点中'
  if (/待试点/.test(text)) return '待试点'
  if (/UAT中|uat中/i.test(text)) return 'UAT中'
  if (/待UAT|待uat/i.test(text)) return '待UAT'
  if (/测试验证中/.test(text)) return '测试验证中'
  if (/待测试|提测/.test(text)) return '待测试验证'
  if (/待开发/.test(text)) return '待开发'
  if (/开发中|开发/.test(text)) return '开发中'
  if (/需求评审中|评审中|评审/.test(text)) return '需求评审中'
  if (/需求分析中|分析中|分析/.test(text)) return '需求分析中'
  if (/待需求分析/.test(text)) return '待需求分析'
  if (/调研/.test(text)) return '需求调研中'
  if (/关闭/.test(text)) return '已关闭'
  if (/挂起/.test(text)) return '挂起'
  return null
}

const STATUS_NAMES = STATUS_FILTERS.filter(s => !['已丢弃'].includes(s))

function scopeOfText(project, text, iterationId) {
  if (iterationId) {
    const it = get('SELECT * FROM iterations WHERE id = ? AND project_id = ?', iterationId, project.id)
    if (it) return { iterationId: it.id, iterationName: it.name }
  }
  const its = all('SELECT * FROM iterations WHERE project_id = ?', project.id)
  const hit = its.find(i => text.includes(i.name))
    || its.find(i => {
      const short = i.name.replace(/^\d{4}\s*/, '')
      return short && text.includes(short)
    })
    || its.find(i => {
      const tail = i.name.match(/迭代[一二三四五六七八九十\d]+/)?.[0]
      return tail && text.includes(tail)
    })
  if (hit) return { iterationId: hit.id, iterationName: hit.name }
  return { iterationId: null, iterationName: '' }
}

function sourceStatusOf(text, target) {
  const found = STATUS_NAMES.filter(s => s !== target && text.includes(s))
  return found.length === 1 ? found[0] : null
}

function effectiveAtOf(text) {
  const m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (!m) return null
  const iso = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}T09:00:00`
  const ts = Date.parse(iso)
  return Number.isNaN(ts) ? undefined : new Date(ts).toISOString()
}

function addProjectMessage(projectId, role, content, proposalId = null, userId = null) {
  run('INSERT INTO project_messages (id, project_id, role, content, proposal_id, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
    uid('PM-'), projectId, role, content, proposalId, userId, now())
}

function statsReply(project, { iterationId, iterationName }) {
  let reqs
  if (iterationId) reqs = all("SELECT * FROM requirements WHERE iteration_id = ? AND status NOT IN ('已丢弃','需求调研中')", iterationId)
  else reqs = all("SELECT * FROM requirements WHERE project_id = ? AND status NOT IN ('已丢弃','需求调研中')", project.id)
  const counts = {}
  for (const r of reqs) counts[r.status] = (counts[r.status] || 0) + 1
  const lines = STATUS_FILTERS.filter(s => counts[s]).map(s => `${statusLabel(s)} ${counts[s]} 条`)
  const overdue = reqs.flatMap(r => milestoneOverdue(r.milestones_json).map(o => ({ r, o })))
  const blocked = reqs.filter(r => ['挂起'].includes(r.status) || (r.stall_since && Date.now() - Date.parse(r.stall_since) > 7 * 86400000))
  const head = iterationName ? `迭代「${iterationName}」共 ${reqs.length} 条需求` : `当前项目共 ${reqs.length} 条需求`
  return [
    `${head}。${lines.join('；') || '暂无需求'}。`,
    overdue.length ? `里程碑逾期 ${overdue.length} 项：${overdue.slice(0, 5).map(x => `${x.r.code || x.r.title} ${x.o.label}`).join('、')}${overdue.length > 5 ? ' 等' : ''}。` : '暂无里程碑逾期。',
    blocked.length ? `存在 ${blocked.length} 条停滞或挂起需求：${blocked.slice(0, 5).map(r => r.code || r.title).join('、')}。` : '没有停滞或挂起需求。'
  ].join('\n')
}

trackingRouter.get('/projects/:projectId/tracking/batches', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    res.json(batchHistory(project.id))
  } catch (e) { next(e) }
})

trackingRouter.post('/projects/:projectId/requirements/batch-status', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'batch.status')
    const b = hr.body || {}
    requireFields(b, ['to'], '批量状态更新')
    const targets = resolveBatchTargets(project.id, {
      requirementIds: b.requirementIds, iterationId: b.iterationId, filter: b.filter
    })
    if (!targets.length) { const e = new Error('未匹配到可更新需求'); e.statusCode = 400; throw e }
    const result = applyBatchStatus({
      project, user: hr.user, targets, to: b.to,
      effectiveAt: b.effectiveAt || null, note: b.note || '', source: 'direct'
    })
    if (!result.ok) { const e = new Error(result.reason); e.statusCode = 400; throw e }
    recordAudit(hr, 'requirement.batch-status', 'project', project.id, null, {
      batchId: result.batchId, target: result.target, success: result.success.length, failed: result.failed.length
    })
    res.json(result)
  } catch (e) { next(e) }
})

function progressPayloadOf(body, role) {
  const payload = {
    to: body.to || null,
    note: String(body.note || ''),
    effectiveAt: body.effectiveAt || null,
    milestones: body.milestones && typeof body.milestones === 'object' ? body.milestones : null,
    leads: normalizeLeads(body.leads)
  }
  if (!payload.to && !payload.milestones && !payload.leads) {
    const e = new Error('请至少提交状态、里程碑或负责人中的一项'); e.statusCode = 400; throw e
  }
  if (payload.to && role === 'developer' && !DEVELOPER_TARGETS.includes(payload.to)) {
    const e = new Error(`开发角色仅可推进开发与测试相关状态（${DEVELOPER_TARGETS.join('、')}）`); e.statusCode = 403; throw e
  }
  return payload
}

trackingRouter.post('/projects/:projectId/requirements/batch-progress/preview', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'batch.status')
    const payload = progressPayloadOf(hr.body || {}, role)
    const targets = resolveBatchTargets(project.id, {
      requirementIds: hr.body?.requirementIds, iterationId: hr.body?.iterationId, filter: hr.body?.filter
    })
    if (!targets.length) { const e = new Error('未匹配到可维护的需求'); e.statusCode = 400; throw e }
    const preview = previewBatchProgress(targets, payload)
    res.json({
      total: targets.length,
      ok: preview.filter(p => p.ok).length,
      failed: preview.filter(p => !p.ok).length,
      items: preview
    })
  } catch (e) { next(e) }
})

trackingRouter.post('/projects/:projectId/requirements/batch-progress', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'batch.status')
    const payload = progressPayloadOf(hr.body || {}, role)
    const targets = resolveBatchTargets(project.id, {
      requirementIds: hr.body?.requirementIds, iterationId: hr.body?.iterationId, filter: hr.body?.filter
    })
    if (!targets.length) { const e = new Error('未匹配到可维护的需求'); e.statusCode = 400; throw e }
    const result = applyBatchProgress({ project, user: hr.user, targets, payload, source: 'direct' })
    if (!result.ok) { const e = new Error(result.reason); e.statusCode = 400; throw e }
    recordAudit(hr, 'requirement.batch-progress', 'project', project.id, null, {
      batchId: result.batchId, target: result.target, success: result.success.length, failed: result.failed.length
    })
    res.json(result)
  } catch (e) { next(e) }
})

trackingRouter.get('/projects/:projectId/tracking-chat', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    const messages = all(`SELECT m.*, u.name AS created_by_name FROM project_messages m
      LEFT JOIN users u ON u.id = m.created_by WHERE m.project_id = ? ORDER BY m.created_at`, project.id)
    const proposals = all('SELECT * FROM project_proposals WHERE project_id = ? ORDER BY created_at DESC LIMIT 20', project.id)
      .map(p => ({ ...p, payload: parseJson(p.payload_json, {}), diff: parseJson(p.diff_json, []) }))
    res.json({ messages, proposals })
  } catch (e) { next(e) }
})

trackingRouter.post('/projects/:projectId/tracking-chat', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'chat')
    const text = String(hr.body?.message || '').trim()
    if (!text) { const e = new Error('请输入要查询或更新的内容'); e.statusCode = 400; throw e }
    addProjectMessage(project.id, 'user', text, null, hr.user.id)
    const scope = scopeOfText(project, text, hr.body?.iterationId)
    const to = targetStatusOf(text)
    const wantsUpdate = UPDATE_VERB.test(text) || (to && !QUERY_HINT.test(text))
    let reply = ''
    let proposal = null

    if (to && wantsUpdate) {
      const from = sourceStatusOf(text, to)
      const targets = resolveBatchTargets(project.id, { iterationId: scope.iterationId, filter: from ? { status: from } : {} })
      if (!targets.length) {
        reply = `没有匹配到可更新的需求，请确认迭代或筛选范围${from ? `（当前状态「${from}」）` : ''}。`
      } else {
        const effectiveAt = effectiveAtOf(text)
        if (effectiveAt === undefined) {
          reply = '生效时间格式无法识别，请使用 YYYY-MM-DD。'
        } else {
          const preview = previewBatch(targets, to, effectiveAt)
          const okCount = preview.filter(p => p.ok).length
          const id = uid('PP-')
          const payload = {
            to, from, iterationId: scope.iterationId, iterationName: scope.iterationName,
            requirementIds: targets.map(r => r.id), effectiveAt, note: text
          }
          run(`INSERT INTO project_proposals (id, project_id, action, payload_json, diff_json, status, created_by, created_at)
               VALUES (?,?,?,?,?,?,?,?)`,
            id, project.id, 'batch_status', JSON.stringify(payload), JSON.stringify(preview), 'pending', hr.user.id, now())
          proposal = { id, action: 'batch_status', payload, diff: preview, status: 'pending' }
          reply = `已生成批量更新提案：${scope.iterationName ? `迭代「${scope.iterationName}」` : '全部需求'}${from ? `中当前状态为「${from}」的` : '中'} ${okCount} 条可更新为「${to}」，${preview.length - okCount} 条存在门禁或时间问题。请确认后执行。`
          logEvent({ projectId: project.id, type: 'tracking-proposal', message: reply, payload: { proposalId: id, to, okCount, total: preview.length }, actorId: hr.user.id })
        }
      }
    } else if (QUERY_HINT.test(text) || !to) {
      reply = statsReply(project, scope)
    } else {
      reply = statsReply(project, scope)
    }

    addProjectMessage(project.id, 'assistant', reply, proposal?.id || null)
    res.json({ reply, proposal })
  } catch (e) { next(e) }
})

trackingRouter.post('/project-proposals/:id/apply', (hr, res, next) => {
  try {
    const p = get('SELECT * FROM project_proposals WHERE id = ?', hr.params.id)
    if (!p) { const e = new Error('提案不存在'); e.statusCode = 404; throw e }
    const { project, role } = projectFor(hr.user, p.project_id)
    requireAction(role, 'batch.status')
    if (p.status !== 'pending') { const e = new Error('提案已处理'); e.statusCode = 400; throw e }
    if (p.created_by !== hr.user.id && role !== 'admin') {
      const e = new Error('仅提案发起人或管理员可确认'); e.statusCode = 403; throw e
    }
    const payload = parseJson(p.payload_json, {})
    const targets = resolveBatchTargets(project.id, { requirementIds: payload.requirementIds })
    const result = applyBatchStatus({
      project, user: hr.user, targets, to: payload.to,
      effectiveAt: payload.effectiveAt, note: payload.note || '', source: 'session'
    })
    if (!result.ok) { const e = new Error(result.reason); e.statusCode = 400; throw e }
    run("UPDATE project_proposals SET status = 'applied', applied_at = ?, result_json = ? WHERE id = ?",
      now(), JSON.stringify(result), p.id)
    recordAudit(hr, 'project-proposal.apply', 'project-proposal', p.id, null, {
      proposalId: p.id, action: p.action, batchId: result.batchId,
      success: result.success.length, failed: result.failed.length, confirmedBy: hr.user.id
    })
    addProjectMessage(project.id, 'assistant', `提案已执行（批次 ${result.batchId}）：成功 ${result.success.length} 条，失败 ${result.failed.length} 条。`)
    res.json({ ok: true, result })
  } catch (e) { next(e) }
})

trackingRouter.post('/project-proposals/:id/discard', (hr, res, next) => {
  try {
    const p = get('SELECT * FROM project_proposals WHERE id = ?', hr.params.id)
    if (!p) { const e = new Error('提案不存在'); e.statusCode = 404; throw e }
    const { role } = projectFor(hr.user, p.project_id)
    if (p.created_by !== hr.user.id && role !== 'admin') {
      const e = new Error('仅提案发起人或管理员可放弃'); e.statusCode = 403; throw e
    }
    if (p.status !== 'pending') { const e = new Error('提案已处理'); e.statusCode = 400; throw e }
    run("UPDATE project_proposals SET status = 'discarded' WHERE id = ?", p.id)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

export { LEVEL_LABEL }
