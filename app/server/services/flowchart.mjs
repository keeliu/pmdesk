import crypto from 'node:crypto'
import { all, get, run, now, uid, parseJson, logEvent } from '../db.mjs'
import { resolveVisualSkill } from './skills.mjs'

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export function flowCandidateOf(flow) {
  const items = (Array.isArray(flow) ? flow : []).filter(item => item && (item.action || item.from || item.to))
  const nodes = []
  const seen = new Set()
  const addNode = label => {
    const name = String(label || '').trim()
    if (!name || seen.has(name)) return
    seen.add(name)
    nodes.push({ id: 'n' + nodes.length, label: name, kind: 'process' })
  }
  for (const item of items) { addNode(item.from); addNode(item.to) }
  const idOf = label => nodes.find(n => n.label === String(label || '').trim())?.id || ''
  const edges = items.map((item, i) => ({
    id: 'e' + i,
    from: idOf(item.from),
    to: idOf(item.to),
    label: String(item.action || '').trim(),
    condition: String(item.condition || '').trim()
  })).filter(e => e.from && e.to && e.label)
  return { type: 'workflow', nodes, edges, steps: items.length }
}

function failStatus(message, code, details) {
  const e = new Error(message)
  e.statusCode = 400
  e.code = code
  if (details) e.details = details
  return e
}

export function assertFlowCandidate(candidate) {
  if (!candidate || !Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
    throw failStatus('流程数据无法映射为合法节点与边', 'FLOWCHART_INVALID')
  }
  if (!candidate.nodes.length || !candidate.edges.length) {
    throw failStatus('流程数据无法映射为合法节点与边：节点或边为空', 'FLOWCHART_INVALID')
  }
}

function layoutWorkflow(candidate) {
  const byId = new Map(candidate.nodes.map(n => [n.id, n]))
  const incoming = new Map(candidate.nodes.map(n => [n.id, 0]))
  const outgoing = new Map(candidate.nodes.map(n => [n.id, 0]))
  for (const e of candidate.edges) {
    if (byId.has(e.from) && byId.has(e.to)) {
      outgoing.set(e.from, (outgoing.get(e.from) || 0) + 1)
      incoming.set(e.to, (incoming.get(e.to) || 0) + 1)
    }
  }
  const remaining = new Set(candidate.nodes.map(n => n.id))
  const layers = []
  let guard = 0
  while (remaining.size && guard < candidate.nodes.length + 2) {
    guard += 1
    const layer = [...remaining].filter(id => {
      const preds = candidate.edges.filter(e => e.to === id && remaining.has(e.from))
      return preds.length === 0
    })
    if (!layer.length) { layers.push([...remaining]); break }
    layers.push(layer)
    for (const id of layer) remaining.delete(id)
  }
  const pos = new Map()
  const BOX_W = 176
  const BOX_H = 46
  const GAP_X = 120
  const GAP_Y = 36
  layers.forEach((layer, li) => {
    layer.forEach((id, i) => {
      pos.set(id, {
        x: 40 + li * (BOX_W + GAP_X),
        y: 40 + i * (BOX_H + GAP_Y) + Math.max(0, (maxLayerSize(layers) - layer.length)) * (BOX_H + GAP_Y) / 2
      })
    })
  })
  return { pos, BOX_W, BOX_H, width: 40 + layers.length * (BOX_W + GAP_X), height: 40 + maxLayerSize(layers) * (BOX_H + GAP_Y) + 40 }
  function maxLayerSize(ls) { return Math.max(1, ...ls.map(l => l.length)) }
}

export function archifyWorkflowSvg(candidate) {
  assertFlowCandidate(candidate)
  const { pos, BOX_W, BOX_H, width, height } = layoutWorkflow(candidate)
  const nodeById = new Map(candidate.nodes.map(n => [n.id, n]))
  const parts = []
  parts.push(`<svg class="wf-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="功能流程图">`)
  parts.push(`<defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#3b5bdb"/></marker></defs>`)
  for (const e of candidate.edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    if (!a || !b) continue
    const x1 = a.x + BOX_W
    const y1 = a.y + BOX_H / 2
    const x2 = b.x - 6
    const y2 = b.y + BOX_H / 2
    const midX = (x1 + x2) / 2
    parts.push(`<path class="wf-edge" d="M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}" marker-end="url(#wf-arrow)" fill="none" stroke="#3b5bdb" stroke-width="1.4" opacity="0.75"/>`)
    const label = [e.label, e.condition ? `条件：${e.condition}` : ''].filter(Boolean).join(' · ')
    parts.push(`<text class="wf-edge-label" x="${midX}" y="${(y1 + y2) / 2 - 8}" text-anchor="middle" font-size="11" fill="#66707d">${esc(label)}<title>${esc(label)}</title></text>`)
  }
  for (const n of candidate.nodes) {
    const p = pos.get(n.id)
    if (!p) continue
    parts.push(`<g class="wf-node" tabindex="0"><title>${esc(n.label)}</title>
      <rect x="${p.x}" y="${p.y}" width="${BOX_W}" height="${BOX_H}" rx="10" fill="#eef1ff" stroke="#3b5bdb" stroke-width="1.2"/>
      <text x="${p.x + BOX_W / 2}" y="${p.y + BOX_H / 2 + 4}" text-anchor="middle" font-size="13" fill="#1c2430">${esc(n.label)}</text></g>`)
  }
  parts.push('</svg>')
  return parts.join('\n')
}

export function archifyWorkflowHtml({ req, project, version, flow, generatedAt, skill }) {
  const candidate = flowCandidateOf(flow)
  assertFlowCandidate(candidate)
  const title = `${req.title} 功能流程图`
  const svg = archifyWorkflowSvg(candidate)
  const skillNote = skill?.slug ? `按技能 ${skill.slug} V${skill.version} 的 workflow 契约渲染` : '按 archify workflow 契约渲染'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--ink:#1c2430;--muted:#66707d;--line:#dde2e9;--bg:#f6f8fb;--card:#ffffff;--accent:#3b5bdb}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 56px;background:var(--bg);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;line-height:1.6}
main{max-width:1180px;margin:0 auto}
.eyebrow{margin:0 0 6px;color:var(--accent);font-size:13px;letter-spacing:.14em}
h1{margin:0 0 8px;font-size:26px;line-height:1.35}
.meta{margin:0 0 20px;color:var(--muted);font-size:13px}
.caption{margin:0 0 14px;font-size:14px;color:var(--ink);font-weight:600}
.diagram{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;overflow:auto}
.wf-svg{display:block;min-width:640px}
.wf-node rect{fill:#eef1ff;stroke:var(--accent);stroke-width:1.2;transition:fill .15s}
.wf-node text{font-size:13px;fill:var(--ink);pointer-events:none}
.wf-node:focus{outline:none}
.wf-node:focus rect,.wf-node:hover rect{fill:#dfe6ff}
.wf-edge{fill:none;stroke:var(--accent);stroke-width:1.4;opacity:.75}
.wf-edge-label{font-size:11px;fill:var(--muted)}
.steps{list-style:none;margin:24px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}
.step{display:flex;gap:12px;padding:12px 16px;background:var(--card);border:1px solid var(--line);border-radius:10px;font-size:13px}
.step .idx{flex:none;width:32px;height:32px;border-radius:8px;background:#eef1ff;color:var(--accent);font-weight:700;display:flex;align-items:center;justify-content:center;font-size:12px}
.step .body{min-width:0}
.step .action{margin:0 0 4px;font-weight:600}
.step .edge{margin:0;display:flex;flex-wrap:wrap;gap:6px;color:var(--muted);font-size:12px}
.step .node{padding:1px 8px;border:1px solid var(--line);border-radius:999px;background:#fafbfd}
footer{max-width:1180px;margin:24px auto 0;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<main>
<p class="eyebrow">需求流程图 · 图 功能流程图</p>
<h1>${esc(title)}</h1>
<p class="meta">${esc(project?.name || '')} · 分析版本 V${version} · 生成于 ${esc(String(generatedAt || '').slice(0, 19).replace('T', ' '))} · ${esc(skillNote)}</p>
<p class="caption">图 功能流程图</p>
<div class="diagram">${svg}</div>
<ol class="steps">
${flow.filter(item => item && (item.action || item.from || item.to)).map((item, i) => `<li class="step"><div class="idx">${String(i + 1).padStart(2, '0')}</div><div class="body">
  <p class="action">${esc(item.action || '未命名步骤')}</p>
  <p class="edge"><span class="node">${esc(item.from || '—')}</span>→<span class="node">${esc(item.to || '—')}</span>${item.condition ? `<span>条件：${esc(item.condition)}</span>` : ''}</p>
</div></li>`).join('')}
</ol>
</main>
<footer>由需求管理工作台生成，页面不引用任何外部资源。</footer>
</body>
</html>`
}

export function builtinFlowchartHtml({ req, project, version, flow, generatedAt }) {
  const title = `${req.title} 流程图 V${version}`
  const steps = flow.map((item, i) => `<li class="step">
    <div class="index">${String(i + 1).padStart(2, '0')}</div>
    <div class="body">
      <p class="action">${esc(item.action || '未命名步骤')}</p>
      <p class="edge"><span class="node">${esc(item.from || '—')}</span><span class="arrow">→</span><span class="node">${esc(item.to || '—')}</span></p>
      ${item.condition ? `<p class="condition">条件：${esc(item.condition)}</p>` : ''}
    </div>
  </li>`).join('')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--ink:#1c2430;--muted:#66707d;--line:#dde2e9;--bg:#f6f8fb;--card:#ffffff;--accent:#3b5bdb}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 56px;background:var(--bg);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;line-height:1.6}
main{max-width:880px;margin:0 auto}
.eyebrow{margin:0 0 6px;color:var(--accent);font-size:13px;letter-spacing:.14em}
h1{margin:0 0 8px;font-size:26px;line-height:1.35}
.meta{margin:0 0 28px;color:var(--muted);font-size:13px}
.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
.step{display:flex;gap:14px;padding:16px 18px;background:var(--card);border:1px solid var(--line);border-radius:12px}
.index{flex:none;width:38px;height:38px;border-radius:10px;background:#eef1ff;color:var(--accent);font-weight:700;display:flex;align-items:center;justify-content:center;font-size:14px}
.body{min-width:0}
.action{margin:0 0 6px;font-weight:600;font-size:16px}
.edge{margin:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.node{padding:2px 9px;border:1px solid var(--line);border-radius:999px;background:#fafbfd;color:var(--ink)}
.arrow{color:var(--accent);font-weight:700}
.condition{margin:8px 0 0;font-size:13px;color:var(--muted)}
.empty{padding:36px;text-align:center;color:var(--muted);background:var(--card);border:1px dashed var(--line);border-radius:12px}
footer{max-width:880px;margin:28px auto 0;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<main>
<p class="eyebrow">需求流程图</p>
<h1>${esc(title)}</h1>
<p class="meta">${esc(project?.name || '')} · 分析版本 V${version} · 生成于 ${esc(String(generatedAt || '').slice(0, 19).replace('T', ' '))}</p>
${steps ? `<ol class="steps">${steps}</ol>` : '<p class="empty">该分析版本没有功能流程步骤。</p>'}
</main>
<footer>由需求管理工作台生成，页面不引用任何外部资源。</footer>
</body>
</html>`
}

export function flowOf(analysis) {
  const flow = analysis?.functions?.flow
  if (!Array.isArray(flow)) return []
  return flow.filter(item => item && (item.action || item.from || item.to))
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export function renderFlowchart({ req, project, versionRow, resolution }) {
  const flow = flowOf(parseJson(versionRow.analysis_json, {}))
  if (!flow.length) throw failStatus('该分析版本没有功能流程步骤', 'FLOWCHART_EMPTY')
  const candidate = flowCandidateOf(flow)
  assertFlowCandidate(candidate)
  const renderer = resolution.renderer
  const html = renderer === 'archify'
    ? archifyWorkflowHtml({ req, project, version: versionRow.version, flow, generatedAt: versionRow.created_at, skill: resolution.view })
    : builtinFlowchartHtml({ req, project, version: versionRow.version, flow, generatedAt: versionRow.created_at })
  return { html, renderer, candidate, flow, skill: resolution.view }
}

export function upsertFlowchart({ req, versionRow, rendered, actorId }) {
  const id = uid('FC-')
  const size = Buffer.byteLength(rendered.html, 'utf8')
  const hash = sha256(rendered.html)
  const existing = get('SELECT id FROM flowcharts WHERE requirement_id = ? AND analysis_version = ?', req.id, versionRow.version)
  const source = JSON.stringify({ ...rendered.candidate, skill: rendered.skill ? `${rendered.skill.slug}@${rendered.skill.version}` : null })
  if (existing) {
    run(`UPDATE flowcharts SET renderer = ?, skill_binding_id = ?, skill_slug = ?, skill_version = ?, source_json = ?,
         html = ?, html_size = ?, html_sha256 = ?, created_by = ?, updated_at = ? WHERE id = ?`,
      rendered.renderer, rendered.skill?.id || null, rendered.skill?.slug || null, rendered.skill?.version || null,
      source, rendered.html, size, hash, actorId, now(), existing.id)
    return existing.id
  }
  run(`INSERT INTO flowcharts (id, requirement_id, analysis_version, renderer, skill_binding_id, skill_slug, skill_version,
       source_json, html, html_size, html_sha256, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, req.id, versionRow.version, rendered.renderer, rendered.skill?.id || null,
    rendered.skill?.slug || null, rendered.skill?.version || null,
    source, rendered.html, size, hash, actorId, now(), now())
  return id
}

export function recordFlowchartCall({ projectId, req, version, skill, status }) {
  run(`INSERT INTO llm_calls (id, project_id, requirement_id, skill_slug, stage, trigger_type, provider, model,
       prompt_tokens, completion_tokens, cost, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid('LLM-'), projectId, req.id, skill?.slug || null, 'flowchart', 'document', 'skill-runtime',
    skill ? `v${skill.version}` : 'builtin', 0, 0, 0, status, now())
}

export function generateFlowchart({ req, project, user, bindingId = null, versionRow, source = 'submit' }) {
  const resolution = resolveVisualSkill({ projectId: project.id, bindingId })
  const rendered = renderFlowchart({ req, project, versionRow, resolution })
  const id = upsertFlowchart({
    req, versionRow, rendered,
    actorId: user?.id || 'system'
  })
  recordFlowchartCall({ projectId: project.id, req, version: versionRow.version, skill: rendered.skill, status: 'success' })
  const skillText = rendered.skill ? `技能 ${rendered.skill.slug} V${rendered.skill.version}` : '内置渲染器'
  logEvent({
    projectId: project.id, requirementId: req.id, type: 'flowchart',
    message: `生成流程图（分析版本 V${versionRow.version}，${rendered.renderer}）· ${skillText}${resolution.fallback ? ` · ${resolution.fallback.reason}` : ''}`,
    payload: {
      flowchartId: id, analysisVersion: versionRow.version, renderer: rendered.renderer,
      skill: rendered.skill ? `${rendered.skill.slug}@${rendered.skill.version}` : null,
      fallback: resolution.fallback?.reason || null, source
    },
    actorId: user?.id || null
  })
  return { id, ...rendered, fallback: resolution.fallback }
}

export function backfillFlowchart(req, project, versionRow) {
  const rendered = renderFlowchart({
    req, project, versionRow,
    resolution: { renderer: 'builtin', view: null, fallback: { reason: '历史补登记' } }
  })
  const source = JSON.stringify({ ...rendered.candidate, backfilled: true })
  const id = uid('FC-')
  const size = Buffer.byteLength(rendered.html, 'utf8')
  const hash = sha256(rendered.html)
  run(`INSERT INTO flowcharts (id, requirement_id, analysis_version, renderer, skill_binding_id, skill_slug, skill_version,
       source_json, html, html_size, html_sha256, created_by, created_at, updated_at)
       VALUES (?,?,?,?,NULL,NULL,NULL,?,?,?,?,?,?,?)`,
    id, req.id, versionRow.version, 'builtin', source, rendered.html, size, hash, 'system-backfill', now(), now())
  return id
}

export function ensureFlowcharts(req, project) {
  const versions = all('SELECT * FROM requirement_versions WHERE requirement_id = ? ORDER BY version', req.id)
  let created = 0
  for (const row of versions) {
    const exists = get('SELECT id FROM flowcharts WHERE requirement_id = ? AND analysis_version = ?', req.id, row.version)
    if (exists) continue
    if (!flowOf(parseJson(row.analysis_json, {})).length) continue
    try {
      backfillFlowchart(req, project, row)
      created += 1
    } catch { /* 补登记失败保留空态，不阻断读取 */ }
  }
  return created
}

export function flowchartRows(reqId) {
  return all('SELECT * FROM flowcharts WHERE requirement_id = ? ORDER BY analysis_version DESC', reqId)
}
