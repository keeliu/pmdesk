import { parseJson } from '../db.mjs'

export const REQUESTER_LEVELS = [
  { value: 'high', label: '高层' },
  { value: 'middle', label: '中层' },
  { value: 'basic', label: '基层' },
  { value: 'external', label: '外部' }
]

const LEVEL_ALIAS = {
  高层: 'high', 领导: 'high', high: 'high',
  中层: 'middle', 负责人: 'middle', middle: 'middle',
  基层: 'basic', 员工: 'basic', basic: 'basic',
  外部: 'external', 外部提出方: 'external', external: 'external'
}

export const REQUESTER_FIELDS = [
  { key: 'enterprise', label: '企业' },
  { key: 'department', label: '部门' },
  { key: 'name', label: '提出人姓名' },
  { key: 'level', label: '级别/岗位' }
]

export function enterpriseOptions(project) {
  const scope = parseJson(project?.enterprise_scope_json, {}) || {}
  const list = [
    ...(scope.specialCompanies || []),
    ...(scope.provinceCompanies || []),
    ...(scope.personalized || [])
  ].map(x => (typeof x === 'string' ? x : x?.name || '')).filter(Boolean)
  return [...new Set(list)]
}

export function levelLabel(value) {
  return REQUESTER_LEVELS.find(l => l.value === value)?.label || ''
}

export function normalizeLevel(value) {
  if (!value) return ''
  return LEVEL_ALIAS[String(value).trim()] || (REQUESTER_LEVELS.some(l => l.value === value) ? value : '')
}

function pick(input, existing, key) {
  if (input[key] !== undefined) return input[key]
  return existing[key] ?? ''
}

export function normalizeRequester(input = {}, project = {}, existing = {}) {
  const enterprise = String(pick(input, existing, 'enterprise') || '').trim()
  const options = enterpriseOptions(project)
  const external = Boolean(input.external ?? existing.external ?? false)
  const level = normalizeLevel(pick(input, existing, 'level'))
  return {
    enterprise,
    department: String(pick(input, existing, 'department') || '').trim(),
    name: String(pick(input, existing, 'name') || '').trim(),
    level: external && !level ? 'external' : level,
    position: String(pick(input, existing, 'position') || '').trim(),
    contact: String(pick(input, existing, 'contact') || '').trim(),
    external,
    enterpriseInScope: !options.length || options.includes(enterprise),
    options,
    source: input.source ?? existing.source ?? 'user',
    updatedAt: input.updatedAt ?? existing.updatedAt ?? new Date().toISOString()
  }
}

export function requesterIssues(requester, project) {
  const r = requester || {}
  const issues = []
  for (const field of REQUESTER_FIELDS) {
    const value = String(r[field.key] || '').trim()
    if (!value || value === '待定' || value === '待确认') {
      issues.push({ field: field.key, message: `缺少${field.label}`, blocking: true })
    }
  }
  const options = enterpriseOptions(project)
  if (r.enterprise && options.length && !options.includes(r.enterprise) && !r.external) {
    issues.push({
      field: 'enterprise',
      message: `企业「${r.enterprise}」不在项目画像范围内，请更新项目范围或标记为外部提出方`,
      blocking: true,
      options: ['更新项目范围', '标记为外部提出方']
    })
  }
  return issues
}

export function requesterComplete(requester, project) {
  return requesterIssues(requester, project).length === 0
}

export function requesterView(value, project) {
  const requester = normalizeRequester(value || {}, project, {})
  return { ...requester, levelText: levelLabel(requester.level), issues: requesterIssues(requester, project) }
}

export function requesterFromSource(source = {}, project = {}) {
  const submitter = String(source.submitter || '').trim()
  if (!submitter) return normalizeRequester({}, project, {})
  return normalizeRequester({
    name: submitter,
    contact: source.contact || '',
    level: source.type === 'form' ? 'external' : '',
    external: source.type === 'form',
    source: source.type === 'form' ? 'form' : 'intake'
  }, project, {})
}

export function requesterSnapshot(requester) {
  if (!requester) return null
  return {
    enterprise: requester.enterprise || '',
    department: requester.department || '',
    name: requester.name || '',
    level: requester.level || '',
    levelText: levelLabel(requester.level),
    position: requester.position || '',
    external: Boolean(requester.external)
  }
}
