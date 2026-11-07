import { Router } from 'express'
import { all, get, run, now, uid, parseJson, logEvent } from '../db.mjs'
import { requirementFor, requireAction, recordAudit } from '../core.mjs'
import { normalizeAnalysis, checkAnalysis, emptyAnalysis } from '../services/render.mjs'
import { markIterationSpecsStale } from '../services/iteration-spec.mjs'
import { generateFlowchart, flowOf } from '../services/flowchart.mjs'

export const analysisRouter = Router()

export function latestAnalysis(reqId) {
  const v = get('SELECT * FROM requirement_versions WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', reqId)
  if (!v) return { version: 0, analysis: emptyAnalysis(), id: null, note: '', created_at: null }
  return { version: v.version, analysis: normalizeAnalysis(parseJson(v.analysis_json, {})), id: v.id, note: v.note, created_at: v.created_at }
}

export function saveAnalysis({ req, project, user, analysis, note, source = 'manual' }) {
  const latest = latestAnalysis(req.id)
  const normalized = normalizeAnalysis(analysis)
  if (JSON.stringify(normalized) === JSON.stringify(latest.analysis)) {
    return { version: latest.version, changed: false, versionId: latest.id }
  }
  const version = latest.version + 1
  const id = uid('AV-')
  run('INSERT INTO requirement_versions (id, requirement_id, version, analysis_json, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
    id, req.id, version, JSON.stringify(normalized), note || `分析版本 V${version}`, user.id, now())
  if (req.status === '待需求分析') {
    run("UPDATE requirements SET status = '需求分析中', stall_since = ?, updated_at = ? WHERE id = ?", now(), now(), req.id)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'status', message: '待需求分析 → 需求分析中', payload: { from: '待需求分析', to: '需求分析中' }, actorId: user.id })
  } else {
    run('UPDATE requirements SET updated_at = ? WHERE id = ?', now(), req.id)
  }
  const staled = markIterationSpecsStale(req.id)
  logEvent({ projectId: project.id, requirementId: req.id, type: 'analysis', message: `保存分析 V${version}（${source}）`, payload: { version, source, staledIterationSpecs: staled }, actorId: user.id })
  if (flowOf(normalized).length) {
    try {
      generateFlowchart({ req, project, user, versionRow: { version, analysis_json: JSON.stringify(normalized), created_at: now() }, source })
    } catch (e) {
      try {
        logEvent({
          projectId: project.id, requirementId: req.id, type: 'flowchart-error',
          message: `流程图生成失败（分析版本 V${version}）：${e.message}`,
          payload: { version, reason: e.message, code: e.code || null }, actorId: user.id
        })
      } catch { /* 事件写入失败不再追加 */ }
    }
  }
  return { version, changed: true, versionId: id, analysis: normalized }
}

analysisRouter.get('/requirements/:id/analysis', (hr, res, next) => {
  try {
    const { req, project } = requirementFor(hr.user, hr.params.id)
    const latest = latestAnalysis(req.id)
    const check = latest.version ? checkAnalysis(latest.analysis, req, project) : { ok: false, issues: [{ level: 'error', field: 'meta', message: '尚未提交分析' }] }
    res.json({ ...latest, check })
  } catch (e) { next(e) }
})

analysisRouter.post('/requirements/:id/analysis', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'requirement.analyze')
    const analysis = normalizeAnalysis(hr.body?.analysis || {})
    const check = checkAnalysis(analysis, req, project)
    if (hr.body?.submit) {
      if (!check.ok) {
        const e = new Error('分析尚未通过一致性校验'); e.statusCode = 400; e.details = check.issues; throw e
      }
    }
    const result = saveAnalysis({ req, project, user: hr.user, analysis, note: hr.body?.note, source: hr.body?.source || 'manual' })
    recordAudit(hr, 'analysis.save', 'requirement', req.id, { version: result.version - 1 }, { version: result.version, submit: !!hr.body?.submit })
    res.json({ ...result, check })
  } catch (e) { next(e) }
})

analysisRouter.post('/requirements/:id/analysis/check', (hr, res, next) => {
  try {
    const { req, project } = requirementFor(hr.user, hr.params.id)
    const analysis = hr.body?.analysis ? normalizeAnalysis(hr.body.analysis) : latestAnalysis(req.id).analysis
    res.json(checkAnalysis(analysis, req, project))
  } catch (e) { next(e) }
})

analysisRouter.get('/requirements/:id/versions', (hr, res, next) => {
  try {
    const { req } = requirementFor(hr.user, hr.params.id)
    const rows = all(`SELECT v.id, v.version, v.note, v.created_at, u.name AS created_by_name
      FROM requirement_versions v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.requirement_id = ? ORDER BY v.version DESC`, req.id)
    res.json(rows)
  } catch (e) { next(e) }
})

analysisRouter.get('/requirements/:id/versions/:version', (hr, res, next) => {
  try {
    const { req } = requirementFor(hr.user, hr.params.id)
    const v = get('SELECT * FROM requirement_versions WHERE requirement_id = ? AND version = ?', req.id, Number(hr.params.version))
    if (!v) { const e = new Error('版本不存在'); e.statusCode = 404; throw e }
    res.json({ ...v, analysis: normalizeAnalysis(parseJson(v.analysis_json, {})) })
  } catch (e) { next(e) }
})

analysisRouter.post('/requirements/:id/analysis/rollback', (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    requireAction(role, 'requirement.analyze')
    const v = get('SELECT * FROM requirement_versions WHERE requirement_id = ? AND version = ?', req.id, Number(hr.body?.version))
    if (!v) { const e = new Error('版本不存在'); e.statusCode = 404; throw e }
    const result = saveAnalysis({
      req, project, user: hr.user, analysis: parseJson(v.analysis_json, {}),
      note: `回退自 V${v.version}`, source: 'rollback'
    })
    recordAudit(hr, 'analysis.rollback', 'requirement', req.id, null, { from: Number(hr.body?.version), to: result.version })
    res.json(result)
  } catch (e) { next(e) }
})
