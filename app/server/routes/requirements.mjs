import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { all, get, run, tx, now, uid, parseJson, logEvent } from '../db.mjs'
import { filesDir } from './admin.mjs'
import {
  requirementFor, projectFor, requireAction, requireFields, recordAudit,
  requirementView, eventView, deliverNotifications, allProjectPms, statusLabel
} from '../core.mjs'
import { transitionRequirement, DEVELOPER_TARGETS, nextStatuses, gateIssues } from '../services/status.mjs'
import { parseUpload, splitText, similarity } from '../services/parse.mjs'
import {
  REQUESTER_LEVELS, enterpriseOptions, normalizeRequester, requesterIssues, requesterComplete,
  requesterView, requesterFromSource, requesterSnapshot, levelLabel
} from '../services/requester.mjs'
import {
  normalizeMilestones, applyMilestones, milestoneGate, autoBackfill, milestoneView,
  MILESTONE_FIELDS
} from '../services/milestones.mjs'
import { buildPriority } from '../services/priority.mjs'
import { confirmRequirement } from '../services/confirm-core.mjs'
import {
  LEAD_FIELDS, LEAD_MAX_LENGTH, normalizeApps, normalizeLeads, profileView, leadsView, appsView, requirementUsers
} from '../services/requirement-profile.mjs'
import { extractTextFromImage } from './ai.mjs'
import { distillRequirements, distillNote } from '../services/intake-distill.mjs'
import { requirementDetail, flowOf } from '../services/artifacts.mjs'
import { generateFlowchart } from '../services/flowchart.mjs'

export const requirementsRouter = Router()

const CLARIFY_FIELDS = [
  { key: 'requester', label: '提出方信息', hint: '提出企业、部门、提出人姓名与级别/岗位' },
  { key: 'roles', label: '角色与岗位', hint: '谁提出、谁使用、谁审批' },
  { key: 'goal', label: '目标与价值', hint: '解决什么问题、带来什么结果' },
  { key: 'scope', label: '范围', hint: '本期做哪些端、哪些功能' },
  { key: 'boundary', label: '边界', hint: '本期明确不做什么' },
  { key: 'acceptance', label: '验收口径', hint: '怎样算完成' }
]

function projectScope(project) {
  const scope = parseJson(project.system_scope_json, {})
  return {
    platforms: scope.platforms || [], applications: scope.applications || [],
    modules: scope.modules || [], excluded: scope.excluded || [],
    all: [...(scope.platforms || []), ...(scope.applications || []), ...(scope.modules || [])]
  }
}

function requesterOf(req) {
  return parseJson(req.requester_json, null) || requesterFromSource(parseJson(req.source_json, {}))
}

function gapsOf(req, project) {
  const clar = parseJson(req.clarification_json, {})
  const answers = clar.answers || {}
  const requester = requesterOf(req)
  const gaps = CLARIFY_FIELDS.filter(f => {
    if (f.key === 'requester') return !requesterComplete(requester, project)
    return !answers[f.key]?.value
  }).map(f => f.key)
  const apps = parseJson(req.involved_apps_json, [])
  if (!apps.length) gaps.push('involvedApps')
  return gaps
}

function gapsWithDetails(req, project) {
  const gaps = gapsOf(req, project)
  const requester = requesterOf(req)
  const issues = requesterIssues(requester, project)
  return gaps.map(key => {
    if (key === 'requester') {
      return {
        field: 'requester', label: '提出方信息', blocking: true,
        detail: issues.map(i => i.message).join('；') || '提出方信息不完整',
        issues
      }
    }
    if (key === 'involvedApps') return { field: key, label: '涉及应用', blocking: true, detail: '尚未确认涉及应用' }
    return { field: key, label: CLARIFY_FIELDS.find(f => f.key === key)?.label || key, blocking: true, detail: '尚未澄清' }
  })
}

function inferApps(text, project) {
  const scope = projectScope(project)
  const hay = text.toLowerCase()
  const hits = []
  for (const app of [...scope.applications, ...scope.modules, ...scope.platforms]) {
    const token = app.toLowerCase().replace(/(系统|应用|模块|平台)$/, '')
    const matched = hay.includes(app.toLowerCase()) || (token.length >= 2 && hay.includes(token))
    if (matched) hits.push({ name: app, kind: 'internal', confidence: hay.includes(app.toLowerCase()) ? 0.9 : 0.7, reason: `文本中提及「${token}」` })
  }
  const rules = [
    { kw: ['消息', '通知', '提醒'], name: '消息中心' },
    { kw: ['权限', '角色', '审批'], name: '权限中心' },
    { kw: ['报表', '统计', '看板'], name: '报表' },
    { kw: ['订单', '交易'], name: '订单' },
    { kw: ['客户', '会员'], name: '客户' },
    { kw: ['库存', '仓储'], name: '库存' }
  ]
  for (const rule of rules) {
    if (!rule.kw.some(k => hay.includes(k))) continue
    const target = scope.all.find(a => a.includes(rule.name))
    if (target && !hits.some(h => h.name === target)) {
      hits.push({ name: target, kind: 'internal', confidence: 0.6, reason: `关键词「${rule.kw.find(k => hay.includes(k))}」指向` })
    }
  }
  if (!hits.length && scope.applications[0]) {
    hits.push({ name: scope.applications[0], kind: 'internal', confidence: 0.4, reason: '未识别到明确应用，暂按主应用推断' })
  }
  return hits
}

function questionFor(field, req, project) {
  const clar = parseJson(req.clarification_json, {})
  const scope = projectScope(project)
  const apps = scope.applications.length ? scope.applications : scope.all
  const base = {
    requester: {
      question: '该需求由哪个企业、哪个部门的谁提出？级别或岗位是什么？',
      options: enterpriseOptions(project).slice(0, 4),
      fields: [
        { key: 'enterprise', label: '企业', options: enterpriseOptions(project) },
        { key: 'department', label: '部门' },
        { key: 'name', label: '提出人姓名' },
        { key: 'level', label: '级别', options: REQUESTER_LEVELS },
        { key: 'position', label: '岗位' },
        { key: 'contact', label: '联系方式' }
      ]
    },
    roles: {
      question: '这条需求的主要角色是谁？',
      options: ['业务发起人提出、运营人员使用', '运营管理员独立完成', '外部客户自助办理', '多角色协同，需审批']
    },
    goal: {
      question: '本期最想达成的结果是什么？',
      options: ['减少人工处理时间', '补齐缺失的业务能力', '降低操作差错率', '支撑新的业务模式']
    },
    scope: {
      question: '本期范围应如何界定？',
      options: ['仅覆盖核心流程', '核心流程加配置能力', '覆盖全部关联场景', '先做最小可用版本']
    },
    boundary: {
      question: '本期明确不做的是什么？',
      options: ['不做历史数据迁移', '不做外部系统改造', '不做移动端', '不做权限细分']
    },
    acceptance: {
      question: '用什么口径判断需求完成？',
      options: ['关键流程可完整走通', '指标达到约定阈值', '通过评审且无未关闭建议', '上线后观察一周无阻断问题']
    },
    involvedApps: {
      question: '这条需求可能涉及哪些应用？',
      options: apps.slice(0, 4)
    }
  }[field]
  if (!base) return null
  const existing = field === 'requester' ? requesterView(requesterOf(req), project) : (clar.answers?.[field]?.value || '')
  return { field, label: CLARIFY_FIELDS.find(f => f.key === field)?.label || '涉及应用', ...base, existing }
}

requirementsRouter.get('/projects/:projectId/requirements', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'requirement.view')
    const { status, iteration, q, app, owner, inbox, page, pageSize } = hr.query
    let sql = 'SELECT * FROM requirements WHERE project_id = ?'
    const params = [project.id]
    if (inbox === '1') { sql += " AND status = '需求调研中'" }
    else if (status) { sql += ' AND status = ?'; params.push(status) }
    else { sql += " AND code IS NOT NULL AND code != '' AND status != '已丢弃'" }
    if (iteration) { sql += ' AND iteration_id = ?'; params.push(iteration) }
    if (owner) { sql += ' AND owner_id = ?'; params.push(owner) }
    if (q) { sql += ' AND (title LIKE ? OR code LIKE ?)'; params.push(`%${q}%`, `%${q}%`) }
    sql += ' ORDER BY updated_at DESC'
    let rows = all(sql, ...params).map(requirementView)
    if (app) rows = rows.filter(r => r.involvedApps.some(a => (a.name || a) === app))
    const users = all('SELECT id, name FROM users')
    const nameOf = id => users.find(u => u.id === id)?.name || ''
    const decorate = r => ({
      ...r, ownerName: nameOf(r.owner_id),
      stageLabel: r.statusLabel,
      openSuggestions: get("SELECT COUNT(*) AS c FROM suggestions WHERE requirement_id = ? AND status IN ('待处理','处理中','不采纳待确认')", r.id).c
    })
    if (page) {
      const size = Math.min(Math.max(parseInt(pageSize, 10) || 10, 1), 100)
      const p = Math.max(parseInt(page, 10) || 1, 1)
      const total = rows.length
      res.json({ items: rows.slice((p - 1) * size, p * size).map(decorate), total, page: p, pageSize: size })
      return
    }
    res.json(rows.map(decorate))
  } catch (e) { next(e) }
})

requirementsRouter.get('/projects/:projectId/scope-apps', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    res.json(projectScope(project))
  } catch (e) { next(e) }
})

requirementsRouter.post('/projects/:projectId/requirements/intake', async (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'requirement.intake')
    const b = hr.body || {}
    let text = b.text || ''
    let fileName = ''
    let parseNote = ''
    let storedFile = ''
    if (b.file) {
      fileName = b.file.name || 'upload'
      const lower = fileName.toLowerCase()
      const looksImage = /\.(png|jpe?g|webp|gif|bmp)$/.test(lower)
      if (looksImage && b.file.base64) {
        const raw = b.file.base64.includes(',') ? b.file.base64.split(',')[1] : b.file.base64
        const vision = await extractTextFromImage(project.id, raw, b.file.type)
        if (vision.ok) text = vision.text
        else parseNote = vision.reason
      } else {
        const parsed = await parseUpload(b.file)
        if (parsed.ok) text = parsed.text
        else parseNote = parsed.reason
      }
      if (b.file.base64) {
        const raw = b.file.base64.includes(',') ? b.file.base64.split(',')[1] : b.file.base64
        const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_')
        storedFile = `${uid('F-')}-${safeName}`
        fs.writeFileSync(path.join(filesDir, storedFile), Buffer.from(raw, 'base64'))
      }
    }
    if (!text.trim()) {
      const e = new Error(parseNote || '请输入需求内容或上传可解析的文件'); e.statusCode = 400; throw e
    }
    let items = null
    if (b.autoSplit !== false && b.file) {
      const distilled = await distillRequirements({ text, project, fileName })
      if (distilled.ok && distilled.items.length) {
        items = distilled.items.map(it => ({ title: it.title, text: it.description ? `${it.title}\n${it.description}` : it.title, hints: it }))
        parseNote = parseNote ? `${parseNote}；${distillNote(distilled)}` : distillNote(distilled)
      } else {
        parseNote = parseNote ? `${parseNote}；${distillNote(distilled)}` : distillNote(distilled)
      }
    }
    if (!items) items = b.autoSplit === false ? [{ title: b.title || text.slice(0, 40), text }] : splitText(text)
    if (!items.length) { const e = new Error('未能识别出有效需求文本'); e.statusCode = 400; throw e }
    const created = []
    const ts = now()
    const scopeAll = projectScope(project).all
    for (const item of items) {
      const finalTitle = b.title && items.length === 1 ? b.title : item.title
      const dup = all("SELECT id, code, title FROM requirements WHERE project_id = ? AND status != '已丢弃'", project.id)
        .map(r => ({ ...r, score: similarity(finalTitle + item.text, r.title) }))
        .filter(r => r.score >= 0.55).sort((a, b2) => b2.score - a.score)[0]
      const id = uid('REQ-')
      const sourceObj = {
        type: b.originType || (b.file ? 'file' : 'text'), fileName, storedFile,
        excerpt: item.text.slice(0, 2000), fullText: item.text,
        submitter: b.submitter || hr.user.name, parseNote,
        distilled: Boolean(item.hints)
      }
      let requester = requesterFromSource(sourceObj, project)
      let involvedApps = []
      if (item.hints?.requester && Object.keys(item.hints.requester).length) {
        requester = normalizeRequester(item.hints.requester, project, requester)
      }
      if (item.hints?.apps?.length) {
        involvedApps = item.hints.apps.map(name => {
          const hit = scopeAll.find(x => x === name || name.includes(x) || x.includes(name))
          return { name: hit || name, kind: hit ? 'internal' : 'external', confidence: hit ? 0.7 : 0.5, reason: '文档提炼' }
        })
      }
      run(`INSERT INTO requirements (id, project_id, title, status, origin_type, source_json,
           clarification_json, requester_json, involved_apps_json, owner_id, created_at, updated_at, stall_since)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, project.id, finalTitle, '需求调研中', sourceObj.type,
        JSON.stringify(sourceObj), JSON.stringify({ answers: {}, history: [], completed: false }),
        JSON.stringify(requester), JSON.stringify(involvedApps),
        hr.user.id, ts, ts, ts)
      logEvent({ projectId: project.id, requirementId: id, type: 'intake', message: `登记需求：${finalTitle}`, payload: { source: sourceObj.type, fileName, distilled: Boolean(item.hints) }, actorId: hr.user.id })
      created.push({ id, title: finalTitle, duplicate: dup ? { id: dup.id, code: dup.code, title: dup.title, score: Math.round(dup.score * 100) } : null })
    }
    recordAudit(hr, 'requirement.intake', 'project', project.id, null, { count: created.length, fileName })
    res.status(201).json({ created, parseNote })
  } catch (e) { next(e) }
})

requirementsRouter.get('/requirements/:id', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    const view = requirementView(req)
    const versions = all('SELECT id, version, note, created_by, created_at FROM requirement_versions WHERE requirement_id = ? ORDER BY version DESC', req.id)
    const proto = get('SELECT * FROM prototypes WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', req.id)
    const spec = get('SELECT id, version, status, analysis_version, prototype_version, created_at FROM specs WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', req.id)
    const review = get('SELECT * FROM reviews WHERE requirement_id = ? ORDER BY round DESC LIMIT 1', req.id)
    const suggestions = all('SELECT * FROM suggestions WHERE requirement_id = ? ORDER BY seq', req.id)
    const users = all('SELECT id, name, role, title FROM users')
    const nameOf = id => users.find(u => u.id === id)?.name || ''
    const owner = users.find(u => u.id === req.owner_id)
    const ignored = new Set(all(`SELECT similar_id AS id FROM similarity_ignores WHERE requirement_id = ?
      UNION SELECT requirement_id AS id FROM similarity_ignores WHERE similar_id = ?`, req.id, req.id).map(x => x.id))
    const related = all("SELECT id, code, title, status FROM requirements WHERE project_id = ? AND id != ? AND status NOT IN ('已丢弃','需求调研中')", project.id, req.id)
      .map(r => ({ ...r, score: similarity(req.title + JSON.stringify(view.clarification), r.title) }))
      .filter(r => r.score > 0.18 && !ignored.has(r.id)).sort((a, b) => b.score - a.score).slice(0, 5)
    const transitions = nextStatuses(req.status, req.suspended_from).map(to => ({
      status: to, label: statusLabel(to), issues: gateIssues(req, to)
    }))
    res.json({
      ...view, ownerName: owner?.name || '', role, transitions,
      profile: profileView(req, { project, users }),
      leadFields: LEAD_FIELDS, leadMaxLength: LEAD_MAX_LENGTH,
      gaps: gapsOf(req, project), gapDetails: gapsWithDetails(req, project), scope: projectScope(project),
      requester: requesterView(requesterOf(req), project),
      requesterLevels: REQUESTER_LEVELS, enterpriseOptions: enterpriseOptions(project),
      milestones: milestoneView(req.milestones_json), milestoneFields: MILESTONE_FIELDS,
      versions: versions.map(v => ({ ...v, createdByName: nameOf(v.created_by) })),
      prototype: proto ? { id: proto.id, version: proto.version, status: proto.status, pages: parseJson(proto.pages_json, []) } : null,
      spec, latestReview: review ? { ...review, reviewers: parseJson(review.reviewers_json, []) } : null,
      suggestions, related,
      project: { id: project.id, name: project.name, code: project.code },
      suspendedFrom: req.suspended_from
    })
  } catch (e) { next(e) }
})

requirementsRouter.get('/requirements/:id/detail', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    res.json(requirementDetail({ req, project, role }))
  } catch (e) { next(e) }
})

requirementsRouter.get('/requirements/:id/flowcharts/:flowchartId/preview', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    if (role === 'guest') { const e = new Error('访客无权查看流程图'); e.statusCode = 403; throw e }
    const row = get('SELECT * FROM flowcharts WHERE id = ? AND requirement_id = ?', hr.params.flowchartId, req.id)
    if (!row) return res.status(404).send('流程图不存在')
    const sha256 = crypto.createHash('sha256').update(row.html || '', 'utf8').digest('hex')
    if (!row.html || (row.html_sha256 && sha256 !== row.html_sha256)) {
      return res.status(500).send('流程图产物与生成记录不一致，无法预览')
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(`${req.title}-流程图-V${row.analysis_version}.html`)}`)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    res.send(row.html)
  } catch (e) { next(e) }
})

requirementsRouter.post('/requirements/:id/analysis/:versionId/flowchart/regenerate', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'requirement.analyze')
    const versionRow = get('SELECT * FROM requirement_versions WHERE id = ? AND requirement_id = ?', hr.params.versionId, req.id)
    if (!versionRow) { const e = new Error('分析版本不存在'); e.statusCode = 404; throw e }
    const result = generateFlowchart({
      req, project, user: hr.user,
      bindingId: hr.body?.skillBindingId || null,
      versionRow, source: 'regenerate'
    })
    recordAudit(hr, 'flowchart.regenerate', 'requirement', req.id, null, {
      flowchartId: result.id, analysisVersion: versionRow.version, renderer: result.renderer,
      skillSlug: result.skill?.slug || null, skillVersion: result.skill?.version || null
    })
    res.json({
      id: result.id, analysisVersion: versionRow.version, renderer: result.renderer,
      skill: result.skill ? { slug: result.skill.slug, version: result.skill.version } : null,
      fallback: result.fallback?.reason || null
    })
  } catch (e) { next(e) }
})

requirementsRouter.get('/requirements/:id/timeline', (hr, res, next) => {
  try {
    const { req } = requirementFor(hr.user, hr.params.id)
    const rows = all(`SELECT e.*, u.name AS actor_name FROM events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.requirement_id = ? ORDER BY e.created_at DESC`, req.id)
    res.json(rows.map(e => ({ ...eventView(e), actorName: e.actor_name })))
  } catch (e) { next(e) }
})

requirementsRouter.get('/requirements/:id/clarification/questions', (hr, res, next) => {
  try {
    const { req, project } = requirementFor(hr.user, hr.params.id)
    const all = gapsOf(req, project)
    const gaps = all.slice(0, 4)
    res.json({
      gaps: all, gapDetails: gapsWithDetails(req, project),
      questions: gaps.map(f => questionFor(f, req, project)).filter(Boolean)
    })
  } catch (e) { next(e) }
})

requirementsRouter.get('/requirements/:id/clarification/infer-apps', (hr, res, next) => {
  try {
    const { req, project } = requirementFor(hr.user, hr.params.id)
    const source = parseJson(req.source_json, {})
    res.json({ apps: inferApps(`${req.title}\n${source.fullText || source.excerpt || ''}`, project), scope: projectScope(project) })
  } catch (e) { next(e) }
})

requirementsRouter.post('/requirements/:id/clarification/answers', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'requirement.clarify')
    if (req.status !== '需求调研中') { const e = new Error('仅需求调研中的需求可补充澄清信息'); e.statusCode = 400; throw e }
    const answers = hr.body?.answers || []
    if (!Array.isArray(answers) || !answers.length) { const e = new Error('请至少回答一项'); e.statusCode = 400; throw e }
    const clar = parseJson(req.clarification_json, { answers: {}, history: [] })
    clar.answers = clar.answers || {}
    clar.history = clar.history || []
    let apps = parseJson(req.involved_apps_json, [])
    let requester = requesterOf(req)
    for (const a of answers) {
      const ts = now()
      if (a.field === 'involvedApps') {
        apps = Array.isArray(a.value) ? a.value.map(v => typeof v === 'string' ? { name: v, kind: 'internal' } : v) : apps
        clar.history.push({ field: 'involvedApps', question: '涉及应用', answer: apps.map(x => x.name).join('、'), at: ts, by: hr.user.name, source: a.source || 'user' })
      } else if (a.field === 'requester') {
        requester = normalizeRequester(a.value || {}, project, requester)
        requester.updatedAt = ts
        clar.history.push({ field: 'requester', question: '提出方信息', answer: `${requester.enterprise || '—'} / ${requester.department || '—'} / ${requester.name || '—'} / ${levelLabel(requester.level) || '—'}`, at: ts, by: hr.user.name, source: a.source || 'user' })
      } else if (CLARIFY_FIELDS.some(f => f.key === a.field)) {
        clar.answers[a.field] = { value: a.value, at: ts, by: hr.user.name, source: a.source || 'user' }
        clar.history.push({ field: a.field, question: questionFor(a.field, req, project)?.question || a.field, answer: a.value, at: ts, by: hr.user.name, source: a.source || 'user' })
      } else {
        const e = new Error(`未知澄清字段：${a.field}`); e.statusCode = 400; throw e
      }
    }
    const mergedReq = { ...req, clarification_json: JSON.stringify(clar), involved_apps_json: JSON.stringify(apps), requester_json: JSON.stringify(requester) }
    clar.completed = gapsOf(mergedReq, project).length === 0
    run('UPDATE requirements SET clarification_json = ?, involved_apps_json = ?, requester_json = ?, updated_at = ?, stall_since = ? WHERE id = ?',
      JSON.stringify(clar), JSON.stringify(apps), JSON.stringify(requester), now(), now(), req.id)
    const issues = requesterIssues(requester, project)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'clarify', message: `补充澄清：${answers.map(a => a.field).join('、')}`, payload: { answers }, actorId: hr.user.id })
    res.json({ ok: true, gaps: gapsOf(mergedReq, project), gapDetails: gapsWithDetails(mergedReq, project), requester: requesterView(requester, project), issues, clarification: clar })
  } catch (e) { next(e) }
})

requirementsRouter.post('/requirements/:id/clarification/conflict', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'requirement.clarify')
    const { field, chosen, options, note } = hr.body || {}
    requireFields(hr.body || {}, ['field', 'chosen'], '冲突裁决')
    const clar = parseJson(req.clarification_json, { answers: {}, history: [] })
    clar.conflicts = clar.conflicts || []
    clar.conflicts.push({ field, chosen, options: options || [], note: note || '', by: hr.user.name, at: now() })
    if (CLARIFY_FIELDS.some(f => f.key === field)) {
      clar.answers[field] = { value: chosen, at: now(), by: hr.user.name, source: 'conflict' }
    }
    run('UPDATE requirements SET clarification_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(clar), now(), req.id)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'conflict', message: `冲突裁决：${field} → ${chosen}`, payload: { field, chosen, options }, actorId: hr.user.id })
    recordAudit(hr, 'clarification.conflict', 'requirement', req.id, null, { field, chosen })
    res.json({ ok: true, clarification: clar })
  } catch (e) { next(e) }
})

requirementsRouter.post('/requirements/:id/confirm', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'requirement.confirm')
    if (req.status !== '需求调研中') { const e = new Error('仅需求调研中的需求可确认'); e.statusCode = 400; throw e }
    const gaps = gapsOf(req, project)
    if (gaps.length) {
      const labels = gapsWithDetails(req, project).map(d => d.field === 'requester' ? `提出方信息（${d.detail}）` : d.label)
      const e = new Error(`确认清单不完整：${labels.join('、')}`); e.statusCode = 400; throw e
    }
    const requester = requesterOf(req)
    const rIssues = requesterIssues(requester, project)
    if (rIssues.length) {
      const e = new Error(rIssues.map(i => i.message).join('；')); e.statusCode = 400; throw e
    }
    const apps = parseJson(req.involved_apps_json, [])
    const scope = projectScope(project)
    const outside = apps.filter(a => a.kind !== 'external' && !scope.all.includes(a.name))
    if (outside.length) {
      const e = new Error(`涉及应用超出项目系统范围：${outside.map(a => a.name).join('、')}，请更新项目范围或标记为外部依赖`); e.statusCode = 400; throw e
    }
    const clar = parseJson(req.clarification_json, {})
    const result = confirmRequirement({
      req, project, user: hr.user, body: hr.body || {},
      requester, apps, clar, scopeAll: scope.all
    })
    deliverNotifications(project.id, [req.owner_id || hr.user.id], 'requirement', `需求已确认：${result.code}`, `${req.title} 已进入需求池`)
    recordAudit(hr, 'requirement.confirm', 'requirement', req.id, { status: '需求调研中' },
      { status: '待需求分析', code: result.code, grade: result.priority.grade, requester: requesterSnapshot(requester) })
    res.json({ ok: true, code: result.code, priority: result.priority, milestones: result.milestones, requester: requesterView(requester, project) })
  } catch (e) { next(e) }
})

requirementsRouter.patch('/requirements/:id/requester', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'requirement.clarify')
    const before = requesterOf(req)
    const requester = normalizeRequester(hr.body || {}, project, before)
    const issues = requesterIssues(requester, project)
    if (issues.length) {
      const e = new Error(issues.map(i => i.message).join('；')); e.statusCode = 400; throw e
    }
    let priority = parseJson(req.priority_json, null)
    if (priority) {
      priority = buildPriority({
        req: { ...req, requester_json: JSON.stringify(requester) }, project,
        text: [req.title, parseJson(req.source_json, {}).fullText || ''].join('\n'),
        input: { estimateDays: priority.estimateDays, grade: priority.manual ? priority.grade : undefined, reason: priority.reason },
        actor: hr.user.name
      })
    }
    run('UPDATE requirements SET requester_json = ?, priority_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(requester), priority ? JSON.stringify(priority) : req.priority_json, now(), req.id)
    recordAudit(hr, 'requirement.requester', 'requirement', req.id, requesterSnapshot(before), requesterSnapshot(requester))
    logEvent({ projectId: project.id, requirementId: req.id, type: 'requester', message: `更新提出方：${requester.enterprise || '—'} / ${requester.department || '—'} / ${requester.name || '—'}`, payload: requesterSnapshot(requester), actorId: hr.user.id })
    res.json({ ok: true, requester: requesterView(requester, project), priority })
  } catch (e) { next(e) }
})

requirementsRouter.patch('/requirements/:id/milestones', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'milestone.edit')
    const before = normalizeMilestones(req.milestones_json)
    const result = applyMilestones(before, hr.body || {}, { by: hr.user.name })
    if (!result.ok) {
      const e = new Error(`里程碑时间顺序冲突：${result.issues.map(i => i.message).join('；')}`); e.statusCode = 400; throw e
    }
    run('UPDATE requirements SET milestones_json = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(result.milestones), now(), req.id)
    recordAudit(hr, 'requirement.milestones', 'requirement', req.id, before, result.milestones)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'milestone', message: '更新里程碑时间', payload: { history: result.changed }, actorId: hr.user.id })
    res.json({ ok: true, milestones: milestoneView(result.milestones) })
  } catch (e) { next(e) }
})

requirementsRouter.patch('/requirements/:id/profile', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    const body = hr.body || {}
    const wantsDescription = body.description !== undefined
    const wantsApps = body.apps !== undefined
    const wantsLeads = body.leads !== undefined
    if (!wantsDescription && !wantsApps && !wantsLeads) {
      const e = new Error('请至少提交需求说明、应用功能点或负责人中的一项'); e.statusCode = 400; throw e
    }
    if (wantsDescription || wantsApps) requireAction(role, 'requirement.clarify')
    if (wantsLeads) requireAction(role, 'milestone.edit')

    const nextApps = wantsApps
      ? normalizeApps(body.apps, {
        scopeAll: projectScope(project).all,
        existingApps: parseJson(req.involved_apps_json, [])
      })
      : undefined
    const leadPatch = wantsLeads ? normalizeLeads(body.leads) : undefined
    const description = wantsDescription ? String(body.description ?? '').trim() : undefined

    const before = {
      description: req.description || '',
      apps: appsView(req),
      leads: leadsView(req)
    }
    let milestones = normalizeMilestones(req.milestones_json)
    if (leadPatch && leadPatch.productManager !== undefined) {
      const result = applyMilestones(milestones, { productManager: leadPatch.productManager }, { by: hr.user.name })
      if (!result.ok) {
        const e = new Error(`里程碑时间顺序冲突：${result.issues.map(i => i.message).join('；')}`); e.statusCode = 400; throw e
      }
      milestones = result.milestones
    }
    const leads = { ...(parseJson(req.leads_json, {}) || {}) }
    if (leadPatch) {
      for (const key of ['tech', 'test', 'implementation']) {
        if (leadPatch[key] !== undefined) leads[key] = leadPatch[key]
      }
    }

    const ts = now()
    run(`UPDATE requirements SET description = ?, involved_apps_json = ?, leads_json = ?, milestones_json = ?, updated_at = ?
         WHERE id = ?`,
      description !== undefined ? description : req.description,
      nextApps !== undefined ? JSON.stringify(nextApps) : req.involved_apps_json,
      JSON.stringify(leads), JSON.stringify(milestones), ts, req.id)
    const fresh = get('SELECT * FROM requirements WHERE id = ?', req.id)
    const after = { description: fresh.description || '', apps: appsView(fresh), leads: leadsView(fresh) }
    recordAudit(hr, 'requirement.profile', 'requirement', req.id, before, after)
    logEvent({
      projectId: project.id, requirementId: req.id, type: 'profile',
      message: `更新需求档案：${[wantsDescription && '需求说明', wantsApps && '应用功能点', wantsLeads && '负责人'].filter(Boolean).join('、')}`,
      payload: { after }, actorId: hr.user.id
    })
    res.json({
      ok: true,
      profile: profileView(fresh, { project, users: requirementUsers() }),
      description: fresh.description || '',
      involvedApps: after.apps,
      leads: after.leads
    })
  } catch (e) { next(e) }
})

requirementsRouter.post('/requirements/:id/progress', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    const body = hr.body || {}
    const hasMilestones = body.milestones !== undefined
    const hasLeads = body.leads !== undefined
    const to = body.to || null
    if (!hasMilestones && !hasLeads && !to) {
      const e = new Error('请至少提交状态、里程碑或负责人中的一项'); e.statusCode = 400; throw e
    }
    if (hasMilestones || hasLeads) requireAction(role, 'milestone.edit')
    if (to) {
      if (role === 'developer') {
        requireAction(role, 'status.submit_acceptance')
        if (!DEVELOPER_TARGETS.includes(to)) {
          const e = new Error(`开发角色仅可推进开发与测试相关状态（${DEVELOPER_TARGETS.join('、')}）`); e.statusCode = 403; throw e
        }
      } else requireAction(role, 'status.advance')
    }

    const leadPatch = hasLeads ? normalizeLeads(body.leads) : undefined
    let milestones = normalizeMilestones(req.milestones_json)
    if (hasMilestones) {
      const result = applyMilestones(milestones, body.milestones || {}, { by: hr.user.name })
      if (!result.ok) {
        const e = new Error(`里程碑时间顺序冲突：${result.issues.map(i => i.message).join('；')}`); e.statusCode = 400; throw e
      }
      milestones = result.milestones
    }
    if (leadPatch && leadPatch.productManager !== undefined) {
      const result = applyMilestones(milestones, { productManager: leadPatch.productManager }, { by: hr.user.name })
      if (!result.ok) {
        const e = new Error(`里程碑时间顺序冲突：${result.issues.map(i => i.message).join('；')}`); e.statusCode = 400; throw e
      }
      milestones = result.milestones
    }
    const leads = { ...(parseJson(req.leads_json, {}) || {}) }
    if (leadPatch) {
      for (const key of ['tech', 'test', 'implementation']) {
        if (leadPatch[key] !== undefined) leads[key] = leadPatch[key]
      }
    }
    const working = { ...req, milestones_json: JSON.stringify(milestones), leads_json: JSON.stringify(leads) }
    const before = { status: req.status, milestones: normalizeMilestones(req.milestones_json), leads: parseJson(req.leads_json, {}) }
    let transition = null
    tx(() => {
      if (hasMilestones || hasLeads) {
        run('UPDATE requirements SET milestones_json = ?, leads_json = ?, updated_at = ? WHERE id = ?',
          JSON.stringify(milestones), JSON.stringify(leads), now(), req.id)
      }
      if (to) {
        transition = transitionRequirement({
          req: working, to, note: body.note || '',
          effectiveAt: body.effectiveAt || null, actorId: hr.user.id
        })
        if (!transition.ok) {
          const e = new Error(transition.reason)
          e.statusCode = 400
          e.details = transition.issues || null
          throw e
        }
      }
    })
    const fresh = get('SELECT * FROM requirements WHERE id = ?', req.id)
    recordAudit(hr, 'requirement.progress', 'requirement', req.id, before,
      { status: fresh.status, milestones: normalizeMilestones(fresh.milestones_json), leads: parseJson(fresh.leads_json, {}) })
    if (hasMilestones || hasLeads) {
      logEvent({
        projectId: project.id, requirementId: req.id, type: 'progress',
        message: [hasMilestones && '更新里程碑', hasLeads && '更新负责人'].filter(Boolean).join('、'),
        payload: { milestones: body.milestones || null, leads: leadPatch || null }, actorId: hr.user.id
      })
    }
    res.json({
      ok: true,
      status: fresh.status,
      statusLabel: requirementView(fresh).statusLabel,
      milestones: milestoneView(fresh.milestones_json),
      leads: leadsView(fresh),
      effectiveAt: transition?.effectiveAt || null,
      backfilled: Boolean(transition?.backfilled),
      applied: transition?.milestones || null
    })
  } catch (e) { next(e) }
})

requirementsRouter.post('/requirements/:id/reject', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'requirement.clarify')
    requireFields(hr.body || {}, ['reason'], '退回')
    if (req.status !== '需求调研中') { const e = new Error('仅需求调研中的需求可退回'); e.statusCode = 400; throw e }
    run('UPDATE requirements SET reject_reason = ?, reject_count = reject_count + 1, updated_at = ? WHERE id = ?',
      hr.body.reason, now(), req.id)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'reject', message: `退回澄清：${hr.body.reason}`, payload: { reason: hr.body.reason }, actorId: hr.user.id })
    res.json({ ok: true, rejectCount: req.reject_count + 1 })
  } catch (e) { next(e) }
})

requirementsRouter.post('/requirements/:id/similarity-ignore', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'requirement.intake')
    const similarId = hr.body?.similarId
    const similar = get('SELECT id FROM requirements WHERE id = ? AND project_id = ?', similarId, project.id)
    if (!similar) { const e = new Error('相似需求不存在'); e.statusCode = 404; throw e }
    run('INSERT OR IGNORE INTO similarity_ignores (requirement_id, similar_id, project_id, created_by, created_at) VALUES (?,?,?,?,?)',
      req.id, similar.id, project.id, hr.user.id, now())
    logEvent({ projectId: project.id, requirementId: req.id, type: 'similarity_ignore', message: `忽略与 ${similar.id} 的相似提示`, payload: { similarId: similar.id }, actorId: hr.user.id })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

requirementsRouter.post('/requirements/:id/merge', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'requirement.merge')
    const targetId = hr.body?.targetId
    const target = get('SELECT * FROM requirements WHERE id = ? AND project_id = ?', targetId, project.id)
    if (!target) { const e = new Error('目标需求不存在'); e.statusCode = 404; throw e }
    if (req.status !== '需求调研中' || target.status !== '需求调研中') {
      const e = new Error('仅需求调研中的需求可合并'); e.statusCode = 400; throw e
    }
    const source = parseJson(req.source_json, {})
    const targetSource = parseJson(target.source_json, {})
    targetSource.excerpt = [targetSource.excerpt, source.excerpt].filter(Boolean).join('\n\n')
    targetSource.fullText = [targetSource.fullText, source.fullText].filter(Boolean).join('\n\n')
    targetSource.mergedFrom = [...(targetSource.mergedFrom || []), req.id]
    run('UPDATE requirements SET source_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(targetSource), now(), target.id)
    run("UPDATE requirements SET merged_into = ?, status = '已丢弃', updated_at = ? WHERE id = ?", target.id, now(), req.id)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'merge', message: `合并至 ${target.title}`, payload: { targetId: target.id }, actorId: hr.user.id })
    res.json({ ok: true, targetId: target.id })
  } catch (e) { next(e) }
})

requirementsRouter.post('/requirements/:id/discard', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'requirement.discard')
    requireFields(hr.body || {}, ['reason'], '丢弃')
    if (req.status !== '需求调研中') { const e = new Error('仅需求调研中的需求可丢弃'); e.statusCode = 400; throw e }
    run("UPDATE requirements SET status = '已丢弃', discard_reason = ?, updated_at = ? WHERE id = ?", hr.body.reason, now(), req.id)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'discard', message: `丢弃需求：${hr.body.reason}`, payload: { reason: hr.body.reason }, actorId: hr.user.id })
    recordAudit(hr, 'requirement.discard', 'requirement', req.id, { status: '需求调研中' }, { status: '已丢弃' })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

requirementsRouter.post('/projects/:projectId/requirements/batch-discard', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'requirement.discard')
    const ids = Array.isArray(hr.body?.ids) ? hr.body.ids.filter(x => typeof x === 'string' && x) : []
    if (!ids.length) { const e = new Error('请选择要丢弃的需求'); e.statusCode = 400; throw e }
    if (ids.length > 100) { const e = new Error('单次最多批量丢弃 100 条'); e.statusCode = 400; throw e }
    requireFields(hr.body || {}, ['reason'], '批量丢弃')
    const rows = all(`SELECT * FROM requirements WHERE project_id = ? AND id IN (${ids.map(() => '?').join(',')})`, project.id, ...ids)
    if (rows.length !== new Set(ids).size) { const e = new Error('存在不属于本项目的需求'); e.statusCode = 400; throw e }
    const notClarify = rows.find(r => r.status !== '需求调研中')
    if (notClarify) { const e = new Error(`「${notClarify.title}」不在需求调研中状态，不能丢弃`); e.statusCode = 400; throw e }
    const ts = now()
    tx(() => {
      for (const req of rows) {
        run("UPDATE requirements SET status = '已丢弃', discard_reason = ?, updated_at = ? WHERE id = ?", hr.body.reason, ts, req.id)
        logEvent({ projectId: project.id, requirementId: req.id, type: 'discard', message: `批量丢弃：${hr.body.reason}`, payload: { reason: hr.body.reason, batch: true }, actorId: hr.user.id })
      }
    })
    recordAudit(hr, 'requirement.batch-discard', 'project', project.id, null, { count: rows.length, ids, reason: hr.body.reason })
    res.json({ ok: true, count: rows.length })
  } catch (e) { next(e) }
})

requirementsRouter.post('/requirements/:id/status', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    const to = hr.body?.to
    const note = hr.body?.note || ''
    if (!to) { const e = new Error('缺少目标状态'); e.statusCode = 400; throw e }
    if (role === 'developer') {
      requireAction(role, 'status.submit_acceptance')
      if (!DEVELOPER_TARGETS.includes(to)) {
        const e = new Error(`开发角色仅可推进开发与测试相关状态（${DEVELOPER_TARGETS.join('、')}）`); e.statusCode = 403; throw e
      }
    } else requireAction(role, 'status.advance')
    const result = tx(() => transitionRequirement({
      req, to, note, effectiveAt: hr.body?.effectiveAt || null,
      actorId: hr.user.id, batchId: hr.body?.batchId || null
    }))
    if (!result.ok) { const e = new Error(result.reason); e.statusCode = 400; throw e }
    recordAudit(hr, 'requirement.status', 'requirement', req.id, { status: result.from }, { status: result.to, note, effectiveAt: result.effectiveAt })
    const fresh = get('SELECT milestones_json, status FROM requirements WHERE id = ?', req.id)
    res.json({ ok: true, status: fresh.status, milestones: milestoneView(fresh.milestones_json), effectiveAt: result.effectiveAt, backfilled: result.backfilled })
  } catch (e) { next(e) }
})
