import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { get, all, run, now, uid, parseJson, audit, logEvent, notify } from './db.mjs'
import { levelLabel } from './services/requester.mjs'
import { normalizeMilestones } from './services/milestones.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const secretFile = path.join(__dirname, '..', 'data', '.secret')
let secret = process.env.APP_SECRET
if (!secret) {
  if (fs.existsSync(secretFile)) secret = fs.readFileSync(secretFile, 'utf8').trim()
  else {
    secret = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(secretFile, secret)
  }
}
export const appSecret = secret

export const STAGES = [
  { index: 0, name: '需求调研中', stage: 'clarify' },
  { index: 1, name: '待需求分析', stage: 'analysis' },
  { index: 2, name: '需求分析中', stage: 'analysis' },
  { index: 3, name: '需求评审中', stage: 'review' },
  { index: 4, name: '待开发', stage: 'change' },
  { index: 5, name: '开发中', stage: 'change' },
  { index: 6, name: '待测试验证', stage: 'change' },
  { index: 7, name: '测试验证中', stage: 'change' },
  { index: 8, name: '待UAT', stage: 'change' },
  { index: 9, name: 'UAT中', stage: 'change' },
  { index: 10, name: '待试点', stage: 'change' },
  { index: 11, name: '试点中', stage: 'change' },
  { index: 12, name: '待上线发版', stage: 'change' },
  { index: 13, name: '全国推广中', stage: 'change' }
]

export const EXCEPTION_STATES = ['已关闭', '挂起', '已丢弃']

export const STATES = [...STAGES.map(s => s.name), ...EXCEPTION_STATES]

export const STATUS_INDEX = Object.fromEntries(STAGES.map(s => [s.name, s.index]))
export const STATUS_STAGE = Object.fromEntries(STAGES.map(s => [s.name, s.stage]))

export const LEGACY_STATUS_MAP = {
  '待澄清': '需求调研中',
  '已确认': '待需求分析',
  '分析中': '需求分析中',
  '原型中': '需求分析中',
  '待评审': '需求评审中',
  '评审中': '需求评审中',
  '待验收': '待测试验证',
  '已上线': '全国推广中'
}

export function statusLabel(status) {
  const index = STATUS_INDEX[status]
  return index === undefined ? status : `${index}-${status}`
}

export function statusStage(status) {
  if (!status) return 'change'
  if (status === '挂起') return 'change'
  const mapped = STATUS_STAGE[status]
  if (mapped) return mapped
  return LEGACY_STATUS_MAP[status] ? STATUS_STAGE[LEGACY_STATUS_MAP[status]] : 'change'
}

export function isLegacyStatus(status) {
  return Boolean(LEGACY_STATUS_MAP[status])
}

export const TRANSITIONS = {
  '需求调研中': { '待需求分析': 'confirm', '已丢弃': 'discard', '挂起': 'suspend' },
  '待需求分析': { '需求分析中': 'start_analysis', '挂起': 'suspend' },
  '需求分析中': { '需求评审中': 'submit_spec', '挂起': 'suspend' },
  '需求评审中': { '待开发': 'review_pass', '需求分析中': 'review_fail', '挂起': 'suspend' },
  '待开发': { '开发中': 'start_dev', '需求评审中': 'change_review', '挂起': 'suspend' },
  '开发中': { '待测试验证': 'submit_test', '需求评审中': 'change_review', '挂起': 'suspend' },
  '待测试验证': { '测试验证中': 'start_test', '开发中': 'test_reject', '挂起': 'suspend' },
  '测试验证中': { '待UAT': 'test_pass', '开发中': 'test_fail', '挂起': 'suspend' },
  '待UAT': { 'UAT中': 'start_uat', '测试验证中': 'uat_reject', '挂起': 'suspend' },
  'UAT中': { '待试点': 'uat_pass', '开发中': 'uat_fail', '挂起': 'suspend' },
  '待试点': { '试点中': 'start_pilot', 'UAT中': 'pilot_reject', '挂起': 'suspend' },
  '试点中': { '待上线发版': 'pilot_pass', '开发中': 'pilot_fail', '挂起': 'suspend' },
  '待上线发版': { '全国推广中': 'release', '试点中': 'release_blocked', '挂起': 'suspend' },
  '全国推广中': { '已关闭': 'close', '挂起': 'suspend' },
  '挂起': { '*': 'resume' },
  '已关闭': {},
  '已丢弃': {}
}

export const STATUS_TONE = {
  '需求调研中': 'gray', '待需求分析': 'blue', '需求分析中': 'indigo',
  '需求评审中': 'amber', '待开发': 'violet', '开发中': 'teal',
  '待测试验证': 'cyan', '测试验证中': 'cyan', '待UAT': 'orange',
  'UAT中': 'orange', '待试点': 'brown', '试点中': 'brown',
  '待上线发版': 'orange', '全国推广中': 'green',
  '已关闭': 'slate', '挂起': 'brown', '已丢弃': 'red'
}

export const STATUS_FILTERS = [...STATES]


export function canTransition(from, to) {
  if (from === to) return false
  const map = TRANSITIONS[from] || {}
  return Boolean(map[to] || map['*'])
}

const ROLE_ACTIONS = {
  admin: ['*'],
  pm: [
    'project.edit', 'member.manage', 'requirement.view', 'requirement.intake', 'requirement.clarify',
    'requirement.confirm', 'requirement.discard', 'requirement.merge', 'requirement.analyze',
    'prototype.generate', 'prototype.confirm', 'spec.publish', 'review.create',
    'review.decide', 'review.start', 'suggestion.close', 'change.create', 'change.resolve', 'status.advance',
    'batch.status', 'milestone.edit', 'iteration.spec.generate', 'iteration.spec.publish',
    'planning.schedule', 'export', 'share', 'chat', 'skill.manage', 'model.manage'
  ],
  reviewer: [
    'requirement.view', 'requirement.annotate', 'suggestion.reject_confirm',
    'review.decide', 'review.start', 'export', 'chat', 'status.review_submit', 'model.manage'
  ],
  developer: [
    'requirement.view', 'change.create', 'status.submit_acceptance', 'batch.status', 'milestone.edit', 'chat'
  ],
  guest: ['requirement.view.shared']
}

export function can(role, action) {
  if (!role) return false
  if (role === 'admin') return true
  return (ROLE_ACTIONS[role] || []).includes(action)
}

export function requireAction(role, action) {
  if (!can(role, action)) {
    const err = new Error(`当前角色无权执行：${action}`)
    err.statusCode = 403
    throw err
  }
}

export function membership(projectId, userId) {
  return get('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?', projectId, userId)
}

export function projectFor(user, projectId) {
  const project = get('SELECT * FROM projects WHERE id = ?', projectId)
  if (!project) { const e = new Error('项目不存在'); e.statusCode = 404; throw e }
  const member = membership(projectId, user.id)
  if (!member && user.role !== 'admin') {
    const e = new Error('无权访问该项目'); e.statusCode = 403; throw e
  }
  return { project, role: member?.role || (user.role === 'admin' ? 'admin' : null) }
}

export function requirementFor(user, requirementId) {
  const req = get('SELECT * FROM requirements WHERE id = ?', requirementId)
  if (!req) { const e = new Error('需求不存在'); e.statusCode = 404; throw e }
  const { project, role } = projectFor(user, req.project_id)
  return { req, project, role }
}

export function signSession(userId) {
  const body = Buffer.from(JSON.stringify({ uid: userId, t: Date.now() })).toString('base64url')
  const sig = crypto.createHmac('sha256', appSecret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifySession(token) {
  if (!token || !token.includes('.')) return null
  const [body, sig] = token.split('.')
  const expect = crypto.createHmac('sha256', appSecret).update(body).digest('base64url')
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()) } catch { return null }
}

export function parseCookies(header = '') {
  const out = {}
  header.split(';').forEach(part => {
    const idx = part.indexOf('=')
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  })
  return out
}

export function authMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '')
  const session = verifySession(cookies.sid)
  if (session) req.user = get('SELECT * FROM users WHERE id = ?', session.uid)
  next()
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录' })
  next()
}

export function encryptSecret(text) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(appSecret).digest(), iv)
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`
}

export function decryptSecret(payload) {
  try {
    const [ivB, tagB, dataB] = payload.split('.')
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(appSecret).digest(), Buffer.from(ivB, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8')
  } catch { return '' }
}

function auditProjectId(objectType, objectId) {
  switch (objectType) {
    case 'project': return objectId || null
    case 'requirement': return get('SELECT project_id FROM requirements WHERE id = ?', objectId)?.project_id || null
    case 'iteration': return get('SELECT project_id FROM iterations WHERE id = ?', objectId)?.project_id || null
    case 'prototype': return get('SELECT r.project_id FROM prototypes p JOIN requirements r ON r.id = p.requirement_id WHERE p.id = ?', objectId)?.project_id || null
    case 'spec': return get('SELECT r.project_id FROM specs s JOIN requirements r ON r.id = s.requirement_id WHERE s.id = ?', objectId)?.project_id || null
    case 'review': return get('SELECT r.project_id FROM reviews v JOIN requirements r ON r.id = v.requirement_id WHERE v.id = ?', objectId)?.project_id || null
    case 'suggestion': return get('SELECT r.project_id FROM suggestions g JOIN requirements r ON r.id = g.requirement_id WHERE g.id = ?', objectId)?.project_id || null
    case 'change': return get('SELECT r.project_id FROM changes c JOIN requirements r ON r.id = c.requirement_id WHERE c.id = ?', objectId)?.project_id || null
    case 'proposal': return get('SELECT r.project_id FROM proposals p JOIN requirements r ON r.id = p.requirement_id WHERE p.id = ?', objectId)?.project_id || null
    case 'share': return get('SELECT project_id FROM share_links WHERE id = ?', objectId)?.project_id || null
    default: return null
  }
}

export function recordAudit(req, action, objectType, objectId, before, after) {
  audit({
    projectId: req.projectId || auditProjectId(objectType, objectId), userId: req.user?.id, action, objectType, objectId,
    before, after, ip: req.ip
  })
}

export function notifyUser(projectId, userId, type, title, body) {
  notify({ userId, projectId, type, title, body })
  // 邮件通道：无外部 SMTP 时写入通知负载并留存，站内信不受影响
  logEvent({ projectId, type: 'notify', message: `通知 ${userId}：${title}`, payload: { channel: 'inapp+email', userId, title } })
}

export function bumpStall(reqId) {
  run('UPDATE requirements SET stall_since = ?, updated_at = ? WHERE id = ?', now(), now(), reqId)
}

export function requireFields(obj, fields, label = '参数') {
  const missing = fields.filter(f => obj[f] === undefined || obj[f] === null || obj[f] === '')
  if (missing.length) {
    const e = new Error(`${label}缺少必填项：${missing.join('、')}`)
    e.statusCode = 400
    throw e
  }
}

export function publicUser(u) {
  return u ? { id: u.id, name: u.name, title: u.title, role: u.role, avatar: u.avatar } : null
}

export function projectView(p) {
  return {
    ...p,
    goals: parseJson(p.goals_json, []),
    systemScope: parseJson(p.system_scope_json, {}),
    enterpriseScope: parseJson(p.enterprise_scope_json, {}),
    conventions: parseJson(p.conventions_json, {})
  }
}

export function requirementView(r) {
  const priority = parseJson(r.priority_json, null)
  const requester = parseJson(r.requester_json, null)
  return {
    ...r,
    source: parseJson(r.source_json, {}),
    clarification: parseJson(r.clarification_json, {}),
    involvedApps: parseJson(r.involved_apps_json, []),
    leads: parseJson(r.leads_json, {}),
    snapshot: parseJson(r.snapshot_json, null),
    priority,
    priorityLabel: priority?.grade ? (priority.gradeLabel || priority.grade) : '',
    statusLabel: statusLabel(r.status),
    statusIndex: STATUS_INDEX[r.status] ?? null,
    stage: statusStage(r.status),
    isLegacyStatus: isLegacyStatus(r.status),
    requester: requester ? {
      ...requester,
      levelText: requester.levelText || levelLabel(requester.level)
    } : null,
    milestones: r.milestones_json ? normalizeMilestones(r.milestones_json) : null
  }
}

export function eventView(e) {
  return { ...e, payload: parseJson(e.payload_json, {}) }
}

export function deliverNotifications(projectId, userIds, type, title, body) {
  ;[...new Set(userIds.filter(Boolean))].forEach(id => notifyUser(projectId, id, type, title, body))
}

export function allProjectPms(projectId) {
  return all("SELECT user_id FROM project_members WHERE project_id = ? AND role IN ('pm','admin')", projectId).map(r => r.user_id)
}

export { now, uid }
