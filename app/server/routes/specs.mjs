import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { all, get, run, now, uid, parseJson, logEvent } from '../db.mjs'
import { requirementFor, projectFor, requireAction, recordAudit } from '../core.mjs'
import { checkAnalysis } from '../services/render.mjs'
import { buildRequirementSpec, assertRequirementSpecStructure } from '../services/requirement-spec.mjs'
import {
  collectIterationSources, buildIterationSpec, markIterationSpecsStale,
  iterationSpecView, nextIterationSpecVersion, newIterationSpecId
} from '../services/iteration-spec.mjs'
import { buildRequirementDocx, buildIterationDocx } from '../services/docx-render.mjs'
import { resolveDocumentSkill } from '../services/skills.mjs'
import { assertSpecSafety, assertSpecStructure } from '../services/spec-template.mjs'
import { renderPdf } from '../services/pdf.mjs'
import { latestAnalysis } from './analysis.mjs'
import { filesDir } from './admin.mjs'
import ExcelJS from 'exceljs'

export const specsRouter = Router()

function latestProto(reqId) {
  return get('SELECT * FROM prototypes WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', reqId)
}

function specContext(req) {
  const project = get('SELECT * FROM projects WHERE id = ?', req.project_id)
  const latest = latestAnalysis(req.id)
  const proto = latestProto(req.id)
  const pages = proto ? parseJson(proto.pages_json, []) : []
  const reviews = all('SELECT * FROM reviews WHERE requirement_id = ? ORDER BY round', req.id)
  const changes = all('SELECT * FROM changes WHERE requirement_id = ? ORDER BY seq', req.id)
  return { project, analysis: latest.analysis, analysisVersion: latest.version, proto, pages, reviews, changes }
}

specsRouter.get('/requirements/:id/specs', (hr, res, next) => {
  try {
    const { req } = requirementFor(hr.user, hr.params.id)
    const rows = all(`SELECT s.id, s.version, s.status, s.analysis_version, s.prototype_version, s.created_at,
      s.skill_slug, s.skill_version, u.name AS created_by_name
      FROM specs s LEFT JOIN users u ON u.id = s.created_by WHERE s.requirement_id = ? ORDER BY s.version DESC`, req.id)
    res.json(rows.map(r => ({
      ...r,
      skill: r.skill_slug ? { slug: r.skill_slug, version: r.skill_version } : null,
      legacy: !r.skill_slug
    })))
  } catch (e) { next(e) }
})

specsRouter.post('/requirements/:id/specs/generate', (hr, res, next) => {
  try {
    const { req, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'spec.publish')
    const ctx = specContext(req)
    if (!ctx.analysisVersion) { const e = new Error('缺少分析版本'); e.statusCode = 400; throw e }
    if (!ctx.proto || ctx.proto.status !== 'confirmed') {
      const e = new Error('原型尚未确认，无法写入说明书'); e.statusCode = 400; throw e
    }
    const last = get('SELECT * FROM specs WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', req.id)
    const version = (last?.version || 0) + 1
    const resolution = resolveDocumentSkill({
      projectId: req.project_id,
      bindingId: hr.body?.skillBindingId,
      previousBindingId: last?.skill_binding_id || null
    })
    const skill = resolution.view
    const proposals = all('SELECT action, status, applied_at FROM proposals WHERE requirement_id = ? ORDER BY created_at', req.id)
    const quality = checkAnalysis(ctx.analysis, req, ctx.project)
    const flowchartRows = all(`SELECT analysis_version, renderer, skill_slug, skill_version, updated_at
      FROM flowcharts WHERE requirement_id = ? ORDER BY analysis_version DESC`, req.id)
    const built = buildRequirementSpec({
      req, project: ctx.project, analysis: ctx.analysis, analysisVersion: ctx.analysisVersion,
      pages: ctx.pages, reviews: ctx.reviews, changes: ctx.changes, proposals, version,
      proto: ctx.proto, flowchartRows, quality,
      skill: { artifactTemplate: skill.artifactTemplate, slug: skill.slug, version: skill.version }
    })
    assertRequirementSpecStructure(built.html, { code: req.code })
    assertSpecSafety(built.html)
    const id = uid('SPEC-')
    run(`INSERT INTO specs (id, requirement_id, version, markdown, html, analysis_version, prototype_version, status,
         created_by, created_at, updated_at, skill_binding_id, skill_slug, skill_version, template_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, req.id, version, built.markdown, built.html, ctx.analysisVersion, ctx.proto.version, 'draft',
      hr.user.id, now(), now(), skill.id, skill.slug, skill.version, built.templateHash)
    run(`INSERT INTO llm_calls (id, project_id, requirement_id, skill_slug, stage, trigger_type, provider, model,
         prompt_tokens, completion_tokens, cost, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid('LLM-'), req.project_id, req.id, skill.slug, 'spec', 'document', 'skill-runtime', `v${skill.version}`,
      0, 0, 0, 'success', now())
    const staled = markIterationSpecsStale(req.id)
    logEvent({
      projectId: req.project_id, requirementId: req.id, type: 'spec',
      message: `生成说明书 V${version} · 技能 ${skill.name} V${skill.version}`,
      payload: { version, skill: `${skill.slug}@${skill.version}`, templateHash: built.templateHash, staledIterationSpecs: staled },
      actorId: hr.user.id
    })
    recordAudit(hr, 'spec.generate', 'spec', id, null, {
      version, skillSlug: skill.slug, skillVersion: skill.version, templateHash: built.templateHash
    })
    res.status(201).json({
      id, version, status: 'draft',
      skill: skillPayload(skill),
      skillFallbackFrom: resolution.fallbackFrom || null
    })
  } catch (e) { next(e) }
})

specsRouter.get('/specs/:id', (hr, res, next) => {
  try {
    const s = get('SELECT * FROM specs WHERE id = ?', hr.params.id)
    if (!s) { const e = new Error('说明书不存在'); e.statusCode = 404; throw e }
    const { req } = requirementFor(hr.user, s.requirement_id)
    res.json({ ...s, requirement: { id: req.id, code: req.code, title: req.title, status: req.status } })
  } catch (e) { next(e) }
})

specsRouter.get('/specs/:id/preview', (hr, res, next) => {
  try {
    const s = get('SELECT * FROM specs WHERE id = ?', hr.params.id)
    if (!s) return res.status(404).send('说明书不存在')
    requirementFor(hr.user, s.requirement_id)
    if (!s.html) return res.status(500).send('说明书产物缺失')
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(`说明书-V${s.version}.html`)}`)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    res.send(s.html)
  } catch (e) { next(e) }
})

specsRouter.post('/specs/:id/publish', (hr, res, next) => {
  try {
    const s = get('SELECT * FROM specs WHERE id = ?', hr.params.id)
    if (!s) { const e = new Error('说明书不存在'); e.statusCode = 404; throw e }
    const { req, project, role } = requirementFor(hr.user, s.requirement_id)
    requireAction(role, 'spec.publish')
    if (s.status === 'published') return res.json({ ok: true, already: true })
    run("UPDATE specs SET status = 'published', updated_at = ? WHERE id = ?", now(), s.id)
    run("UPDATE specs SET status = 'superseded' WHERE requirement_id = ? AND id != ? AND status = 'published'", req.id, s.id)
    if (['待需求分析', '需求分析中'].includes(req.status)) {
      run("UPDATE requirements SET status = '需求评审中', stall_since = ?, updated_at = ? WHERE id = ?", now(), now(), req.id)
      logEvent({ projectId: project.id, requirementId: req.id, type: 'status', message: '需求分析中 → 需求评审中', payload: { from: req.status, to: '需求评审中' }, actorId: hr.user.id })
    }
    const staled = markIterationSpecsStale(req.id)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'spec-publish', message: `发布说明书 V${s.version}`, payload: { version: s.version, staledIterationSpecs: staled }, actorId: hr.user.id })
    recordAudit(hr, 'spec.publish', 'spec', s.id, { status: s.status }, { status: 'published' })
    res.json({ ok: true, version: s.version })
  } catch (e) { next(e) }
})

specsRouter.get('/specs/:id/docx', async (hr, res, next) => {
  try {
    const s = get('SELECT * FROM specs WHERE id = ?', hr.params.id)
    if (!s) { const e = new Error('说明书不存在'); e.statusCode = 404; throw e }
    const { req, project } = requirementFor(hr.user, s.requirement_id)
    const proto = get('SELECT * FROM prototypes WHERE requirement_id = ? AND version = ?', req.id, s.prototype_version)
    const pages = proto ? parseJson(proto.pages_json, []) : []
    const reviews = all('SELECT * FROM reviews WHERE requirement_id = ? ORDER BY round', req.id)
    const changes = all('SELECT * FROM changes WHERE requirement_id = ? ORDER BY seq', req.id)
    const buf = await buildRequirementDocx({
      req, project, analysis: JSON.parse(get('SELECT analysis_json FROM requirement_versions WHERE requirement_id = ? AND version = ?', req.id, s.analysis_version)?.analysis_json || '{}'),
      pages, version: s.version, reviews, changes
    })
    run('INSERT INTO exports (id, project_id, user_id, type, format, scope_json, created_at) VALUES (?,?,?,?,?,?,?)',
      uid('EXP-'), project.id, hr.user.id, 'spec', 'docx',
      JSON.stringify({
        specId: s.id, version: s.version,
        skillSlug: s.skill_slug || null, skillVersion: s.skill_version || null
      }), now())
    recordAudit(hr, 'export.spec', 'spec', s.id, null, {
      format: 'docx', skillSlug: s.skill_slug || null, skillVersion: s.skill_version || null
    })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${req.code || '需求'}-说明书-V${s.version}.docx`)}`)
    res.send(buf)
  } catch (e) { next(e) }
})

function iterationForUser(user, projectId, iterationId) {
  const { project, role } = projectFor(user, projectId)
  const iteration = get('SELECT * FROM iterations WHERE id = ? AND project_id = ?', iterationId, project.id)
  if (!iteration) { const e = new Error('迭代不存在'); e.statusCode = 404; throw e }
  return { project, role, iteration }
}

function iterationSpecFor(user, id) {
  const row = get('SELECT * FROM iteration_specs WHERE id = ?', id)
  if (!row) { const e = new Error('迭代说明书不存在'); e.statusCode = 404; throw e }
  const { project, role } = projectFor(user, row.project_id)
  if (role === 'guest' && row.status === 'draft') {
    const e = new Error('访客仅可查看已发布的迭代说明书'); e.statusCode = 403; throw e
  }
  const iteration = get('SELECT * FROM iterations WHERE id = ?', row.iteration_id)
  return { row, project, role, iteration }
}

function assertIterationSpecConsistent(row) {
  const html = row.html || ''
  const source = parseJson(row.source_json, {})
  const expected = row.requirement_count || (source.requirements || []).length
  assertSpecStructure(html, { requirementCount: expected })
  assertSpecSafety(html)
  return { chapterCount: expected, expected }
}

function persistIterationDocx(id, buffer) {
  const file = `${id}.docx`
  fs.writeFileSync(path.join(filesDir, file), buffer)
  return {
    file,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  }
}

function removeIterationDocx(file) {
  if (!file || path.basename(file) !== file) return
  try { fs.unlinkSync(path.join(filesDir, file)) } catch { /* 文件已不存在 */ }
}

function iterationDocxPath(file) {
  if (!file || path.basename(file) !== file) return null
  const full = path.join(filesDir, file)
  return fs.existsSync(full) ? full : null
}

function skillPayload(skill) {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    version: skill.version,
    sourceType: skill.sourceType,
    sourceProject: skill.sourceProject,
    isBuiltin: skill.isBuiltin
  }
}

specsRouter.get('/projects/:projectId/iterations/:iterationId/specs', (hr, res, next) => {
  try {
    const { role } = iterationForUser(hr.user, hr.params.projectId, hr.params.iterationId)
    const rows = all(`SELECT id, version, mode, status, requirement_count, missing_json, stale, created_by, created_at,
      skill_binding_id, skill_slug, skill_version, docx_size, docx_sha256
      FROM iteration_specs WHERE iteration_id = ? ORDER BY version DESC`, hr.params.iterationId)
    const visible = role === 'guest' ? rows.filter(r => r.status !== 'draft') : rows
    res.json(visible.map(r => ({
      ...r,
      missing: parseJson(r.missing_json, []),
      skill: r.skill_slug ? { slug: r.skill_slug, version: r.skill_version } : null,
      docxSize: r.docx_size || null
    })))
  } catch (e) { next(e) }
})

specsRouter.post('/projects/:projectId/iterations/:iterationId/specs/generate', async (hr, res, next) => {
  try {
    const { project, role, iteration } = iterationForUser(hr.user, hr.params.projectId, hr.params.iterationId)
    requireAction(role, 'iteration.spec.generate')
    const body = hr.body || {}
    const mode = body.mode === 'formal' ? 'formal' : 'draft'
    const reqRows = all("SELECT * FROM requirements WHERE iteration_id = ? AND status NOT IN ('需求调研中','已丢弃') ORDER BY created_at", iteration.id)
    if (!reqRows.length) {
      const e = new Error('迭代内没有可纳入的需求，请先完成需求排期与确认'); e.statusCode = 400; throw e
    }
    const previous = get(`SELECT skill_binding_id FROM iteration_specs
      WHERE iteration_id = ? AND skill_binding_id IS NOT NULL ORDER BY version DESC LIMIT 1`, iteration.id)
    const resolution = resolveDocumentSkill({
      projectId: project.id,
      bindingId: body.skillBindingId,
      previousBindingId: previous?.skill_binding_id
    })
    const skill = resolution.view
    const items = collectIterationSources({ project, requirements: reqRows })
    const version = nextIterationSpecVersion(iteration.id)
    const built = buildIterationSpec({
      project, iteration, items, version, mode,
      skill: { artifactTemplate: skill.artifactTemplate }
    })
    assertSpecStructure(built.html, { requirementCount: built.requirementCount })
    assertSpecSafety(built.html)

    const id = newIterationSpecId()
    const status = mode === 'formal' ? 'published' : 'draft'
    let stored = null
    try {
      const docxRow = {
        version, mode,
        source_json: JSON.stringify(built.source),
        requirement_count: built.requirementCount,
        missing_json: JSON.stringify(built.missing)
      }
      const docx = await buildIterationDocx({ project, iteration, row: docxRow })
      stored = persistIterationDocx(id, docx)
      run(`INSERT INTO iteration_specs (id, project_id, iteration_id, version, mode, status, html, markdown, source_json,
           requirement_count, missing_json, stale, created_by, created_at, updated_at,
           skill_binding_id, skill_slug, skill_version, template_hash, docx_file, docx_size, docx_sha256)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, project.id, iteration.id, version, mode, status, built.html, built.markdown, JSON.stringify(built.source),
        built.requirementCount, JSON.stringify(built.missing), 0, hr.user.id, now(), now(),
        skill.id, skill.slug, skill.version, built.templateHash, stored.file, stored.size, stored.sha256)
    } catch (e) {
      removeIterationDocx(stored?.file)
      if (!e.statusCode) {
        e.statusCode = 500
        e.code = 'SPEC_ARTIFACT_FAILED'
        e.details = { skill: `${skill.slug}@${skill.version}` }
      }
      throw e
    }
    run(`INSERT INTO llm_calls (id, project_id, requirement_id, skill_slug, stage, trigger_type, provider, model,
         prompt_tokens, completion_tokens, cost, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      uid('LLM-'), project.id, null, skill.slug, 'spec', 'document', 'skill-runtime', `v${skill.version}`,
      0, 0, 0, 'success', now())
    logEvent({
      projectId: project.id, type: 'iteration-spec',
      message: `生成迭代说明书「${iteration.name}」V${version}（${mode === 'formal' ? '正式版' : '草稿版'}）· 技能 ${skill.name} V${skill.version}`,
      payload: {
        iterationSpecId: id, version, mode, requirementCount: built.requirementCount,
        skill: `${skill.slug}@${skill.version}`, templateHash: built.templateHash,
        docxSize: stored.size, docxSha256: stored.sha256
      },
      actorId: hr.user.id
    })
    recordAudit(hr, 'iteration.spec.generate', 'iteration', iteration.id, null, {
      specId: id, version, mode, requirementCount: built.requirementCount,
      skillSlug: skill.slug, skillVersion: skill.version, templateHash: built.templateHash,
      docxSize: stored.size, docxSha256: stored.sha256
    })
    res.status(201).json({
      id, version, mode, status,
      requirementCount: built.requirementCount,
      missing: built.missing,
      skill: skillPayload(skill),
      skillFallbackFrom: resolution.fallbackFrom || null,
      artifacts: { html: true, docx: { size: stored.size, sha256: stored.sha256 } }
    })
  } catch (e) { next(e) }
})

specsRouter.get('/iteration-specs/:id', (hr, res, next) => {
  try {
    const { row } = iterationSpecFor(hr.user, hr.params.id)
    const view = iterationSpecView(row)
    delete view.html
    delete view.markdown
    delete view.docx_file
    res.json(view)
  } catch (e) { next(e) }
})

specsRouter.get('/iteration-specs/:id/preview', (hr, res, next) => {
  try {
    const { row } = iterationSpecFor(hr.user, hr.params.id)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(`迭代说明书-V${row.version}.html`)}`)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    res.send(row.html)
  } catch (e) { next(e) }
})

specsRouter.get('/iteration-specs/:id/markdown', (hr, res, next) => {
  try {
    const { row, iteration } = iterationSpecFor(hr.user, hr.params.id)
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${iteration?.name || '迭代'}-需求分析说明书-V${row.version}.md`)}`)
    res.send(row.markdown || '')
  } catch (e) { next(e) }
})

specsRouter.get('/iteration-specs/:id/docx', async (hr, res, next) => {
  try {
    const { row, project, iteration } = iterationSpecFor(hr.user, hr.params.id)
    assertIterationSpecConsistent(row)
    const fixed = iterationDocxPath(row.docx_file)
    let buf
    let fallback = false
    if (fixed) {
      buf = fs.readFileSync(fixed)
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
      if ((row.docx_size && buf.length !== row.docx_size) || (row.docx_sha256 && sha256 !== row.docx_sha256)) {
        const e = new Error('Word 文件与生成记录不一致，已阻止导出')
        e.statusCode = 500
        e.code = 'SPEC_ARTIFACT_FAILED'
        e.details = { expectedSize: row.docx_size, actualSize: buf.length, expectedSha256: row.docx_sha256, actualSha256: sha256 }
        throw e
      }
    } else if (row.docx_file || row.docx_sha256) {
      const e = new Error('该版本的 Word 产物已缺失，无法导出')
      e.statusCode = 500
      e.code = 'SPEC_ARTIFACT_FAILED'
      e.details = { version: row.version, docxFile: row.docx_file || null }
      throw e
    } else {
      fallback = true
      buf = await buildIterationDocx({ project, iteration, row })
    }
    const sha256 = row.docx_sha256 || crypto.createHash('sha256').update(buf).digest('hex')
    run('INSERT INTO exports (id, project_id, user_id, type, format, scope_json, created_at) VALUES (?,?,?,?,?,?,?)',
      uid('EXP-'), project.id, hr.user.id, 'iteration-spec', 'docx',
      JSON.stringify({
        iterationSpecId: row.id, iterationId: row.iteration_id, version: row.version,
        requirementCount: row.requirement_count, skillSlug: row.skill_slug || null,
        skillVersion: row.skill_version || null, docxSha256: sha256, fallback
      }), now())
    recordAudit(hr, 'export.iteration-spec', 'iteration', row.iteration_id, null, {
      specId: row.id, version: row.version, format: 'docx',
      skillSlug: row.skill_slug || null, skillVersion: row.skill_version || null,
      docxSha256: sha256, fallback
    })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${iteration?.name || '迭代'}-迭代需求分析说明书-V${row.version}.docx`)}`)
    res.setHeader('X-Spec-Fallback', fallback ? 'true' : 'false')
    res.send(buf)
  } catch (e) { next(e) }
})

specsRouter.get('/iteration-specs/:id/pdf', (hr, res, next) => {
  try {
    const { row, project, iteration } = iterationSpecFor(hr.user, hr.params.id)
    const counts = assertIterationSpecConsistent(row)
    const buf = renderPdf(row.html)
    run('INSERT INTO exports (id, project_id, user_id, type, format, scope_json, created_at) VALUES (?,?,?,?,?,?,?)',
      uid('EXP-'), project.id, hr.user.id, 'iteration-spec', 'pdf',
      JSON.stringify({ iterationSpecId: row.id, iterationId: row.iteration_id, version: row.version, requirementCount: row.requirement_count, chapters: counts.chapterCount }), now())
    recordAudit(hr, 'export.iteration-spec', 'iteration', row.iteration_id, null, { specId: row.id, version: row.version, format: 'pdf' })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${iteration?.name || '迭代'}-迭代需求分析说明书-V${row.version}.pdf`)}`)
    res.send(buf)
  } catch (e) { next(e) }
})

specsRouter.get('/projects/:projectId/requirements-export.xlsx', async (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'export')
    const rows = all("SELECT * FROM requirements WHERE project_id = ? AND status NOT IN ('已丢弃') ORDER BY created_at", project.id)
    const users = all('SELECT id, name FROM users')
    const its = all('SELECT id, name FROM iterations WHERE project_id = ?', project.id)
    const wb = new ExcelJS.Workbook()
    wb.creator = '需求管理工作台'
    const ws = wb.addWorksheet('需求清单')
    ws.columns = [
      { header: '需求编号', key: 'code', width: 20 },
      { header: '需求标题', key: 'title', width: 40 },
      { header: '状态', key: 'status', width: 12 },
      { header: '负责人', key: 'owner', width: 14 },
      { header: '迭代', key: 'iteration', width: 18 },
      { header: '涉及应用', key: 'apps', width: 30 },
      { header: '优先级', key: 'priority', width: 10 },
      { header: '工作量(人日)', key: 'days', width: 14 },
      { header: '更新时间', key: 'updated', width: 22 }
    ]
    ws.getRow(1).font = { bold: true }
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F7' } }
    for (const r of rows) {
      const pr = parseJson(r.priority_json, {})
      const apps = parseJson(r.involved_apps_json, []).map(a => a.name || a).join('、')
      ws.addRow({
        code: r.code || '未编号', title: r.title, status: r.status,
        owner: users.find(u => u.id === r.owner_id)?.name || '',
        iteration: its.find(i => i.id === r.iteration_id)?.name || '未排期',
        apps, priority: pr.grade || '', days: pr.estimateDays || '',
        updated: r.updated_at.slice(0, 19).replace('T', ' ')
      })
    }
    ws.eachRow((row, i) => {
      row.eachCell(c => { c.border = { top: { style: 'thin', color: { argb: 'FFD9DDE3' } }, bottom: { style: 'thin', color: { argb: 'FFD9DDE3' } }, left: { style: 'thin', color: { argb: 'FFD9DDE3' } }, right: { style: 'thin', color: { argb: 'FFD9DDE3' } } } })
    })
    const ws2 = wb.addWorksheet('迭代汇总')
    ws2.columns = [{ header: '迭代', key: 'name', width: 20 }, { header: '目标', key: 'goal', width: 40 }, { header: '容量(人日)', key: 'cap', width: 12 }, { header: '已排(人日)', key: 'used', width: 12 }, { header: '状态', key: 'status', width: 12 }]
    ws2.getRow(1).font = { bold: true }
    for (const it of its) {
      const used = all('SELECT priority_json FROM requirements WHERE iteration_id = ?', it.id)
        .reduce((s, x) => s + (parseJson(x.priority_json, {})?.estimateDays || 0), 0)
      ws2.addRow({ name: it.name, goal: it.goal, cap: it.capacity_days, used, status: it.status })
    }
    run('INSERT INTO exports (id, project_id, user_id, type, format, scope_json, created_at) VALUES (?,?,?,?,?,?,?)',
      uid('EXP-'), project.id, hr.user.id, 'requirements', 'xlsx', JSON.stringify({ count: rows.length }), now())
    recordAudit(hr, 'export.requirements', 'project', project.id, null, { count: rows.length })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${project.name}-需求清单.xlsx`)}`)
    await wb.xlsx.write(res)
    res.end()
  } catch (e) { next(e) }
})
