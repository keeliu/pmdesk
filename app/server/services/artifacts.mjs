import { all, get, parseJson } from '../db.mjs'
import { can, STATUS_INDEX, STATUS_TONE, STAGES } from '../core.mjs'
import { normalizeMilestones, milestoneView } from './milestones.mjs'
import { profileView, requirementUsers, appsView, leadsView } from './requirement-profile.mjs'
import { nextStatuses, gateIssues, DEVELOPER_TARGETS } from './status.mjs'
import { ensureFlowcharts, flowOf } from './flowchart.mjs'

export { flowOf }

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function statusDisplay(status) {
  const index = STATUS_INDEX[status]
  return index === undefined ? status : `${index}-${status}`
}

function timeOf(row) {
  return row.updated_at || row.created_at || ''
}

function iterationOf(req) {
  return req.iteration_id ? get('SELECT id, name FROM iterations WHERE id = ?', req.iteration_id) : null
}

function productManagerOf(req) {
  return normalizeMilestones(req.milestones_json).productManager || ''
}

function requirementRef(req) {
  return { id: req.id, code: req.code || '', title: req.title }
}

function baseMeta(req, iteration, productManager) {
  return {
    requirement: requirementRef(req),
    iteration: iteration ? { id: iteration.id, name: iteration.name } : null,
    productManager,
    requirementStatus: req.status,
    requirementStatusLabel: statusDisplay(req.status)
  }
}

function firstPageId(pages) {
  return Array.isArray(pages) && pages[0]?.id ? pages[0].id : ''
}

export function requirementArtifacts(req, { role = 'pm' } = {}) {
  const iteration = iterationOf(req)
  const pm = productManagerOf(req)
  const guest = role === 'guest'
  const meta = baseMeta(req, iteration, pm)

  if (!guest) {
    const reqProject = get('SELECT * FROM projects WHERE id = ?', req.project_id)
    if (reqProject) ensureFlowcharts(req, reqProject)
  }
  const versionRowIds = Object.fromEntries(
    all('SELECT id, version FROM requirement_versions WHERE requirement_id = ?', req.id).map(r => [r.version, r.id])
  )
  const flowcharts = guest ? [] : all('SELECT * FROM flowcharts WHERE requirement_id = ? ORDER BY analysis_version DESC', req.id)
    .map(row => {
      const source = parseJson(row.source_json, {}) || {}
      return {
        id: row.id,
        kind: 'flowchart',
        title: `${req.code || req.title} 流程图 V${row.analysis_version}`,
        analysisVersion: row.analysis_version,
        analysisVersionRowId: versionRowIds[row.analysis_version] || null,
        renderer: row.renderer,
        rendererText: row.renderer === 'archify' ? '交互图' : '步骤清单',
        skill: row.skill_slug ? { slug: row.skill_slug, version: row.skill_version } : null,
        backfilled: Boolean(source.backfilled) || row.created_by === 'system-backfill',
        steps: Array.isArray(source.edges) ? source.edges.length : 0,
        createdAt: row.created_at,
        updatedAt: timeOf(row),
        previewUrl: `/api/requirements/${req.id}/flowcharts/${row.id}/preview`,
        ...meta
      }
    })

  const prototypes = all('SELECT * FROM prototypes WHERE requirement_id = ? ORDER BY version DESC', req.id)
    .filter(row => !guest || row.status === 'confirmed')
    .map(row => {
      const pages = parseJson(row.pages_json, [])
      const pageId = firstPageId(pages)
      return {
        id: row.id,
        kind: 'prototype',
        title: `${req.code || req.title} 原型 V${row.version}`,
        version: row.version,
        status: row.status,
        statusText: row.status === 'confirmed' ? '已确认' : '草稿',
        pageCount: pages.length,
        createdAt: row.created_at,
        updatedAt: timeOf(row),
        previewUrl: pageId ? `/api/prototypes/${row.id}/page/${encodeURIComponent(pageId)}` : '',
        unavailable: pageId ? '' : '原型没有可预览的页面',
        ...meta
      }
    })

  const specs = all('SELECT * FROM specs WHERE requirement_id = ? ORDER BY version DESC', req.id)
    .filter(row => !guest || row.status === 'published')
    .map(row => ({
      id: row.id,
      kind: 'spec',
      title: `${req.code || req.title} 说明书 V${row.version}`,
      version: row.version,
      status: row.status,
      statusText: row.status === 'published' ? '已发布' : row.status === 'superseded' ? '已被替代' : '草稿',
      analysisVersion: row.analysis_version,
      prototypeVersion: row.prototype_version,
      skill: row.skill_slug ? { slug: row.skill_slug, version: row.skill_version } : null,
      legacy: !row.skill_slug,
      createdAt: row.created_at,
      updatedAt: timeOf(row),
      previewUrl: `/api/specs/${row.id}/preview`,
      docxUrl: `/api/specs/${row.id}/docx`,
      ...meta
    }))

  const iterationSpecRows = iteration
    ? all('SELECT * FROM iteration_specs WHERE iteration_id = ? ORDER BY version DESC', iteration.id)
      .filter(row => !guest || row.status !== 'draft')
      .filter(row => {
        const source = parseJson(row.source_json, {}) || {}
        const ids = (source.requirements || []).map(x => x.id)
        return !ids.length || ids.includes(req.id)
      })
    : []
  const iterationSpecs = iterationSpecRows.map(row => ({
    id: row.id,
    kind: 'iteration-spec',
    title: `${iteration.name} 迭代说明书 V${row.version}`,
    version: row.version,
    status: row.status,
    statusText: row.status === 'published' ? '已发布' : '草稿',
    requirementCount: row.requirement_count,
    stale: Boolean(row.stale),
    createdAt: row.created_at,
    updatedAt: timeOf(row),
    previewUrl: `/api/iteration-specs/${row.id}/preview`,
    docxUrl: `/api/iteration-specs/${row.id}/docx`,
    requirement: requirementRef(req),
    iteration: { id: iteration.id, name: iteration.name },
    productManager: pm,
    requirementStatus: req.status,
    requirementStatusLabel: statusDisplay(req.status)
  }))

  const outputs = [
    ...specs.map(s => ({
      id: `output-${s.id}`,
      title: s.title,
      kind: 'spec',
      version: s.version,
      status: s.status,
      statusText: s.statusText,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      formats: [
        { format: 'html', label: 'HTML 预览', url: s.previewUrl },
        ...(s.status === 'published' ? [{ format: 'docx', label: 'Word 下载', url: s.docxUrl }] : [])
      ]
    })),
    ...iterationSpecs.map(s => ({
      id: `output-${s.id}`,
      title: s.title,
      kind: 'iteration-spec',
      version: s.version,
      status: s.status,
      statusText: s.statusText,
      requirementCount: s.requirementCount,
      stale: s.stale,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      formats: [
        { format: 'html', label: 'HTML 预览', url: s.previewUrl },
        { format: 'docx', label: 'Word 下载', url: s.docxUrl }
      ]
    }))
  ]

  return { flowcharts, prototypes, specs, iterationSpecs, outputs }
}

export function knowledgeArtifacts(projectId, role = 'pm') {
  const requirements = all("SELECT * FROM requirements WHERE project_id = ? AND status NOT IN ('已丢弃')", projectId)
  const items = []
  for (const req of requirements) {
    const docs = requirementArtifacts(req, { role })
    if (role !== 'guest') items.push(...docs.flowcharts)
    items.push(...docs.prototypes, ...docs.specs)
  }
  const iterationSpecs = all(`SELECT s.*, i.name AS iteration_name, u.name AS created_by_name
    FROM iteration_specs s LEFT JOIN iterations i ON i.id = s.iteration_id
    LEFT JOIN users u ON u.id = s.created_by WHERE s.project_id = ? ORDER BY s.version DESC`, projectId)
    .filter(row => role !== 'guest' || row.status !== 'draft')
    .map(row => ({
      id: row.id,
      kind: 'iteration-spec',
      title: `${row.iteration_name || '迭代'} 迭代说明书 V${row.version}`,
      requirement: null,
      iteration: row.iteration_id ? { id: row.iteration_id, name: row.iteration_name } : null,
      productManager: row.created_by_name || '',
      requirementCount: row.requirement_count,
      version: row.version,
      status: row.status,
      statusText: row.status === 'published' ? '已发布' : '草稿',
      stale: Boolean(row.stale),
      createdAt: row.created_at,
      updatedAt: timeOf(row),
      previewUrl: `/api/iteration-specs/${row.id}/preview`,
      docxUrl: `/api/iteration-specs/${row.id}/docx`
    }))
  items.push(...iterationSpecs)
  return items
}

function categoryOf(item) {
  if (item.kind === 'flowchart') return 'flowchart'
  if (item.kind === 'prototype') return 'prototype'
  return 'spec'
}

function matchesFilters(item, { q, iterationId, pm, from, to }) {
  if (iterationId && item.iteration?.id !== iterationId) return false
  if (pm && !String(item.productManager || '').includes(pm)) return false
  const updated = String(item.updatedAt || item.createdAt || '').slice(0, 10)
  if (from && updated && updated < from) return false
  if (to && updated && updated > to) return false
  if (q) {
    const hay = [item.title, item.requirement?.code, item.requirement?.title, item.iteration?.name]
      .filter(Boolean).join(' ').toLowerCase()
    if (!hay.includes(q.toLowerCase())) return false
  }
  return true
}

export function knowledgeQuery(projectId, role, query = {}) {
  const category = ['flowchart', 'prototype', 'spec'].includes(query.category) ? query.category : ''
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20))
  const page = Math.max(1, Number(query.page) || 1)
  const filters = {
    q: String(query.q || '').trim(),
    iterationId: String(query.iterationId || ''),
    pm: String(query.pm || '').trim(),
    from: String(query.from || ''),
    to: String(query.to || '')
  }
  const allItems = knowledgeArtifacts(projectId, role)
    .filter(item => matchesFilters(item, filters))
  const counts = { all: allItems.length, flowchart: 0, prototype: 0, spec: 0 }
  for (const item of allItems) counts[categoryOf(item)] += 1
  const scoped = category ? allItems.filter(item => categoryOf(item) === category) : allItems
  scoped.sort((a, b) => {
    const ua = String(a.updatedAt || a.createdAt || '')
    const ub = String(b.updatedAt || b.createdAt || '')
    if (ua !== ub) return ua < ub ? 1 : -1
    const ca = String(a.createdAt || '')
    const cb = String(b.createdAt || '')
    if (ca !== cb) return ca < cb ? 1 : -1
    return String(a.id).localeCompare(String(b.id))
  })
  const total = scoped.length
  const start = (page - 1) * pageSize
  return {
    items: scoped.slice(start, start + pageSize).map(item => ({ ...item, category: categoryOf(item) })),
    total,
    page,
    pageSize,
    counts,
    filters: { ...filters, category }
  }
}

export function knowledgeOptions(projectId) {
  const iterations = all('SELECT id, name FROM iterations WHERE project_id = ? ORDER BY start_date DESC', projectId)
  const pms = new Set()
  for (const row of all("SELECT milestones_json FROM requirements WHERE project_id = ? AND status NOT IN ('已丢弃')", projectId)) {
    const pm = normalizeMilestones(row.milestones_json).productManager
    if (pm) pms.add(pm)
  }
  for (const row of all(`SELECT DISTINCT u.name FROM iteration_specs s JOIN users u ON u.id = s.created_by
    WHERE s.project_id = ? AND u.name IS NOT NULL`, projectId)) {
    if (row.name) pms.add(row.name)
  }
  return { iterations, productManagers: [...pms].sort() }
}

function statusSteps(req) {
  const anchor = req.status === '挂起' ? req.suspended_from : req.status
  const currentIndex = STATUS_INDEX[anchor]
  if (currentIndex === undefined) return []
  return STAGES.map(stage => ({
    index: stage.index,
    name: stage.name,
    label: `${stage.index}-${stage.name}`,
    done: stage.index < currentIndex,
    current: stage.index === currentIndex,
    upcoming: stage.index > currentIndex,
    suspended: req.status === '挂起' && stage.index === currentIndex
  }))
}

function batchRecords(projectId, reqId, limit = 50) {
  return all('SELECT * FROM batch_operations WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', projectId, limit)
    .map(row => {
      const success = parseJson(row.success_json, [])
      const failed = parseJson(row.failed_json, [])
      const hit = success.find(x => x.id === reqId)
      const miss = failed.find(x => x.id === reqId)
      if (!hit && !miss) return null
      return {
        batchId: row.id,
        kind: row.kind || 'status',
        target: row.target_status,
        createdAt: row.created_at,
        ok: Boolean(hit),
        result: hit || miss
      }
    })
    .filter(Boolean)
}

export function requirementDetail({ req, project, role }) {
  const users = requirementUsers()
  const profile = profileView(req, { project, users })
  const docs = requirementArtifacts(req, { role })
  const timeline = all(`SELECT e.*, u.name AS actor_name FROM events e LEFT JOIN users u ON u.id = e.actor_id
    WHERE e.requirement_id = ? ORDER BY COALESCE(e.effective_at, e.created_at) DESC, e.created_at DESC`, req.id)
  const next = nextStatuses(req.status, req.suspended_from)
  const transitions = next.map(status => ({
    status,
    label: statusDisplay(status),
    allowed: true,
    issues: gateIssues(req, status)
  }))
  const milestones = milestoneView(req.milestones_json)
  const nextMilestone = milestones.fields.find(f => !f.actual) || null
  const events = timeline.map(e => ({
    id: e.id,
    type: e.type,
    message: e.message,
    actorName: e.actor_name || '',
    effectiveAt: e.effective_at || e.created_at,
    createdAt: e.created_at,
    payload: parseJson(e.payload_json, {})
  }))
  const isGuest = role === 'guest'
  const canAdvance = can(role, 'status.advance') || (role === 'developer' && can(role, 'status.submit_acceptance'))
  return {
    basic: {
      ...profile,
      requester: parseJson(req.requester_json, null),
      apps: appsView(req),
      leads: leadsView(req),
      milestones,
      nextMilestone,
      statusTone: STATUS_TONE[req.status] || 'gray'
    },
    docs,
    progress: {
      events,
      milestones,
      nextMilestone,
      steps: statusSteps(req),
      suspendedFrom: req.suspended_from || null,
      transitions,
      batches: batchRecords(project.id, req.id)
    },
    permissions: {
      guest: isGuest,
      editDescription: can(role, 'requirement.clarify'),
      editApps: can(role, 'requirement.clarify'),
      editLeads: can(role, 'milestone.edit'),
      editMilestones: can(role, 'milestone.edit'),
      advanceStatus: canAdvance,
      allowedTargets: role === 'developer' ? DEVELOPER_TARGETS : next,
      batch: can(role, 'batch.status'),
      regenerateFlowchart: can(role, 'requirement.analyze'),
      enterWorkbench: !isGuest && Boolean(req.code)
    }
  }
}
