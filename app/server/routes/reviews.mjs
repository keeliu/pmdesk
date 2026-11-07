import { Router } from 'express'
import { all, get, run, now, uid, parseJson, logEvent } from '../db.mjs'
import {
  requirementFor, projectFor, requireAction, recordAudit, deliverNotifications,
  allProjectPms, notifyUser
} from '../core.mjs'
import { normalizeMilestones } from '../services/milestones.mjs'
import { transitionRequirement } from '../services/status.mjs'

export const reviewsRouter = Router()

const OPEN = `('待处理','处理中','不采纳待确认')`

function reviewerNames(ids) {
  const users = all('SELECT id, name FROM users')
  return ids.map(id => users.find(u => u.id === id)?.name || id)
}

function reviewView(r) {
  const ids = parseJson(r.reviewers_json, [])
  const annotations = all('SELECT a.*, u.name AS author_name FROM annotations a LEFT JOIN users u ON u.id = a.author_id WHERE a.review_id = ? ORDER BY a.created_at', r.id)
  const suggestions = all('SELECT * FROM suggestions WHERE review_id = ? ORDER BY seq', r.id)
  const spec = get('SELECT id, version, status FROM specs WHERE id = ?', r.spec_id)
  return {
    ...r, reviewers: ids, reviewerNames: reviewerNames(ids),
    annotations, suggestions, spec,
    openSuggestions: suggestions.filter(s => ['待处理', '处理中', '不采纳待确认'].includes(s.status)).length
  }
}

function startReview(req, review, project, actorId) {
  if (review.status !== '待开始') return
  if (req.status === '需求评审中') {
    run('UPDATE requirements SET stall_since = ?, updated_at = ? WHERE id = ?', now(), now(), req.id)
  }
  run("UPDATE reviews SET status = '进行中' WHERE id = ?", review.id)
}

reviewsRouter.get('/requirements/:id/reviews', (hr, res, next) => {
  try {
    const { req } = requirementFor(hr.user, hr.params.id)
    const rows = all('SELECT * FROM reviews WHERE requirement_id = ? ORDER BY round DESC', req.id)
    res.json(rows.map(reviewView))
  } catch (e) { next(e) }
})

reviewsRouter.get('/projects/:projectId/reviews', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    const rows = all(`SELECT rv.*, r.code, r.title, r.status AS req_status
      FROM reviews rv JOIN requirements r ON r.id = rv.requirement_id
      WHERE r.project_id = ? ORDER BY rv.created_at DESC`, project.id)
    res.json(rows.map(r => {
      const ids = parseJson(r.reviewers_json, [])
      const suggestions = all('SELECT * FROM suggestions WHERE review_id = ? ORDER BY seq', r.id)
      return {
        ...r, reviewers: ids, reviewerNames: reviewerNames(ids), suggestions,
        openSuggestions: suggestions.filter(s => ['待处理', '处理中', '不采纳待确认'].includes(s.status)).length
      }
    }))
  } catch (e) { next(e) }
})

reviewsRouter.get('/projects/:projectId/suggestions', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    const rows = all(`SELECT s.*, r.code, r.title AS req_title, r.status AS req_status, rv.round, rv.spec_id
      FROM suggestions s JOIN requirements r ON r.id = s.requirement_id
      LEFT JOIN reviews rv ON rv.id = s.review_id
      WHERE r.project_id = ? ORDER BY s.created_at DESC`, project.id)
    res.json(rows)
  } catch (e) { next(e) }
})

reviewsRouter.post('/requirements/:id/reviews', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'review.create')
    const reviewerIds = Array.isArray(hr.body?.reviewerIds) ? hr.body.reviewerIds.filter(Boolean) : []
    if (reviewerIds.length < 2) { const e = new Error('评审人不得少于两人（当前临时口径）'); e.statusCode = 400; throw e }
    const spec = get("SELECT * FROM specs WHERE requirement_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1", req.id)
    if (!spec) { const e = new Error('尚未发布说明书，无法发起评审'); e.statusCode = 400; throw e }
    if (!['需求分析中', '需求评审中'].includes(req.status)) {
      const e = new Error(`当前状态「${req.status}」不能发起评审`); e.statusCode = 400; throw e
    }
    const last = get('SELECT MAX(round) AS m FROM reviews WHERE requirement_id = ?', req.id)
    const round = (last?.m || 0) + 1
    const id = uid('RV-')
    run(`INSERT INTO reviews (id, requirement_id, spec_id, round, reviewers_json, deadline, status, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      id, req.id, spec.id, round, JSON.stringify(reviewerIds), hr.body?.deadline || '', '待开始', hr.user.id, now())
    if (req.status === '需求分析中') {
      run("UPDATE requirements SET status = '需求评审中', stall_since = ?, updated_at = ? WHERE id = ?", now(), now(), req.id)
      logEvent({ projectId: project.id, requirementId: req.id, type: 'status', message: '需求分析中 → 需求评审中', payload: { from: '需求分析中', to: '需求评审中' }, actorId: hr.user.id })
    }
    deliverNotifications(project.id, reviewerIds, 'review', `需求待评审：${req.code} ${req.title}`, `第 ${round} 轮评审已发起，截止 ${hr.body?.deadline || '未设置'}`)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'review', message: `发起第 ${round} 轮评审`, payload: { round, reviewers: reviewerIds }, actorId: hr.user.id })
    recordAudit(hr, 'review.create', 'review', id, null, { round, reviewers: reviewerIds })
    res.status(201).json({ id, round, status: '待开始' })
  } catch (e) { next(e) }
})

reviewsRouter.post('/reviews/:id/start', (hr, res, next) => {
  try {
    const review = get('SELECT * FROM reviews WHERE id = ?', hr.params.id)
    if (!review) { const e = new Error('评审不存在'); e.statusCode = 404; throw e }
    const { req, project, role } = requirementFor(hr.user, review.requirement_id)
    const ids = parseJson(review.reviewers_json, [])
    if (!['pm', 'admin'].includes(role) && !ids.includes(hr.user.id)) {
      const e = new Error('仅评审人或产品经理可开始评审'); e.statusCode = 403; throw e
    }
    if (review.status === '已完成') { const e = new Error('评审已结束'); e.statusCode = 400; throw e }
    startReview(req, review, project, hr.user.id)
    res.json({ ok: true, status: '进行中' })
  } catch (e) { next(e) }
})

reviewsRouter.post('/reviews/:id/annotations', (hr, res, next) => {
  try {
    const review = get('SELECT * FROM reviews WHERE id = ?', hr.params.id)
    if (!review) { const e = new Error('评审不存在'); e.statusCode = 404; throw e }
    const { req, project, role } = requirementFor(hr.user, review.requirement_id)
    const ids = parseJson(review.reviewers_json, [])
    if (!ids.includes(hr.user.id) && !['pm', 'admin'].includes(role)) {
      const e = new Error('仅评审人可添加批注'); e.statusCode = 403; throw e
    }
    if (review.status === '已完成') { const e = new Error('评审已结束，不能新增批注'); e.statusCode = 400; throw e }
    const { section, quote, content } = hr.body || {}
    if (!content?.trim()) { const e = new Error('批注内容不能为空'); e.statusCode = 400; throw e }
    startReview(req, review, project, hr.user.id)
    const annId = uid('AN-')
    run('INSERT INTO annotations (id, review_id, section, quote, content, author_id, stale, created_at) VALUES (?,?,?,?,?,?,0,?)',
      annId, review.id, section || '全文', quote || '', content.trim(), hr.user.id, now())

    const openSuggestion = all('SELECT * FROM suggestions WHERE review_id = ? AND status IN ' + OPEN, review.id)
      .find(s => s.title.startsWith((section || '全文') + '：'))
    let suggestionId
    if (openSuggestion) {
      const idsJson = parseJson(openSuggestion.annotation_ids_json, [])
      idsJson.push(annId)
      run('UPDATE suggestions SET detail = ?, annotation_ids_json = ? WHERE id = ?',
        `${openSuggestion.detail}\n- ${hr.user.name}：${content.trim()}`, JSON.stringify(idsJson), openSuggestion.id)
      suggestionId = openSuggestion.id
    } else {
      const max = get('SELECT MAX(seq) AS m FROM suggestions WHERE review_id = ?', review.id)
      suggestionId = uid('SG-')
      const title = `${section || '全文'}：${content.trim().slice(0, 24)}`
      run(`INSERT INTO suggestions (id, review_id, requirement_id, seq, title, detail, expected, status, annotation_ids_json, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        suggestionId, review.id, req.id, (max?.m || 0) + 1, title,
        `- ${hr.user.name}：${content.trim()}${quote ? `\n> ${quote}` : ''}`,
        hr.body?.expected || '按批注意见修改并重新发布说明书', '待处理',
        JSON.stringify([annId]), hr.user.id, now())
    }
    const pms = allProjectPms(project.id).filter(id => id !== hr.user.id)
    deliverNotifications(project.id, pms, 'suggestion', `新的评审建议：${req.code}`, content.trim().slice(0, 80))
    logEvent({ projectId: project.id, requirementId: req.id, type: 'annotation', message: `评审批注：${content.trim().slice(0, 40)}`, payload: { section, suggestionId }, actorId: hr.user.id })
    res.status(201).json({ id: annId, suggestionId })
  } catch (e) { next(e) }
})

reviewsRouter.post('/reviews/:id/merge', (hr, res, next) => {
  try {
    const review = get('SELECT * FROM reviews WHERE id = ?', hr.params.id)
    if (!review) { const e = new Error('评审不存在'); e.statusCode = 404; throw e }
    const { req, project, role } = requirementFor(hr.user, review.requirement_id)
    if (!['pm', 'admin'].includes(role)) { const e = new Error('仅产品经理可归并建议'); e.statusCode = 403; throw e }
    const ids = hr.body?.suggestionIds || []
    if (ids.length < 2) { const e = new Error('至少选择两条建议进行归并'); e.statusCode = 400; throw e }
    const items = ids.map(id => get('SELECT * FROM suggestions WHERE id = ? AND review_id = ?', id, review.id)).filter(Boolean)
    if (items.length < 2) { const e = new Error('建议不存在'); e.statusCode = 404; throw e }
    const max = get('SELECT MAX(seq) AS m FROM suggestions WHERE review_id = ?', review.id)
    const newId = uid('SG-')
    run(`INSERT INTO suggestions (id, review_id, requirement_id, seq, title, detail, expected, status, annotation_ids_json, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      newId, review.id, req.id, (max?.m || 0) + 1,
      hr.body?.title || `归并建议：${items.map(i => i.title.split('：')[0]).join('、')}`,
      items.map(i => `【${i.title}】\n${i.detail}`).join('\n\n'),
      hr.body?.expected || items[0].expected, '待处理',
      JSON.stringify(items.flatMap(i => parseJson(i.annotation_ids_json, []))), hr.user.id, now())
    for (const i of items) run("UPDATE suggestions SET status = '已合并' WHERE id = ?", i.id)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'suggestion-merge', message: `归并 ${items.length} 条建议`, payload: { newId }, actorId: hr.user.id })
    res.status(201).json({ id: newId })
  } catch (e) { next(e) }
})

reviewsRouter.post('/suggestions/:id/start', (hr, res, next) => {
  try {
    const s = get('SELECT * FROM suggestions WHERE id = ?', hr.params.id)
    if (!s) { const e = new Error('建议不存在'); e.statusCode = 404; throw e }
    const { req, role } = requirementFor(hr.user, s.requirement_id)
    requireAction(role, 'suggestion.close')
    if (s.status !== '待处理') { const e = new Error('仅待处理建议可开始处理'); e.statusCode = 400; throw e }
    run("UPDATE suggestions SET status = '处理中' WHERE id = ?", s.id)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

reviewsRouter.post('/suggestions/:id/close', (hr, res, next) => {
  try {
    const s = get('SELECT * FROM suggestions WHERE id = ?', hr.params.id)
    if (!s) { const e = new Error('建议不存在'); e.statusCode = 404; throw e }
    const { req, project, role } = requirementFor(hr.user, s.requirement_id)
    requireAction(role, 'suggestion.close')
    if (['已关闭', '已消除'].includes(s.status)) { const e = new Error('建议已关闭'); e.statusCode = 400; throw e }
    const review = get('SELECT * FROM reviews WHERE id = ?', s.review_id)
    const originSpec = get('SELECT * FROM specs WHERE id = ?', review.spec_id)
    let target = null
    if (hr.body?.specId) target = get('SELECT * FROM specs WHERE id = ? AND requirement_id = ?', hr.body.specId, req.id)
    else if (hr.body?.version) target = get('SELECT * FROM specs WHERE requirement_id = ? AND version = ?', req.id, Number(hr.body.version))
    else target = get('SELECT * FROM specs WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', req.id)
    if (!target) { const e = new Error('找不到可关联的说明书版本'); e.statusCode = 400; throw e }
    if (originSpec && target.version <= originSpec.version) {
      const e = new Error(`必须关联评审之后的新版本（评审版本 V${originSpec.version}）`); e.statusCode = 400; throw e
    }
    if (originSpec && target.markdown === originSpec.markdown) {
      const e = new Error('说明书内容没有实际变化，不能关闭建议'); e.statusCode = 400; throw e
    }
    run("UPDATE suggestions SET status = '已消除', resolution_version = ?, resolution_note = ?, closed_at = ? WHERE id = ?",
      target.version, hr.body?.note || '', now(), s.id)
    const reviewers = parseJson(review.reviewers_json, [])
    deliverNotifications(project.id, reviewers, 'suggestion', `建议待复核：${req.code}`, `「${s.title}」已在说明书 V${target.version} 中消除，请复核`)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'suggestion-close', message: `消除建议：${s.title}（V${target.version}）`, payload: { suggestionId: s.id, version: target.version }, actorId: hr.user.id })
    recordAudit(hr, 'suggestion.close', 'suggestion', s.id, { status: s.status }, { status: '已消除', version: target.version })
    res.json({ ok: true, version: target.version })
  } catch (e) { next(e) }
})

reviewsRouter.post('/suggestions/:id/reject', (hr, res, next) => {
  try {
    const s = get('SELECT * FROM suggestions WHERE id = ?', hr.params.id)
    if (!s) { const e = new Error('建议不存在'); e.statusCode = 404; throw e }
    const { req, role } = requirementFor(hr.user, s.requirement_id)
    requireAction(role, 'suggestion.close')
    if (!hr.body?.reason?.trim()) { const e = new Error('不采纳需填写理由'); e.statusCode = 400; throw e }
    run("UPDATE suggestions SET status = '不采纳待确认', reject_reason = ? WHERE id = ?", hr.body.reason, s.id)
    const review = get('SELECT * FROM reviews WHERE id = ?', s.review_id)
    deliverNotifications(req.project_id, parseJson(review.reviewers_json, []), 'suggestion', `建议不采纳待确认：${req.code}`, hr.body.reason)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

reviewsRouter.post('/suggestions/:id/confirm-reject', (hr, res, next) => {
  try {
    const s = get('SELECT * FROM suggestions WHERE id = ?', hr.params.id)
    if (!s) { const e = new Error('建议不存在'); e.statusCode = 404; throw e }
    const { req, role } = requirementFor(hr.user, s.requirement_id)
    const review = get('SELECT * FROM reviews WHERE id = ?', s.review_id)
    const reviewers = parseJson(review.reviewers_json, [])
    if (!reviewers.includes(hr.user.id) && !['pm', 'admin'].includes(role)) {
      const e = new Error('仅提出意见的评审人可确认不采纳'); e.statusCode = 403; throw e
    }
    if (s.status !== '不采纳待确认') { const e = new Error('当前状态不可确认'); e.statusCode = 400; throw e }
    run("UPDATE suggestions SET status = '已关闭', closed_at = ? WHERE id = ?", now(), s.id)
    logEvent({ projectId: req.project_id, requirementId: req.id, type: 'suggestion-close', message: `不采纳已确认：${s.title}`, payload: { suggestionId: s.id }, actorId: hr.user.id })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

reviewsRouter.post('/suggestions/:id/reopen', (hr, res, next) => {
  try {
    const s = get('SELECT * FROM suggestions WHERE id = ?', hr.params.id)
    if (!s) { const e = new Error('建议不存在'); e.statusCode = 404; throw e }
    const { req, role } = requirementFor(hr.user, s.requirement_id)
    if (!['pm', 'admin', 'reviewer'].includes(role)) { const e = new Error('无权重新打开'); e.statusCode = 403; throw e }
    run("UPDATE suggestions SET status = '待处理', closed_at = NULL WHERE id = ?", s.id)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

reviewsRouter.post('/reviews/:id/conclude', (hr, res, next) => {
  try {
    const review = get('SELECT * FROM reviews WHERE id = ?', hr.params.id)
    if (!review) { const e = new Error('评审不存在'); e.statusCode = 404; throw e }
    const { req, project, role } = requirementFor(hr.user, review.requirement_id)
    const reviewers = parseJson(review.reviewers_json, [])
    if (!reviewers.includes(hr.user.id) && !['pm', 'admin'].includes(role)) {
      const e = new Error('仅评审人或产品经理可登记结论'); e.statusCode = 403; throw e
    }
    const conclusion = hr.body?.conclusion
    if (!['通过', '不通过'].includes(conclusion)) { const e = new Error('结论必须为通过或不通过'); e.statusCode = 400; throw e }
    const open = get(`SELECT COUNT(*) AS c FROM suggestions WHERE review_id = ? AND status IN ${OPEN}`, review.id)
    if (conclusion === '通过' && open.c > 0) {
      const e = new Error(`仍有 ${open.c} 条建议未闭环，不能通过评审`); e.statusCode = 400; throw e
    }
    run("UPDATE reviews SET status = '已完成', conclusion = ?, summary = ?, decided_at = ? WHERE id = ?",
      conclusion, hr.body?.summary || '', now(), review.id)
    if (conclusion === '通过') {
      const result = transitionRequirement({
        req, to: '待开发', note: `第 ${review.round} 轮评审通过`, actorId: hr.user.id
      })
      if (!result.ok) {
        const e = new Error(result.reason); e.statusCode = 400; e.details = result.issues || null; throw e
      }
      deliverNotifications(project.id, allProjectPms(project.id), 'review', `评审通过：${req.code}`, `${req.title} 已进入待开发`)
    } else {
      const result = transitionRequirement({
        req, to: '需求分析中', note: hr.body?.summary || '评审不通过', actorId: hr.user.id
      })
      if (!result.ok) {
        const e = new Error(result.reason); e.statusCode = 400; throw e
      }
      deliverNotifications(project.id, allProjectPms(project.id), 'review', `评审未通过：${req.code}`, hr.body?.summary || '请按建议修改后重新评审')
    }
    logEvent({ projectId: project.id, requirementId: req.id, type: 'review-conclude', message: `第 ${review.round} 轮评审结论：${conclusion}`, payload: { round: review.round, conclusion }, actorId: hr.user.id })
    recordAudit(hr, 'review.conclude', 'review', review.id, { status: review.status }, { conclusion })
    res.json({ ok: true, conclusion })
  } catch (e) { next(e) }
})
