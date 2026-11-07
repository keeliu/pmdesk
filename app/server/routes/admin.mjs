import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { all, get, run, now, uid, parseJson, logEvent } from '../db.mjs'
import { projectFor, requirementFor, requireAction, recordAudit, requirementView, STATUS_INDEX, statusLabel } from '../core.mjs'
import { latestAnalysis } from './analysis.mjs'
import { prototypePageHtml } from '../services/render.mjs'
import { requesterFromSource } from '../services/requester.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const filesDir = path.join(__dirname, '..', '..', 'data', 'files')
fs.mkdirSync(filesDir, { recursive: true })

export const adminRouter = Router()

adminRouter.get('/projects/:projectId/audits', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    if (role !== 'admin' && role !== 'pm') { const e = new Error('仅项目负责人可查看审计日志'); e.statusCode = 403; throw e }
    const { action, objectType, userId, limit } = hr.query
    let sql = `SELECT a.*, u.name AS user_name FROM audits a LEFT JOIN users u ON u.id = a.user_id WHERE a.project_id = ?`
    const params = [project.id]
    if (action) { sql += ' AND a.action LIKE ?'; params.push(`%${action}%`) }
    if (objectType) { sql += ' AND a.object_type = ?'; params.push(objectType) }
    if (userId) { sql += ' AND a.user_id = ?'; params.push(userId) }
    sql += ' ORDER BY a.created_at DESC LIMIT ?'
    params.push(Math.min(Number(limit) || 200, 1000))
    const rows = all(sql, ...params)
    res.json(rows.map(r => ({ ...r, before: parseJson(r.before_json, null), after: parseJson(r.after_json, null) })))
  } catch (e) { next(e) }
})

adminRouter.get('/projects/:projectId/audits/export', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    if (role !== 'admin' && role !== 'pm') { const e = new Error('无权导出审计日志'); e.statusCode = 403; throw e }
    const rows = all(`SELECT a.*, u.name AS user_name FROM audits a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.project_id = ? ORDER BY a.created_at DESC LIMIT 5000`, project.id)
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = ['时间,操作人,动作,对象类型,对象编号,IP,变更前后']
    for (const r of rows) {
      lines.push([r.created_at, r.user_name || '', r.action, r.object_type, r.object_id, r.ip,
        `${r.before_json || ''} -> ${r.after_json || ''}`].map(esc).join(','))
    }
    run('INSERT INTO exports (id, project_id, user_id, type, format, scope_json, created_at) VALUES (?,?,?,?,?,?,?)',
      uid('EXP-'), project.id, hr.user.id, 'audits', 'csv', JSON.stringify({ count: rows.length }), now())
    recordAudit(hr, 'export.audits', 'project', project.id, null, { count: rows.length })
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${project.name}-审计日志.csv`)}`)
    res.send('\ufeff' + lines.join('\n'))
  } catch (e) { next(e) }
})

adminRouter.get('/projects/:projectId/exports', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    const rows = all(`SELECT e.*, u.name AS user_name FROM exports e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.project_id = ? ORDER BY e.created_at DESC LIMIT 100`, project.id)
    res.json(rows.map(r => ({ ...r, scope: parseJson(r.scope_json, {}) })))
  } catch (e) { next(e) }
})

adminRouter.get('/projects/:projectId/shares', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    const rows = all('SELECT * FROM share_links WHERE project_id = ? ORDER BY created_at DESC', project.id)
    res.json(rows.map(r => ({ ...r, expired: Boolean(r.expires_at && Date.parse(r.expires_at) < Date.now()) })))
  } catch (e) { next(e) }
})

adminRouter.post('/projects/:projectId/shares', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'share')
    const b = hr.body || {}
    if (!b.objectId) { const e = new Error('缺少分享对象'); e.statusCode = 400; throw e }
    const days = Number(b.days || 7)
    if (days < 1 || days > 30) { const e = new Error('分享有效期需在 1–30 天之间'); e.statusCode = 400; throw e }
    const token = uid('SH-') + uid('')
    const id = uid('SL-')
    const expires = new Date(Date.now() + days * 86400000).toISOString()
    run('INSERT INTO share_links (id, token, project_id, object_type, object_id, expires_at, created_by, revoked, views, created_at) VALUES (?,?,?,?,?,?,?,0,0,?)',
      id, token, project.id, b.objectType || 'requirement', b.objectId, expires, hr.user.id, now())
    recordAudit(hr, 'share.create', 'share', id, null, { objectType: b.objectType, objectId: b.objectId, expires })
    res.status(201).json({ id, token, expiresAt: expires, url: `/public/${token}` })
  } catch (e) { next(e) }
})

adminRouter.post('/shares/:id/revoke', (hr, res, next) => {
  try {
    const s = get('SELECT * FROM share_links WHERE id = ?', hr.params.id)
    if (!s) { const e = new Error('分享链接不存在'); e.statusCode = 404; throw e }
    const { role } = projectFor(hr.user, s.project_id)
    requireAction(role, 'share')
    run('UPDATE share_links SET revoked = 1 WHERE id = ?', s.id)
    recordAudit(hr, 'share.revoke', 'share', s.id, { revoked: s.revoked }, { revoked: 1 })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

adminRouter.get('/notifications', (hr, res) => {
  const rows = all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', hr.user.id)
  res.json({ unread: rows.filter(r => !r.read).length, items: rows })
})

adminRouter.post('/notifications/read', (hr, res) => {
  if (hr.body?.id) run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', hr.body.id, hr.user.id)
  else run('UPDATE notifications SET read = 1 WHERE user_id = ?', hr.user.id)
  res.json({ ok: true })
})

adminRouter.get('/requirements/:id/source-file', (hr, res, next) => {
  try {
    const { req } = requirementFor(hr.user, hr.params.id)
    const source = parseJson(req.source_json, {})
    if (!source.storedFile) return res.status(404).json({ error: '该需求没有留存原始文件' })
    const filePath = path.join(filesDir, source.storedFile)
    if (!fs.existsSync(filePath)) return res.status(410).json({ error: '原始文件已不可用，来源元数据仍保留' })
    res.download(filePath, source.fileName || 'source')
  } catch (e) { next(e) }
})

adminRouter.get('/projects/:projectId/summary', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    const reqs = all("SELECT * FROM requirements WHERE project_id = ? AND status != '已丢弃'", project.id)
    const count = s => reqs.filter(r => r.status === s).length
    const its = all('SELECT * FROM iterations WHERE project_id = ?', project.id)
    const openSuggestions = get(`SELECT COUNT(*) AS c FROM suggestions s JOIN requirements r ON r.id = s.requirement_id
      WHERE r.project_id = ? AND s.status IN ('待处理','处理中','不采纳待确认')`, project.id).c
    const risky = reqs.filter(r => r.stall_since && Date.now() - Date.parse(r.stall_since) > 7 * 86400000
      && !['全国推广中', '已关闭'].includes(r.status))
    const inDev = reqs.filter(r => {
      const i = STATUS_INDEX[r.status]
      return i !== undefined && i >= STATUS_INDEX['待开发'] && i <= STATUS_INDEX['待上线发版']
    }).length
    const pool = reqs.filter(r => r.code).length
    const offPool = reqs.filter(r => !r.code && r.status !== '需求调研中').length
    const lines = [
      `项目「${project.name}」当前共 ${reqs.length} 条需求，其中需求调研中 ${count('需求调研中')} 条，需求池 ${pool} 条${offPool ? `，另有未入池 ${offPool} 条` : ''}。`,
      `需求分析中 ${count('需求分析中')} 条，需求评审中 ${count('需求评审中')} 条，待需求分析 ${count('待需求分析')} 条。`,
      `开发、测试、UAT 与试点阶段合计 ${inDev} 条，全国推广中 ${count('全国推广中')} 条，挂起 ${count('挂起')} 条。`,
      `未闭环评审建议 ${openSuggestions} 条；停滞超过 7 天的需求 ${risky.length} 条。`,
      `共 ${its.length} 个迭代，其中进行中 ${its.filter(i => i.status === 'active').length} 个。`
    ]
    const statusLines = Object.keys(STATUS_INDEX)
      .filter(s => count(s) > 0)
      .map(s => ({ status: s, label: statusLabel(s), count: count(s) }))
    res.json({ generatedAt: now(), lines, statusLines, metrics: {
      total: reqs.length, inbox: count('需求调研中'), pool,
      analysis: count('需求分析中'), review: count('需求评审中'),
      development: inDev, online: count('全国推广中'), suspended: count('挂起'),
      openSuggestions, stale: risky.length, iterations: its.length
    } })
  } catch (e) { next(e) }
})

adminRouter.get('/projects/:projectId/forms', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    const rows = all("SELECT * FROM share_links WHERE project_id = ? AND object_type = 'form' ORDER BY created_at DESC", project.id)
    res.json(rows.map(r => ({ ...r, expired: Boolean(r.expires_at && Date.parse(r.expires_at) < Date.now()) })))
  } catch (e) { next(e) }
})

adminRouter.post('/projects/:projectId/forms', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'share')
    const days = Number(hr.body?.days || 30)
    if (days < 1 || days > 30) { const e = new Error('表单有效期需在 1–30 天之间'); e.statusCode = 400; throw e }
    const token = uid('FM-') + uid('')
    const id = uid('SL-')
    const expires = new Date(Date.now() + days * 86400000).toISOString()
    run('INSERT INTO share_links (id, token, project_id, object_type, object_id, expires_at, created_by, revoked, views, created_at) VALUES (?,?,?,?,?,?,?,0,0,?)',
      id, token, project.id, 'form', project.id, expires, hr.user.id, now())
    recordAudit(hr, 'form.create', 'share', id, null, { days, expires })
    res.status(201).json({ id, token, expiresAt: expires, url: `/public/form/${token}` })
  } catch (e) { next(e) }
})

export const publicRouter = Router()

function activeShare(token) {
  const s = get('SELECT * FROM share_links WHERE token = ?', token)
  if (!s) { const e = new Error('分享链接无效'); e.statusCode = 404; throw e }
  if (s.revoked) { const e = new Error('分享链接已撤回'); e.statusCode = 410; throw e }
  if (!s.expires_at || Date.parse(s.expires_at) < Date.now()) {
    const e = new Error('分享链接已过期'); e.statusCode = 410; throw e
  }
  return s
}

function activeForm(token) {
  const s = activeShare(token)
  if (s.object_type !== 'form') { const e = new Error('表单链接无效'); e.statusCode = 404; throw e }
  return s
}

publicRouter.get('/forms/:token', (hr, res, next) => {
  try {
    const s = activeForm(hr.params.token)
    const project = get('SELECT * FROM projects WHERE id = ?', s.project_id)
    if (!project) { const e = new Error('表单所属项目不存在'); e.statusCode = 404; throw e }
    res.json({ project: { name: project.name, code: project.code }, expiresAt: s.expires_at })
  } catch (e) { next(e) }
})

publicRouter.post('/forms/:token/submissions', (hr, res, next) => {
  try {
    const s = activeForm(hr.params.token)
    const project = get('SELECT * FROM projects WHERE id = ?', s.project_id)
    const b = hr.body || {}
    const title = String(b.title || '').trim()
    const content = String(b.content || '').trim()
    const submitter = String(b.submitter || '').trim()
    if (!title || !content) { const e = new Error('请填写需求标题与需求内容'); e.statusCode = 400; throw e }
    if (!submitter) { const e = new Error('请填写提交人'); e.statusCode = 400; throw e }
    if (title.length > 120 || content.length > 20000) { const e = new Error('内容超出长度限制'); e.statusCode = 400; throw e }
    const id = uid('REQ-')
    const receipt = uid('RC-')
    const ts = now()
    const source = {
      type: 'form', fileName: '', storedFile: '', excerpt: content.slice(0, 2000), fullText: content,
      submitter, contact: String(b.contact || '').trim(), receipt, formToken: s.token, submitterId: b.submitterId || null
    }
    run(`INSERT INTO requirements (id, project_id, title, status, origin_type, source_json, clarification_json,
         requester_json, involved_apps_json, owner_id, created_at, updated_at, stall_since) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, project.id, title, '需求调研中', 'form', JSON.stringify(source),
      JSON.stringify({ answers: {}, history: [], completed: false }),
      JSON.stringify(requesterFromSource(source, project)), JSON.stringify([]),
      project.owner_id || null, ts, ts, ts)
    logEvent({ projectId: project.id, requirementId: id, type: 'intake', message: `对外表单提交：${title}`, payload: { source: 'form', submitter }, actorId: null })
    recordAudit({ ip: hr.ip, projectId: project.id, user: null }, 'form.submit', 'requirement', id, null, { submitter, title })
    res.status(201).json({ receipt, title, submittedAt: ts })
  } catch (e) { next(e) }
})

publicRouter.get('/forms/:token/submissions/:receipt', (hr, res, next) => {
  try {
    const s = activeForm(hr.params.token)
    const rows = all('SELECT id, title, status, source_json, created_at FROM requirements WHERE project_id = ? AND origin_type = ?', s.project_id, 'form')
    const reqRow = rows.find(r => parseJson(r.source_json, {}).receipt === hr.params.receipt)
    if (!reqRow) { const e = new Error('未找到该回执对应的提交'); e.statusCode = 404; throw e }
    const source = parseJson(reqRow.source_json, {})
    res.json({
      receipt: hr.params.receipt, title: reqRow.title, status: reqRow.status,
      excerpt: source.excerpt || '', submittedAt: reqRow.created_at
    })
  } catch (e) { next(e) }
})

publicRouter.get('/shares/:token/pages/:pageId', (hr, res, next) => {
  try {
    const s = activeShare(hr.params.token)
    const reqRow = get('SELECT * FROM requirements WHERE id = ?', s.object_id)
    const proto = get('SELECT * FROM prototypes WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', s.object_id)
    if (!reqRow || !proto) return res.status(404).send('原型不存在')
    const project = get('SELECT * FROM projects WHERE id = ?', s.project_id)
    const pages = parseJson(proto.pages_json, [])
    const page = pages.find(x => x.id === hr.params.pageId) || pages[0]
    if (!page) return res.status(404).send('页面不存在')
    res.type('html').send(prototypePageHtml(page, {
      projectName: project.name, reqTitle: `${reqRow.code || ''} ${reqRow.title}`.trim(), pages
    }))
  } catch (e) { next(e) }
})

publicRouter.get('/shares/:token', (hr, res, next) => {
  try {
    const s = get('SELECT * FROM share_links WHERE token = ?', hr.params.token)
    if (!s) { const e = new Error('分享链接无效'); e.statusCode = 404; throw e }
    if (s.revoked) { const e = new Error('分享链接已撤回'); e.statusCode = 410; throw e }
    if (!s.expires_at || Date.parse(s.expires_at) < Date.now()) {
      const e = new Error('分享链接已过期'); e.statusCode = 410; throw e
    }
    const reqRow = get('SELECT * FROM requirements WHERE id = ?', s.object_id)
    if (!reqRow) { const e = new Error('分享对象不存在'); e.statusCode = 404; throw e }
    run('UPDATE share_links SET views = views + 1 WHERE id = ?', s.id)
    const project = get('SELECT * FROM projects WHERE id = ?', s.project_id)
    const spec = get("SELECT id, version, html, status, created_at FROM specs WHERE requirement_id = ? ORDER BY version DESC LIMIT 1", reqRow.id)
    const proto = get('SELECT id, version, pages_json, status FROM prototypes WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', reqRow.id)
    const analysis = latestAnalysis(reqRow.id)
    res.json({
      scope: 'readonly',
      expiresAt: s.expires_at,
      project: { name: project.name, code: project.code },
      requirement: {
        code: reqRow.code, title: reqRow.title, status: reqRow.status,
        snapshot: parseJson(reqRow.snapshot_json, null),
        involvedApps: parseJson(reqRow.involved_apps_json, [])
      },
      analysis: analysis.version ? { version: analysis.version, data: analysis.analysis } : null,
      spec: spec ? { version: spec.version, html: spec.html, status: spec.status } : null,
      prototype: proto ? { version: proto.version, status: proto.status, pages: parseJson(proto.pages_json, []) } : null
    })
    recordAudit({ user: null, ip: hr.ip, projectId: s.project_id }, 'share.view', 'share', s.id, null, { token: s.token })
  } catch (e) { next(e) }
})
