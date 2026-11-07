import { Router } from 'express'
import { all, get, run, now, uid, parseJson, logEvent } from '../db.mjs'
import { requirementFor, requireAction, recordAudit } from '../core.mjs'
import { buildPrototypePages, prototypePageHtml, normalizeAnalysis, checkAnalysis } from '../services/render.mjs'
import { latestAnalysis, saveAnalysis } from './analysis.mjs'

export const prototypesRouter = Router()

function latestProto(reqId) {
  return get('SELECT * FROM prototypes WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', reqId)
}

function protoView(p) {
  return { ...p, pages: parseJson(p.pages_json, []) }
}

function projectOfReq(req) {
  return get('SELECT * FROM projects WHERE id = ?', req.project_id)
}

prototypesRouter.get('/requirements/:id/prototypes', (hr, res, next) => {
  try {
    const { req } = requirementFor(hr.user, hr.params.id)
    const rows = all(`SELECT p.*, u.name AS created_by_name FROM prototypes p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.requirement_id = ? ORDER BY p.version DESC`, req.id)
    res.json(rows.map(r => ({ ...protoView(r), createdByName: r.created_by_name })))
  } catch (e) { next(e) }
})

prototypesRouter.post('/requirements/:id/prototypes/generate', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'prototype.generate')
    if (!['待需求分析', '需求分析中'].includes(req.status)) {
      const e = new Error(`当前状态为「${req.status}」，不能生成原型`); e.statusCode = 400; throw e
    }
    const latest = latestAnalysis(req.id)
    if (!latest.version) { const e = new Error('尚未提交分析，无法生成原型'); e.statusCode = 400; throw e }
    const check = checkAnalysis(latest.analysis, req, project)
    if (!check.ok) {
      const e = new Error('分析未通过校验，无法生成原型'); e.statusCode = 400; e.details = check.issues; throw e
    }
    const pages = buildPrototypePages(latest.analysis, req)
    const last = latestProto(req.id)
    const version = (last?.version || 0) + 1
    const id = uid('PT-')
    run('INSERT INTO prototypes (id, requirement_id, version, pages_json, status, analysis_version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, req.id, version, JSON.stringify(pages), 'draft', latest.version, hr.user.id, now(), now())
    if (req.status === '待需求分析') {
      run("UPDATE requirements SET status = '需求分析中', stall_since = ?, updated_at = ? WHERE id = ?", now(), now(), req.id)
      logEvent({ projectId: project.id, requirementId: req.id, type: 'status', message: '待需求分析 → 需求分析中', payload: { from: '待需求分析', to: '需求分析中' }, actorId: hr.user.id })
    }
    logEvent({ projectId: project.id, requirementId: req.id, type: 'prototype', message: `生成原型 V${version}，共 ${pages.length} 页`, payload: { version, pages: pages.length }, actorId: hr.user.id })
    recordAudit(hr, 'prototype.generate', 'prototype', id, null, { version, pages: pages.length })
    res.status(201).json({ id, version, pages, status: 'draft' })
  } catch (e) { next(e) }
})

prototypesRouter.get('/prototypes/:id', (hr, res, next) => {
  try {
    const p = get('SELECT * FROM prototypes WHERE id = ?', hr.params.id)
    if (!p) { const e = new Error('原型不存在'); e.statusCode = 404; throw e }
    const { req } = requirementFor(hr.user, p.requirement_id)
    res.json({ ...protoView(p), requirement: { id: req.id, code: req.code, title: req.title, status: req.status } })
  } catch (e) { next(e) }
})

prototypesRouter.get('/prototypes/:id/page/:pageId', (hr, res, next) => {
  try {
    const p = get('SELECT * FROM prototypes WHERE id = ?', hr.params.id)
    if (!p) return res.status(404).send('原型不存在')
    const { req } = requirementFor(hr.user, p.requirement_id)
    const project = projectOfReq(req)
    const pages = parseJson(p.pages_json, [])
    const page = pages.find(x => x.id === hr.params.pageId) || pages[0]
    if (!page) return res.status(404).send('页面不存在')
    res.type('html').send(prototypePageHtml(page, {
      projectName: project.name, reqTitle: `${req.code || ''} ${req.title}`.trim(), pages
    }))
  } catch (e) { next(e) }
})

prototypesRouter.post('/prototypes/:id/revise', (hr, res, next) => {
  try {
    const p = get('SELECT * FROM prototypes WHERE id = ?', hr.params.id)
    if (!p) { const e = new Error('原型不存在'); e.statusCode = 404; throw e }
    const { req, project, role } = requirementFor(hr.user, p.requirement_id)
    requireAction(role, 'prototype.generate')
    const instruction = String(hr.body?.instruction || '').trim()
    if (!instruction) { const e = new Error('请描述需要调整的内容'); e.statusCode = 400; throw e }
    const pages = parseJson(p.pages_json, [])
    const changes = []
    const targetId = hr.body?.pageId

    const rename = instruction.match(/(?:页面|标题)?\s*(?:改名|改为|名称改为|标题改为)[「“"]?([^」”"，。]{2,20})[」”"]?/)
    const addMatch = instruction.match(/(?:新增|增加|添加)(?:一个|1个)?(?:页面|功能)[「“"]?([^」”"，。]{2,20})[」”"]?/)
    const delMatch = instruction.match(/(?:删除|去掉)(?:页面|功能)?[「“"]?([^」”"，。]{2,20})[」”"]?/)

    if (delMatch) {
      const idx = pages.findIndex(x => x.name.includes(delMatch[1]) && x.kind !== 'overview')
      if (idx >= 0) { const [removed] = pages.splice(idx, 1); changes.push(`删除页面「${removed.name}」`) }
    }
    if (addMatch) {
      const name = addMatch[1]
      pages.push({
        id: 'p-' + Date.now().toString(36), name, layout: /表单|配置|录入/.test(name) ? 'form' : /看板|报表|统计/.test(name) ? 'dashboard' : 'list',
        subtitle: '由会话调整新增', functions: [name], kind: 'function', states: ['default', 'empty', 'loading', 'error', 'forbidden']
      })
      changes.push(`新增页面「${name}」`)
    }
    if (rename) {
      const target = pages.find(x => x.id === targetId) || pages.find(x => x.kind === 'function') || pages[0]
      const old = target.name
      target.name = rename[1]
      changes.push(`页面「${old}」改名为「${target.name}」`)
    }
    const layoutMap = [['表格|列表', 'list'], ['卡片|看板', 'dashboard'], ['表单|录入', 'form'], ['详情', 'detail']]
    for (const [kw, layout] of layoutMap) {
      if (new RegExp(`(?:改为|改成|使用)${kw}`).test(instruction)) {
        const target = pages.find(x => x.id === targetId) || pages.find(x => x.kind === 'function') || pages[0]
        target.layout = layout
        changes.push(`「${target.name}」布局改为 ${layout}`)
      }
    }
    if (!changes.length) {
      const target = pages.find(x => x.id === targetId) || pages.find(x => x.kind === 'function') || pages[0]
      target.subtitle = `${target.subtitle || ''}${target.subtitle ? ' · ' : ''}${instruction.slice(0, 60)}`
      changes.push(`更新「${target.name}」说明`)
    }

    const latest = latestAnalysis(req.id)
    const analysis = normalizeAnalysis(latest.analysis)
    analysis.meta.revisionNotes = [...(analysis.meta.revisionNotes || []), { instruction, at: now(), by: hr.user.name, changes }]
    for (const c of changes) {
      const m = c.match(/「([^」]+)」/)
      if (!m) continue
      const fn = analysis.functions.list.find(f => f.name === m[1] || c.includes(f.name))
      if (fn && c.includes('说明')) fn.acceptance = `${fn.acceptance || ''}（原型调整：${instruction}）`
    }
    const saved = saveAnalysis({ req, project, user: hr.user, analysis, note: `原型改稿同步：${instruction.slice(0, 40)}`, source: 'prototype-revision' })

    const last = latestProto(req.id)
    const version = (last?.version || 0) + 1
    const id = uid('PT-')
    run('INSERT INTO prototypes (id, requirement_id, version, pages_json, status, analysis_version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, req.id, version, JSON.stringify(pages), 'draft', saved.version, hr.user.id, now(), now())
    logEvent({ projectId: project.id, requirementId: req.id, type: 'prototype-revise', message: `原型改稿 V${version}：${instruction.slice(0, 60)}`, payload: { changes, version }, actorId: hr.user.id })
    recordAudit(hr, 'prototype.revise', 'prototype', id, { version: p.version }, { version, changes })
    res.json({ id, version, pages, changes, analysisVersion: saved.version })
  } catch (e) { next(e) }
})

prototypesRouter.post('/prototypes/:id/confirm', (hr, res, next) => {
  try {
    const p = get('SELECT * FROM prototypes WHERE id = ?', hr.params.id)
    if (!p) { const e = new Error('原型不存在'); e.statusCode = 404; throw e }
    const { req, project, role } = requirementFor(hr.user, p.requirement_id)
    requireAction(role, 'prototype.confirm')
    if (p.status === 'confirmed') return res.json({ ok: true, already: true })
    const pages = parseJson(p.pages_json, [])
    const bad = pages.filter(pg => !(pg.states || []).length)
    if (bad.length) { const e = new Error('存在未覆盖状态的页面，无法确认'); e.statusCode = 400; throw e }
    run("UPDATE prototypes SET status = 'confirmed', updated_at = ? WHERE id = ?", now(), p.id)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'prototype-confirm', message: `确认原型 V${p.version}`, payload: { version: p.version }, actorId: hr.user.id })
    recordAudit(hr, 'prototype.confirm', 'prototype', p.id, { status: p.status }, { status: 'confirmed' })
    res.json({ ok: true, version: p.version })
  } catch (e) { next(e) }
})

prototypesRouter.get('/prototypes/:id/compare', (hr, res, next) => {
  try {
    const p = get('SELECT * FROM prototypes WHERE id = ?', hr.params.id)
    if (!p) { const e = new Error('原型不存在'); e.statusCode = 404; throw e }
    requirementFor(hr.user, p.requirement_id)
    const other = get('SELECT * FROM prototypes WHERE requirement_id = ? AND version = ?', p.requirement_id, Number(hr.query.from || p.version - 1))
    if (!other) { const e = new Error('对比版本不存在'); e.statusCode = 404; throw e }
    const a = parseJson(p.pages_json, []), b = parseJson(other.pages_json, [])
    const namesA = new Map(a.map(x => [x.id, x])), namesB = new Map(b.map(x => [x.id, x]))
    const added = a.filter(x => !namesB.has(x.id)).map(x => x.name)
    const removed = b.filter(x => !namesA.has(x.id)).map(x => x.name)
    const changed = a.filter(x => namesB.has(x.id) && JSON.stringify(x) !== JSON.stringify(namesB.get(x.id))).map(x => x.name)
    res.json({ from: other.version, to: p.version, added, removed, changed, unchanged: a.length - added.length - changed.length })
  } catch (e) { next(e) }
})
