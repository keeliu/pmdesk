import crypto from 'node:crypto'
import { all, get, parseJson } from '../db.mjs'
import { normalizeMilestones } from './milestones.mjs'

export const LEAD_FIELDS = [
  { key: 'productManager', label: '产品经理' },
  { key: 'tech', label: '技术负责人' },
  { key: 'test', label: '测试负责人' },
  { key: 'implementation', label: '实施负责人' }
]

export const LEAD_MAX_LENGTH = 20

function fail(message, statusCode = 400, code = '') {
  const e = new Error(message)
  e.statusCode = statusCode
  if (code) e.code = code
  return e
}

function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function fnId(appName, fnName) {
  const digest = crypto.createHash('sha1').update(`${appName}\u0000${fnName}`).digest('hex')
  return `FN-${digest.slice(0, 10)}`
}

export function normalizeApps(value, { scopeAll = [], existingApps = [] } = {}) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw fail('关联应用必须是数组')
  const scopeSet = new Set(scopeAll)
  const existingSet = new Set(existingApps)
  const previous = new Map()
  for (const app of existingApps) {
    const name = cleanName(app?.name || app)
    if (!name) continue
    previous.set(name, Array.isArray(app?.functions) ? app.functions : [])
  }
  const apps = []
  const names = new Set()
  const outside = []
  for (const raw of value) {
    const item = typeof raw === 'string' ? { name: raw } : (raw || {})
    const name = cleanName(item.name)
    if (!name) throw fail('关联应用名称不能为空')
    if (names.has(name)) throw fail(`关联应用重复：${name}`)
    names.add(name)
    const kind = item.kind === 'external' ? 'external' : 'internal'
    if (kind !== 'external' && !scopeSet.has(name) && !existingSet.has(name)) outside.push(name)

    const priorFns = previous.get(name) || []
    const priorByName = new Map(priorFns.map(f => [cleanName(f?.name), f]))
    const priorIds = new Set(priorFns.map(f => f?.id).filter(Boolean))
    const source = item.functions === undefined ? priorFns : item.functions
    if (!Array.isArray(source)) throw fail(`应用「${name}」的功能点必须是数组`)
    const functions = []
    const fnNames = new Set()
    const duplicates = []
    for (const rawFn of source) {
      const fn = typeof rawFn === 'string' ? { name: rawFn } : (rawFn || {})
      const fnName = cleanName(fn.name)
      if (!fnName) throw fail(`应用「${name}」存在未命名功能点`)
      if (fnNames.has(fnName)) duplicates.push(`${name}/${fnName}`)
      fnNames.add(fnName)
      const prior = priorByName.get(fnName)
      const id = prior?.id || (priorIds.has(fn.id) ? fn.id : fnId(name, fnName))
      functions.push({
        id,
        name: fnName,
        description: String(fn.description ?? prior?.description ?? '').trim()
      })
    }
    if (duplicates.length) throw fail(`功能点名称重复：${duplicates.join('、')}`)
    apps.push({
      ...item,
      name,
      kind,
      functions
    })
  }
  if (outside.length) throw fail(`关联应用超出项目系统范围：${[...new Set(outside)].join('、')}`)
  return apps
}

export function normalizeLeads(value) {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('负责人必须是对象')
  const patch = {}
  for (const field of LEAD_FIELDS) {
    if (value[field.key] === undefined) continue
    const name = cleanName(value[field.key])
    if (name.length > LEAD_MAX_LENGTH) throw fail(`${field.label}姓名不能超过 ${LEAD_MAX_LENGTH} 个字符`)
    patch[field.key] = name
  }
  return patch
}

export function descriptionFallback(req) {
  if (req.description && String(req.description).trim()) return { text: String(req.description).trim(), source: 'manual' }
  const clar = parseJson(req.clarification_json, {}) || {}
  const answers = clar.answers || {}
  const clarified = cleanName(answers.goal?.value) || cleanName(answers.scope?.value)
  if (clarified) return { text: clarified, source: 'clarification' }
  const source = parseJson(req.source_json, {}) || {}
  const excerpt = String(source.excerpt || '').trim()
  if (excerpt) return { text: excerpt, source: 'source' }
  return { text: '', source: 'empty' }
}

export function leadsView(req) {
  const ms = normalizeMilestones(req.milestones_json)
  const raw = parseJson(req.leads_json, {}) || {}
  return {
    productManager: cleanName(ms.productManager),
    tech: cleanName(raw.tech),
    test: cleanName(raw.test),
    implementation: cleanName(raw.implementation)
  }
}

export function appsView(req) {
  const apps = parseJson(req.involved_apps_json, [])
  if (!Array.isArray(apps)) return []
  return apps.map(app => ({
    name: cleanName(app?.name),
    kind: app?.kind === 'external' ? 'external' : 'internal',
    functions: Array.isArray(app?.functions)
      ? app.functions.map(fn => ({
        id: fn?.id || fnId(cleanName(app?.name), cleanName(fn?.name)),
        name: cleanName(fn?.name),
        description: String(fn?.description || '').trim()
      })).filter(fn => fn.name)
      : []
  })).filter(app => app.name)
}

export function submittedAtOf(req) {
  return req.confirmed_at || req.created_at
}

export function submittedByName(req, users = []) {
  const requester = parseJson(req.requester_json, {}) || {}
  const name = cleanName(requester.name)
  if (name) return name
  if (!req.confirmed_by) return ''
  const user = users.find(u => u.id === req.confirmed_by) || get('SELECT name FROM users WHERE id = ?', req.confirmed_by)
  return cleanName(user?.name)
}

export function submittedOrgOf(req) {
  const requester = parseJson(req.requester_json, {}) || {}
  return [requester.enterprise, requester.department].map(cleanName).filter(Boolean).join(' / ')
}

export function profileView(req, { project = null, users = [] } = {}) {
  const description = descriptionFallback(req)
  const leads = leadsView(req)
  const apps = appsView(req)
  const iteration = req.iteration_id ? get('SELECT id, name, status FROM iterations WHERE id = ?', req.iteration_id) : null
  const priority = parseJson(req.priority_json, null)
  return {
    id: req.id,
    code: req.code || '',
    title: req.title,
    description: description.text,
    descriptionSource: description.source,
    submittedBy: submittedByName(req, users),
    submittedByOrg: submittedOrgOf(req),
    submittedAt: submittedAtOf(req),
    apps,
    status: req.status,
    iteration: iteration ? { id: iteration.id, name: iteration.name, status: iteration.status } : null,
    priority: priority ? { grade: priority.grade, gradeLabel: priority.gradeLabel || priority.grade, score: priority.score } : null,
    leads,
    milestones: normalizeMilestones(req.milestones_json),
    project: project ? { id: project.id, name: project.name } : null
  }
}

export function requirementUsers() {
  return all('SELECT id, name, role, title FROM users ORDER BY role, name')
}
