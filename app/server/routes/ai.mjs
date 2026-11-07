import { Router } from 'express'
import { all, get, run, now, uid, parseJson, logEvent } from '../db.mjs'
import {
  requirementFor, projectFor, requireAction, recordAudit, encryptSecret,
  deliverNotifications, allProjectPms, statusStage, statusLabel
} from '../core.mjs'
import { transitionRequirement } from '../services/status.mjs'
import { modelConfig, callModel } from '../services/model.mjs'
import { latestAnalysis, saveAnalysis } from './analysis.mjs'
import { applyInstruction } from '../services/draft.mjs'
import { buildPrototypePages, checkAnalysis, normalizeAnalysis, specHtml, specMarkdown } from '../services/render.mjs'
import { similarity } from '../services/parse.mjs'
import { generateSkillDraft, missingInputs, assembleSkillInput, buildSkeleton, ANALYSIS_SKILL } from '../services/analysis-skill.mjs'
import { normalizeRequester, requesterIssues, requesterComplete } from '../services/requester.mjs'
import { extractClarification } from '../services/clarify-extract.mjs'
import { confirmRequirement } from '../services/confirm-core.mjs'
import {
  SKILL_STAGES, normalizeStages, listProjectSkills, projectSkillRow, projectSkillView,
  applicableSkills, executableSkill, importSkillPackage, referenceCandidates,
  referenceSkill, updateProjectSkill, removeProjectSkill, skillPackCoverage, repairSkillPack,
  BUILTIN_SKILL_PACK
} from '../services/skills.mjs'

export const aiRouter = Router()

const CLARIFY_LABELS = { requester: '提出方信息', roles: '角色与岗位', goal: '目标与价值', scope: '范围', boundary: '边界', acceptance: '验收口径', involvedApps: '涉及应用' }
const ACTION_DEFS = {
  update_clarification: {
    label: '补充澄清信息',
    description: '补充或修订需求的澄清字段，支持单字段或多字段批量补充（values）',
    schema: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: Object.keys(CLARIFY_LABELS) },
        value: { type: 'string' },
        values: {
          type: 'object',
          description: '多字段批量补充，键为澄清字段名',
          properties: {
            roles: { type: 'string' }, goal: { type: 'string' }, scope: { type: 'string' },
            boundary: { type: 'string' }, acceptance: { type: 'string' },
            requester: {
              type: 'object', description: '提出方信息',
              properties: {
                enterprise: { type: 'string' }, department: { type: 'string' }, name: { type: 'string' },
                level: { type: 'string', enum: ['high', 'middle', 'basic', 'external'] },
                position: { type: 'string' }, contact: { type: 'string' }, external: { type: 'boolean' }
              }
            },
            involvedApps: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    },
    summary: p => {
      if (p.values && typeof p.values === 'object') {
        const parts = Object.entries(p.values)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${CLARIFY_LABELS[k] || k}：${k === 'requester'
            ? [v.enterprise, v.department, v.name].filter(Boolean).join(' / ') || '—'
            : Array.isArray(v) ? v.join('、') : String(v).slice(0, 60)}`)
        return `批量补充澄清信息（${parts.length} 项）：${parts.join('；')}`
      }
      return `补充「${CLARIFY_LABELS[p.field] || p.field}」：${Array.isArray(p.value) ? p.value.join('、') : p.value}`
    },
  },
  confirm_requirement: {
    label: '确认需求入池', description: '校验六项后分配需求编号并进入需求池',
    schema: { type: 'object', properties: {} }, summary: () => '确认需求，分配编号并进入需求池',
  },
  generate_analysis: {
    label: '生成分析初稿', description: '基于澄清结论与来源材料生成四段分析初稿',
    schema: { type: 'object', properties: {} }, summary: () => '生成需求分析初稿（需求描述 / 业务流程 / 功能设计 / 集成说明）',
  },
  update_analysis: {
    label: '调整分析内容', description: '按自然语言指令修改分析内容',
    schema: { type: 'object', properties: { instruction: { type: 'string' } }, required: ['instruction'] },
    summary: p => `调整分析：${p.instruction}`,
  },
  generate_prototype: {
    label: '生成原型', description: '依据分析生成可交互原型页面',
    schema: { type: 'object', properties: {} }, summary: () => '生成界面原型（含默认、空、加载、错误、无权限状态）',
  },
  revise_prototype: {
    label: '原型改稿', description: '按自然语言调整原型页面',
    schema: { type: 'object', properties: { instruction: { type: 'string' } }, required: ['instruction'] },
    summary: p => `原型改稿：${p.instruction}`,
  },
  confirm_prototype: {
    label: '确认原型', description: '确认原型定稿并允许写入说明书',
    schema: { type: 'object', properties: {} }, summary: () => '确认原型定稿',
  },
  generate_spec: {
    label: '生成说明书', description: '组装需求分析说明书',
    schema: { type: 'object', properties: {} }, summary: () => '生成需求分析说明书',
  },
  publish_spec: {
    label: '发布说明书', description: '发布说明书并进入待评审',
    schema: { type: 'object', properties: {} }, summary: () => '发布说明书，需求进入待评审',
  },
  start_review: {
    label: '发起评审', description: '指定评审人并发起评审',
    schema: { type: 'object', properties: { reviewerIds: { type: 'array', items: { type: 'string' } }, deadline: { type: 'string' } } },
    summary: p => `发起评审${p.reviewerIds?.length ? '，评审人 ' + p.reviewerIds.length + ' 人' : ''}`,
  },
  add_annotation: {
    label: '添加批注', description: '在评审中记录意见并生成建议',
    schema: { type: 'object', properties: { section: { type: 'string' }, content: { type: 'string' }, quote: { type: 'string' } }, required: ['content'] },
    summary: p => `评审意见：${p.content}`,
  },
  close_suggestion: {
    label: '关闭建议', description: '关联新版本说明书关闭改进建议',
    schema: { type: 'object', properties: { suggestionId: { type: 'string' }, note: { type: 'string' } }, required: ['suggestionId'] },
    summary: p => `关闭建议 ${p.suggestionId}`,
  },
  request_change: {
    label: '发起变更', description: '登记需求变更并自动分级',
    schema: { type: 'object', properties: { reason: { type: 'string' }, content: { type: 'string' } }, required: ['reason', 'content'] },
    summary: p => `发起变更：${p.content}`,
  },
  advance_status: {
    label: '推进状态', description: '推进需求状态',
    schema: { type: 'object', properties: { to: { type: 'string' }, note: { type: 'string' } }, required: ['to'] },
    summary: p => `状态推进至 ${p.to}`,
  },
  schedule: {
    label: '排入迭代', description: '将需求排入指定迭代',
    schema: { type: 'object', properties: { iterationName: { type: 'string' }, iterationId: { type: 'string' } } }, summary: p => `排入迭代：${p.iterationName || p.iterationId || '未指定'}`,
  },
  link_related: {
    label: '关联需求', description: '标记与另一条需求的关联关系',
    schema: { type: 'object', properties: { requirementId: { type: 'string' }, reason: { type: 'string' } }, required: ['requirementId'] },
    summary: p => `关联需求：${p.requirementId}`,
  }
}

function projectOf(req) { return get('SELECT * FROM projects WHERE id = ?', req.project_id) }
function scopeOf(project) {
  const s = parseJson(project.system_scope_json, {})
  return { ...s, all: [...(s.platforms || []), ...(s.applications || []), ...(s.modules || [])] }
}
function gapsOf(req, project) {
  const clar = parseJson(req.clarification_json, {})
  const answers = clar.answers || {}
  const gaps = ['roles', 'goal', 'scope', 'boundary', 'acceptance'].filter(k => !answers[k]?.value)
  const requester = parseJson(req.requester_json, null) || normalizeRequester({}, project, {})
  if (!requesterComplete(requester, project)) gaps.unshift('requester')
  if (!parseJson(req.involved_apps_json, []).length) gaps.push('involvedApps')
  return gaps
}
function addMessage(reqId, role, content, proposalId = null) {
  const id = uid('MSG-')
  run('INSERT INTO chat_messages (id, requirement_id, role, content, proposal_id, created_at) VALUES (?,?,?,?,?,?)',
    id, reqId, role, content, proposalId, now())
  return id
}
function createProposal(req, action, payload, userId) {
  const def = ACTION_DEFS[action]
  if (!def) throw Object.assign(new Error('动作不在封闭清单中：' + action), { statusCode: 400 })
  const id = uid('PROP-')
  run('INSERT INTO proposals (id, requirement_id, action, payload_json, diff_json, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
    id, req.id, action, JSON.stringify(payload), JSON.stringify({ summary: def.summary(payload) }), 'pending', userId || req.owner_id || req.confirmed_by, now())
  return { id, action, label: def.label, payload, summary: def.summary(payload), status: 'pending' }
}

function stageOfRequirement(req) {
  return statusStage(req.status)
}

const CONVERSATION_STAGES = ['clarify', 'analysis', 'prototype', 'review', 'change']

function conversationStage(value, fallback) {
  const stage = value ? normalizeStages([value])[0] : fallback
  if (!CONVERSATION_STAGES.includes(stage)) {
    const e = new Error(`会话与手动执行不支持环节：${value || stage}`)
    e.statusCode = 400
    throw e
  }
  return stage
}

function logSkillCall({ projectId, reqId, skill, stage, triggerType, status, provider = 'skill-runtime', model, usage = {} }) {
  const prompt = usage.prompt_tokens || 0
  const completion = usage.completion_tokens || 0
  run(`INSERT INTO llm_calls (id, project_id, requirement_id, skill_slug, stage, trigger_type, provider, model,
       prompt_tokens, completion_tokens, cost, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uid('LLM-'), projectId, reqId, skill?.slug || 'skill', stage || '', triggerType || 'manual',
    provider, model || (skill ? `v${skill.version}` : ''), prompt, completion,
    prompt * 0.0000015 + completion * 0.000002, status, now())
}

function skillContext(req, project) {
  const clar = parseJson(req.clarification_json, {})
  const answers = clar.answers || {}
  const apps = parseJson(req.involved_apps_json, [])
  const analysis = latestAnalysis(req.id).analysis
  const desc = analysis.description || {}
  return [
    `项目：${project.name}`,
    `需求：${req.code || '未编号'} ${req.title}`,
    `状态：${req.status}`,
    `目标与价值：${answers.goal?.value || '未填写'}`,
    `范围：${answers.scope?.value || '未填写'}`,
    `边界：${answers.boundary?.value || '未填写'}`,
    `验收口径：${answers.acceptance?.value || '未填写'}`,
    `涉及应用：${apps.map(a => a.name).join('、') || '未填写'}`,
    desc.background ? `分析背景：${desc.background}` : '',
    desc.goal ? `分析目标：${desc.goal}` : ''
  ].filter(Boolean).join('\n')
}

const CLARIFY_SKILLS = new Set(['clarify', 'prd-discovery', 'grill-me', 'grilling'])
const ANALYSIS_SKILLS = new Set(['analyze', 'prd-analysis'])
const PROTOTYPE_SKILLS = new Set(['prototype', 'prd-prototype'])
const REVIEW_SKILLS = new Set(['review', 'prd-quality'])

async function runSkillRuntime({ req, project, user, skill, stage, triggerType }) {
  let proposal = null
  let content = ''
  let status = 'success'
  if (CLARIFY_SKILLS.has(skill.slug)) {
    const gaps = gapsOf(req, project)
    content = gaps.length
      ? `技能「${skill.name}」识别到 ${gaps.length} 个澄清缺口：${gaps.map(g => CLARIFY_LABELS[g]).join('、')}。请逐项补充。`
      : `技能「${skill.name}」检查完成：澄清七项已齐备，可以确认入池。`
  } else if (ANALYSIS_SKILLS.has(skill.slug)) {
    proposal = createProposal(req, 'generate_analysis', {}, user.id)
    content = `技能「${skill.name}」已生成四段分析初稿提案，确认后才会写入。`
  } else if (PROTOTYPE_SKILLS.has(skill.slug)) {
    proposal = createProposal(req, 'generate_prototype', {}, user.id)
    content = `技能「${skill.name}」已生成页面规划提案，确认后才会生成原型。`
  } else if (REVIEW_SKILLS.has(skill.slug)) {
    const open = all("SELECT * FROM suggestions WHERE requirement_id = ? AND status IN ('待处理','处理中')", req.id)
    content = open.length
      ? `技能「${skill.name}」汇总 ${open.length} 条未闭环建议，建议按章节逐条处理。`
      : `技能「${skill.name}」检查完成：当前没有未闭环建议。`
  } else if (!skill.promptTemplate) {
    content = `技能「${skill.name}」已执行，未产生写操作。`
  } else {
    const cfg = modelConfig(project.id)
    if (!cfg) {
      status = 'model-unavailable'
      content = `技能「${skill.name}」未执行：项目尚未配置模型网关。`
    } else {
      try {
        const resp = await callModel(cfg, [
          { role: 'system', content: skill.promptTemplate },
          { role: 'user', content: skillContext(req, project) }
        ])
        content = (resp.choices?.[0]?.message?.content || '').trim() || `技能「${skill.name}」已执行，未返回内容。`
        logSkillCall({ projectId: project.id, reqId: req.id, skill, stage, triggerType, status: 'success', provider: cfg.baseUrl, model: cfg.model, usage: resp.usage || {} })
        return { content, proposal, status: 'success' }
      } catch (err) {
        status = 'error'
        content = `技能「${skill.name}」执行失败：${err.message}`
      }
    }
  }
  logSkillCall({ projectId: project.id, reqId: req.id, skill, stage, triggerType, status })
  return { content, proposal, status }
}

function latestProto(reqId) {
  return get('SELECT * FROM prototypes WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', reqId)
}
function latestSpec(reqId) {
  return get('SELECT * FROM specs WHERE requirement_id = ? ORDER BY version DESC LIMIT 1', reqId)
}

function relatedTo(req, project, limit = 3) {
  return all("SELECT id, code, title, status FROM requirements WHERE project_id = ? AND id != ? AND status NOT IN ('已丢弃','需求调研中')", project.id, req.id)
    .map(r => ({ ...r, score: similarity(req.title + JSON.stringify(parseJson(req.source_json, {})), r.title) }))
    .filter(r => r.score > 0.16).sort((a, b) => b.score - a.score).slice(0, limit)
}

function interpret(message, ctx) {
  const text = String(message || '').trim()
  const { req, project } = ctx
  const scope = scopeOf(project)
  const haystack = [text, ...(ctx.texts || [])].join('\n')
  const foundApps = scope.all.filter(name => haystack.includes(name))
  if (/涉及(的)?应用|应用包括|应用有/.test(text)) {
    if (!foundApps.length) return { reply: `未在项目系统范围中识别到应用。当前范围：${scope.all.join('、') || '未配置'}。请直接选择或说明应用名称。` }
    return { action: 'update_clarification', payload: { field: 'involvedApps', value: foundApps.join('、') } }
  }
  if (/^(确认|确认需求|入池)$/.test(text) || /确认.*(入池|需求)/.test(text)) return { action: 'confirm_requirement', payload: {} }
  for (const [key, label] of [['roles', '角色'], ['goal', '目标'], ['scope', '范围'], ['boundary', '边界'], ['acceptance', '验收']]) {
    const m = text.match(new RegExp(`(?:${label}|${CLARIFY_LABELS[key]})(?:是|为|：|:)(.+)`))
    if (m) return { action: 'update_clarification', payload: { field: key, value: m[1].replace(/^[：:，,\s]+/, '').replace(/^[「“"]|[」”"]$/g, '').trim() } }
  }
  if (/生成.*分析|分析初稿|帮我分析|开始分析/.test(text)) return { action: 'generate_analysis', payload: {} }
  if (/改|调整|修改/.test(text) && /原型|页面|按钮|布局|表格|表单/.test(text)) return { action: 'revise_prototype', payload: { instruction: text } }
  if (/确认.*原型/.test(text)) return { action: 'confirm_prototype', payload: {} }
  if (/生成.*原型|出.*原型|做.*demo|生成.*demo|原型demo/i.test(text)) return { action: 'generate_prototype', payload: {} }
  if (/发布.*说明书|说明书.*发布/.test(text)) return { action: 'publish_spec', payload: {} }
  if (/生成.*说明书|说明书.*生成|更新.*说明书|更新.*文档/.test(text)) return { action: 'generate_spec', payload: {} }
  if (/发起.*评审|开始评审|安排评审/.test(text)) return { action: 'start_review', payload: {} }
  if (/批注|评审意见|提个意见/.test(text)) {
    return { action: 'add_annotation', payload: { section: (text.match(/第?([一二三四五六七\d]+)章|功能设计|验收口径|业务流程|集成说明/) || [])[0] || '功能设计', content: text } }
  }
  if (/关闭.*建议|消除.*建议/.test(text)) {
    const s = get("SELECT * FROM suggestions WHERE requirement_id = ? AND status IN ('待处理','处理中') ORDER BY seq LIMIT 1", req.id)
    if (!s) return { reply: '当前没有待闭环的评审建议。' }
    return { action: 'close_suggestion', payload: { suggestionId: s.id, note: text } }
  }
  if (/变更|调整需求范围|需求改了/.test(text)) return { action: 'request_change', payload: { reason: text, content: text } }
  if (/排期|排入|放进迭代/.test(text)) {
    const its = all('SELECT * FROM iterations WHERE project_id = ?', project.id)
    const hit = its.find(i => text.includes(i.name))
    return { action: 'schedule', payload: { iterationName: hit?.name || its[0]?.name || '', iterationId: hit?.id || its[0]?.id || '' } }
  }
  if (/进入开发|提交测试|提交验收|上线|关闭需求|挂起|恢复/.test(text)) {
    const to = /进入开发/.test(text) ? '开发中'
      : /提交测试|提交验收/.test(text) ? '待测试验证'
        : /上线/.test(text) ? '待上线发版'
          : /关闭需求/.test(text) ? '已关闭'
            : /挂起/.test(text) ? '挂起' : '恢复'
    return { action: 'advance_status', payload: { to, note: text } }
  }
  if (/关联|相关需求/.test(text)) {
    const related = relatedTo(req, project, 1)[0]
    if (!related) return { reply: '需求池中暂未发现明显关联的需求。' }
    return { action: 'link_related', payload: { requirementId: related.id, reason: text } }
  }
  if (['待需求分析', '需求分析中', '需求评审中', '待开发', '开发中'].includes(req.status)) return { action: 'update_analysis', payload: { instruction: text } }
  return { reply: `我理解你想表达「${text.slice(0, 40)}」。当前需求处于「${statusLabel(req.status)}」，可以：${req.status === '需求调研中' ? '补充澄清信息或确认入池' : '继续调整分析、生成原型或发起评审'}。` }
}

export async function extractTextFromImage(projectId, base64, mime) {
  const cfg = modelConfig(projectId)
  if (!cfg) return { ok: false, reason: '未配置模型网关，图片已保留，请人工录入需求文字' }
  try {
    const r = await callModel(cfg, [{
      role: 'user',
      content: [
        { type: 'text', text: '请提取图片中的全部需求文字，保持原文与段落顺序，不要总结、不要补充。' },
        { type: 'image_url', image_url: { url: `data:${mime || 'image/png'};base64,${base64}` } }
      ]
    }])
    const text = (r.choices?.[0]?.message?.content || '').trim()
    if (!text) return { ok: false, reason: '图片中未识别出文字，已保留原文件，请人工录入' }
    return { ok: true, text }
  } catch (e) {
    return { ok: false, reason: `图片识别失败：${e.message}，已保留原文件，请人工录入` }
  }
}

function toolDefs(extra = []) {
  return [
    ...Object.entries(ACTION_DEFS).map(([name, def]) => ({
      type: 'function',
      function: { name, description: def.description, parameters: def.schema }
    })),
    ...extra
  ]
}

aiRouter.get('/requirements/:id/messages', (hr, res, next) => {
  try {
    const { req } = requirementFor(hr.user, hr.params.id)
    const msgs = all('SELECT * FROM chat_messages WHERE requirement_id = ? ORDER BY created_at', req.id)
    const proposals = all('SELECT * FROM proposals WHERE requirement_id = ? ORDER BY created_at DESC LIMIT 30', req.id)
    res.json({
      messages: msgs.map(m => ({ ...m, proposal: proposals.find(p => p.id === m.proposal_id) ? { ...proposals.find(p => p.id === m.proposal_id), payload: parseJson(proposals.find(p => p.id === m.proposal_id).payload_json, {}), diff: parseJson(proposals.find(p => p.id === m.proposal_id).diff_json, {}) } : null })),
      pending: proposals.filter(p => p.status === 'pending').map(p => ({ ...p, payload: parseJson(p.payload_json, {}), diff: parseJson(p.diff_json, {}), label: ACTION_DEFS[p.action]?.label || p.action }))
    })
  } catch (e) { next(e) }
})

aiRouter.post('/requirements/:id/chat', async (hr, res, next) => {
  try {
    const { req, project, role } = requirementFor(hr.user, hr.params.id)
    if (!['pm', 'reviewer', 'admin', 'developer'].includes(role)) { const e = new Error('当前角色不能使用会话'); e.statusCode = 403; throw e }
    const message = String(hr.body?.message || '').trim()
    if (!message) { const e = new Error('消息不能为空'); e.statusCode = 400; throw e }
    addMessage(req.id, 'user', message)
    const recent = all("SELECT role, content FROM chat_messages WHERE requirement_id = ? ORDER BY created_at DESC LIMIT 12", req.id)
    const texts = recent.filter(m => m.role === 'user').map(m => m.content).reverse()
    const stage = conversationStage(hr.body?.stage, stageOfRequirement(req))
    const usableSkills = applicableSkills(project.id, stage)
    const related = relatedTo(req, project)
    const cfg = modelConfig(project.id)
    let proposal = null
    let reply = ''
    let engine = 'rules'
    let usedSkill = null
    if (cfg) {
      try {
        engine = 'model'
        const gapsNow = gapsOf(req, project)
        const skillLines = usableSkills.length
          ? usableSkills.map(s => `- ${s.id}｜${s.name}｜${s.description || '无说明'}${s.stages.length ? `｜限定环节：${s.stages.join('、')}` : '｜未限定环节，可自行判断'}`).join('\n')
          : '无'
        const sys = `你是需求管理工作台的助手。当前项目：${project.name}；系统范围：${scopeOf(project).all.join('、')}。
当前需求：${req.code || '未编号'} ${req.title}，状态：${statusLabel(req.status)}，当前环节：${stage}。
澄清缺口：${gapsNow.map(g => CLARIFY_LABELS[g]).join('、') || '无'}。
关联需求：${related.map(r => `${r.code} ${r.title}`).join('；') || '无'}。
当前环节可用技能：
${skillLines}
规则：只能从提供的动作中选择一个执行；需要时可以先调用 use_skill 使用一个可用技能，调用时必须在回复中说明技能名称与理由；update_clarification 支持 values 对象一次批量补充多个澄清字段（roles/goal/scope/boundary/acceptance/requester/involvedApps），requester 的值是对象（enterprise/department/name/level/position/contact/external）；信息不足时不要编造，直接在回复中说明需要补充什么。所有写操作都会生成提案，需用户确认后生效。`
        const history = recent.slice(0, 8).reverse().map(m => ({ role: m.role, content: m.content }))
        const skillTools = usableSkills.length ? [{
          type: 'function',
          function: {
            name: 'use_skill',
            description: '在当前环节使用一个项目技能，需说明理由',
            parameters: {
              type: 'object',
              properties: {
                bindingId: { type: 'string', enum: usableSkills.map(s => s.id) },
                reason: { type: 'string' }
              },
              required: ['bindingId']
            }
          }
        }] : []
        const resp = await callModel(cfg, [{ role: 'system', content: sys }, ...history], toolDefs(skillTools))
        const choice = resp.choices?.[0]?.message
        const usage = resp.usage || {}
        run(`INSERT INTO llm_calls (id, project_id, requirement_id, skill_slug, stage, trigger_type, provider, model, prompt_tokens, completion_tokens, cost, status, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          uid('LLM-'), project.id, req.id, 'chat', stage, 'chat', cfg.baseUrl, cfg.model,
          usage.prompt_tokens || 0, usage.completion_tokens || 0,
          ((usage.prompt_tokens || 0) * 0.0000015 + (usage.completion_tokens || 0) * 0.000002), 'success', now())
        const calls = choice?.tool_calls || []
        const actionCall = calls.find(c => c?.function?.name && ACTION_DEFS[c.function.name])
        const skillCall = calls.find(c => c?.function?.name === 'use_skill')
        if (actionCall) {
          let payload = {}
          try { payload = JSON.parse(actionCall.function.arguments || '{}') } catch { payload = {} }
          proposal = createProposal(req, actionCall.function.name, payload, hr.user.id)
          reply = choice.content || `已生成提案：${proposal.summary}`
        } else if (skillCall) {
          let payload = {}
          try { payload = JSON.parse(skillCall.function.arguments || '{}') } catch { payload = {} }
          const skill = executableSkill(project.id, payload.bindingId, stage)
          const result = await runSkillRuntime({ req, project, user: hr.user, skill, stage, triggerType: 'auto' })
          usedSkill = { id: skill.id, slug: skill.slug, name: skill.name, version: skill.version }
          if (!proposal && result.proposal) proposal = result.proposal
          const intro = choice.content?.trim() || `使用技能「${skill.name}」${payload.reason ? `：${payload.reason}` : ''}`
          reply = `${intro}\n\n${result.content}`
        } else {
          reply = choice?.content || '模型没有给出可执行动作，请补充更具体的指令。'
        }
      } catch (err) {
        engine = 'rules'
        run(`INSERT INTO llm_calls (id, project_id, requirement_id, skill_slug, stage, trigger_type, provider, model, prompt_tokens, completion_tokens, cost, status, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          uid('LLM-'), project.id, req.id, 'chat', stage, 'chat', cfg.baseUrl, cfg.model, 0, 0, 0, 'error', now())
        reply = `模型调用失败（${err.message}），已切换规则引擎处理。`
      }
    }
    if (!proposal && engine === 'rules') {
      const intent = interpret(message, { req, project, texts })
      if (intent.action) {
        proposal = createProposal(req, intent.action, intent.payload, hr.user.id)
        reply = (reply ? reply + '\n' : '') + `已生成提案：${proposal.summary}。确认后才会写入。`
      } else if (req.status === '需求调研中') {
        const extracted = extractClarification(texts, { project, scopeAll: scopeOf(project).all })
        if (extracted) {
          proposal = createProposal(req, 'update_clarification', { values: extracted.values }, hr.user.id)
          const gapsLeft = gapsOf(req, project)
          reply = (reply ? reply + '\n' : '') + `已生成提案：${proposal.summary}。确认后才会写入。`
            + (gapsLeft.length ? `\n写入后仍待补齐：${gapsLeft.map(g => CLARIFY_LABELS[g]).join('、')}。` : '\n写入后澄清清单即齐备，可以确认入池。')
        } else {
          reply = (reply ? reply + '\n' : '') + (intent.reply || '请说明希望我做什么。')
        }
      } else {
        reply = (reply ? reply + '\n' : '') + (intent.reply || '请说明希望我做什么。')
      }
    }
    const msgId = addMessage(req.id, 'assistant', reply, proposal?.id || null)
    res.json({ messageId: msgId, reply, proposal, engine, stage, usedSkill })
  } catch (e) { next(e) }
})

aiRouter.get('/proposals/:id', (hr, res, next) => {
  try {
    const p = get('SELECT * FROM proposals WHERE id = ?', hr.params.id)
    if (!p) { const e = new Error('提案不存在'); e.statusCode = 404; throw e }
    const { req } = requirementFor(hr.user, p.requirement_id)
    res.json({ ...p, payload: parseJson(p.payload_json, {}), diff: parseJson(p.diff_json, {}), label: ACTION_DEFS[p.action]?.label, requirement: { id: req.id, code: req.code, title: req.title, status: req.status } })
  } catch (e) { next(e) }
})

aiRouter.post('/proposals/:id/discard', (hr, res, next) => {
  try {
    const p = get('SELECT * FROM proposals WHERE id = ?', hr.params.id)
    if (!p) { const e = new Error('提案不存在'); e.statusCode = 404; throw e }
    requirementFor(hr.user, p.requirement_id)
    if (p.status !== 'pending') { const e = new Error('提案已处理'); e.statusCode = 400; throw e }
    run("UPDATE proposals SET status = 'discarded' WHERE id = ?", p.id)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

aiRouter.post('/proposals/:id/apply', (hr, res, next) => {
  try {
    const p = get('SELECT * FROM proposals WHERE id = ?', hr.params.id)
    if (!p) { const e = new Error('提案不存在'); e.statusCode = 404; throw e }
    const { req, project, role } = requirementFor(hr.user, p.requirement_id)
    if (p.status !== 'pending') { const e = new Error('提案已处理'); e.statusCode = 400; throw e }
    if (p.created_by !== hr.user.id && role !== 'admin') {
      const e = new Error('仅提案发起人或管理员可确认'); e.statusCode = 403; throw e
    }
    const payload = parseJson(p.payload_json, {})
    const result = applyAction(p.action, payload, { req, project, role, user: hr.user })
    run("UPDATE proposals SET status = 'applied', applied_at = ? WHERE id = ?", now(), p.id)
    logEvent({ projectId: project.id, requirementId: req.id, type: 'proposal-apply', message: `应用提案：${ACTION_DEFS[p.action]?.label}`, payload: { action: p.action, result }, actorId: hr.user.id })
    recordAudit(hr, 'proposal.apply', 'proposal', p.id, null, { action: p.action, payload })
    res.json({ ok: true, result })
  } catch (e) { next(e) }
})

function applyAction(action, payload, ctx) {
  const { req, project, role, user } = ctx
  const scope = scopeOf(project)
  switch (action) {
    case 'update_clarification': {
      if (req.status !== '需求调研中') throw Object.assign(new Error('需求已确认，澄清信息已冻结；如需调整请通过分析补充或发起变更'), { statusCode: 400 })
      const entries = payload.values && typeof payload.values === 'object'
        ? Object.entries(payload.values)
        : [[payload.field, payload.value]]
      if (!entries.length) throw Object.assign(new Error('提案缺少澄清内容'), { statusCode: 400 })
      for (const [f, v] of entries) {
        if (!CLARIFY_LABELS[f]) throw Object.assign(new Error('未知澄清字段'), { statusCode: 400 })
        if (v === undefined || v === null || v === '') throw Object.assign(new Error(`澄清字段「${CLARIFY_LABELS[f]}」内容为空`), { statusCode: 400 })
      }
      const clar = parseJson(req.clarification_json, { answers: {}, history: [] })
      clar.answers = clar.answers || {}
      clar.history = clar.history || []
      let apps = parseJson(req.involved_apps_json, [])
      let requester = parseJson(req.requester_json, null) || normalizeRequester({}, project, {})
      const applyField = (field, value) => {
        if (field === 'involvedApps') {
          const names = Array.isArray(value) ? value : String(value).split(/[、,，\s]+/).filter(Boolean)
          apps = names.map(name => {
            const hit = scope.all.find(x => x === name || name.includes(x))
            return { name: hit || name, kind: hit ? 'internal' : 'external', confidence: hit ? 0.9 : 0.5, reason: '会话确认' }
          })
          clar.history.push({ field: 'involvedApps', answer: apps.map(a => a.name).join('、'), at: now(), by: user.name, source: 'ai' })
        } else if (field === 'requester') {
          requester = normalizeRequester(typeof value === 'object' ? value : {}, project, requester)
          requester.source = 'ai'
          clar.history.push({ field: 'requester', answer: `${requester.enterprise || '—'} / ${requester.department || '—'} / ${requester.name || '—'}`, at: now(), by: user.name, source: 'ai' })
        } else {
          clar.answers[field] = { value, at: now(), by: user.name, source: 'ai' }
          clar.history.push({ field, answer: value, at: now(), by: user.name, source: 'ai' })
        }
      }
      for (const [f, v] of entries) applyField(f, v)
      const merged = { ...req, clarification_json: JSON.stringify(clar), involved_apps_json: JSON.stringify(apps), requester_json: JSON.stringify(requester) }
      clar.completed = gapsOf(merged, project).length === 0
      run('UPDATE requirements SET clarification_json = ?, involved_apps_json = ?, requester_json = ?, updated_at = ?, stall_since = ? WHERE id = ?',
        JSON.stringify(clar), JSON.stringify(apps), JSON.stringify(requester), now(), now(), req.id)
      return { gaps: gapsOf(merged, project), requesterIssues: requesterIssues(requester, project) }
    }
    case 'confirm_requirement': {
      requireAction(role, 'requirement.confirm')
      if (req.status !== '需求调研中') throw Object.assign(new Error('仅需求调研中的需求可确认'), { statusCode: 400 })
      const gaps = gapsOf(req, project)
      if (gaps.length) throw Object.assign(new Error(`确认清单不完整：${gaps.map(g => CLARIFY_LABELS[g]).join('、')}`), { statusCode: 400 })
      const apps = parseJson(req.involved_apps_json, [])
      const outside = apps.filter(a => a.kind !== 'external' && !scope.all.includes(a.name))
      if (outside.length) throw Object.assign(new Error(`涉及应用超出项目范围：${outside.map(a => a.name).join('、')}`), { statusCode: 400 })
      const clar = parseJson(req.clarification_json, {})
      const requester = parseJson(req.requester_json, null) || normalizeRequester({}, project, {})
      const rIssues = requesterIssues(requester, project)
      if (rIssues.length) throw Object.assign(new Error(rIssues.map(i => i.message).join('；')), { statusCode: 400 })
      const result = confirmRequirement({
        req: { ...req, requester_json: JSON.stringify(requester) }, project, user,
        body: payload, requester, apps, clar, scopeAll: scope.all
      })
      deliverNotifications(project.id, [req.owner_id || user.id], 'requirement', `需求已确认：${result.code}`, req.title)
      recordAudit({ user, projectId: project.id }, 'requirement.confirm', 'requirement', req.id, { status: '需求调研中' }, { status: '待需求分析', code: result.code, grade: result.priority.grade })
      return { code: result.code, priority: result.priority.gradeLabel, milestones: result.milestones }
    }
    case 'generate_analysis': {
      requireAction(role, 'requirement.analyze')
      if (!['待需求分析', '需求分析中'].includes(req.status)) throw Object.assign(new Error(`当前状态「${statusLabel(req.status)}」不能生成分析`), { statusCode: 400 })
      const related = relatedTo(req, project)
      const missing = missingInputs({ req, project })
      if (missing.length) {
        const e = new Error(`生成分析初稿缺少输入：${missing.map(m => m.label).join('、')}`)
        e.statusCode = 400; e.details = missing; e.missing = missing; throw e
      }
      const prior = all('SELECT version, created_at FROM requirement_versions WHERE requirement_id = ? ORDER BY version DESC LIMIT 3', req.id)
      let draft = generateSkillDraft({ req, project, related, priorAnalyses: prior, missing })
      if (!draft.ok) draft = generateSkillDraft({ req, project, related, priorAnalyses: prior, missing })
      logSkillCall({
        projectId: project.id, reqId: req.id, stage: 'analysis', triggerType: 'manual',
        skill: { slug: ANALYSIS_SKILL.slug, version: ANALYSIS_SKILL.version },
        status: draft.ok ? 'success' : 'quality-failed'
      })
      if (!draft.ok) {
        const input = assembleSkillInput({ req, project, related, priorAnalyses: prior })
        const skeleton = buildSkeleton(input, missing, 'quality-gate')
        const issues = draft.quality.issues.filter(i => i.level === 'error').map(i => i.message)
        return {
          saved: false, skeleton,
          quality: draft.quality,
          message: `分析初稿未通过质量门禁：${issues.join('；')}。已生成待补充骨架，未写入分析版本。`
        }
      }
      const saved = saveAnalysis({
        req, project, user, analysis: draft.analysis,
        note: `${ANALYSIS_SKILL.slug} ${ANALYSIS_SKILL.version} 生成分析初稿`, source: 'skill'
      })
      return {
        version: saved.version, changed: saved.changed, quality: draft.quality,
        skill: ANALYSIS_SKILL, generatedBy: 'rules', evidence: draft.analysis.meta?.evidence || {}
      }
    }
    case 'update_analysis': {
      requireAction(role, 'requirement.analyze')
      const latest = latestAnalysis(req.id)
      const { analysis, changes } = applyInstruction(latest.analysis, payload.instruction)
      const saved = saveAnalysis({ req, project, user, analysis, note: `会话调整：${String(payload.instruction).slice(0, 40)}`, source: 'ai' })
      return { version: saved.version, changes }
    }
    case 'generate_prototype': {
      requireAction(role, 'prototype.generate')
      if (!['待需求分析', '需求分析中'].includes(req.status)) throw Object.assign(new Error(`当前状态「${statusLabel(req.status)}」不能生成原型`), { statusCode: 400 })
      const latest = latestAnalysis(req.id)
      if (!latest.version) throw Object.assign(new Error('尚未提交分析'), { statusCode: 400 })
      const check = checkAnalysis(latest.analysis, req, project)
      if (!check.ok) { const e = new Error('分析未通过校验：' + check.issues.filter(i => i.level === 'error').map(i => i.message).join('；')); e.statusCode = 400; e.details = check.issues; throw e }
      const pages = buildPrototypePages(latest.analysis, req)
      const last = latestProto(req.id)
      const version = (last?.version || 0) + 1
      const id = uid('PT-')
      run('INSERT INTO prototypes (id, requirement_id, version, pages_json, status, analysis_version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, req.id, version, JSON.stringify(pages), 'draft', latest.version, user.id, now(), now())
      if (req.status === '待需求分析') {
        run("UPDATE requirements SET status = '需求分析中', stall_since = ?, updated_at = ? WHERE id = ?", now(), now(), req.id)
        logEvent({ projectId: project.id, requirementId: req.id, type: 'status', message: '待需求分析 → 需求分析中', payload: { from: '待需求分析', to: '需求分析中' }, actorId: user.id })
      }
      return { prototypeId: id, version, pages: pages.length }
    }
    case 'revise_prototype': {
      requireAction(role, 'prototype.generate')
      const proto = latestProto(req.id)
      if (!proto) throw Object.assign(new Error('尚未生成原型'), { statusCode: 400 })
      const pages = parseJson(proto.pages_json, [])
      const target = pages.find(p => p.kind === 'function') || pages[0]
      target.subtitle = `${target.subtitle || ''}${target.subtitle ? ' · ' : ''}${payload.instruction.slice(0, 60)}`
      const latest = latestAnalysis(req.id)
      const analysis = normalizeAnalysis(latest.analysis)
      analysis.meta.revisionNotes = [...(analysis.meta.revisionNotes || []), { instruction: payload.instruction, at: now(), by: user.name }]
      const saved = saveAnalysis({ req, project, user, analysis, note: `原型改稿同步：${payload.instruction.slice(0, 30)}`, source: 'ai' })
      const version = proto.version + 1
      const id = uid('PT-')
      run('INSERT INTO prototypes (id, requirement_id, version, pages_json, status, analysis_version, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, req.id, version, JSON.stringify(pages), 'draft', saved.version, user.id, now(), now())
      return { prototypeId: id, version, analysisVersion: saved.version }
    }
    case 'confirm_prototype': {
      requireAction(role, 'prototype.confirm')
      const proto = latestProto(req.id)
      if (!proto) throw Object.assign(new Error('尚未生成原型'), { statusCode: 400 })
      run("UPDATE prototypes SET status = 'confirmed', updated_at = ? WHERE id = ?", now(), proto.id)
      return { version: proto.version }
    }
    case 'generate_spec': {
      requireAction(role, 'spec.publish')
      const latest = latestAnalysis(req.id)
      const proto = latestProto(req.id)
      if (!latest.version) throw Object.assign(new Error('缺少分析版本'), { statusCode: 400 })
      if (!proto || proto.status !== 'confirmed') throw Object.assign(new Error('原型尚未确认，无法写入说明书'), { statusCode: 400 })
      const last = latestSpec(req.id)
      const version = (last?.version || 0) + 1
      const pages = parseJson(proto.pages_json, [])
      const reviews = all('SELECT * FROM reviews WHERE requirement_id = ? ORDER BY round', req.id)
      const changes = all('SELECT * FROM changes WHERE requirement_id = ? ORDER BY seq', req.id)
      const id = uid('SPEC-')
      const md = specMarkdown({ req, project, analysis: latest.analysis, pages, version, reviews, changes })
      const html = specHtml({ req, project, analysis: latest.analysis, pages, version, reviews, changes, protoId: proto.id })
      run('INSERT INTO specs (id, requirement_id, version, markdown, html, analysis_version, prototype_version, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id, req.id, version, md, html, latest.version, proto.version, 'draft', user.id, now(), now())
      return { specId: id, version }
    }
    case 'publish_spec': {
      requireAction(role, 'spec.publish')
      const spec = latestSpec(req.id)
      if (!spec) throw Object.assign(new Error('尚未生成说明书'), { statusCode: 400 })
      run("UPDATE specs SET status = 'published', updated_at = ? WHERE id = ?", now(), spec.id)
      run("UPDATE specs SET status = 'superseded' WHERE requirement_id = ? AND id != ? AND status = 'published'", req.id, spec.id)
      if (['待需求分析', '需求分析中'].includes(req.status)) {
        run("UPDATE requirements SET status = '需求评审中', stall_since = ?, updated_at = ? WHERE id = ?", now(), now(), req.id)
        logEvent({ projectId: project.id, requirementId: req.id, type: 'status', message: `${req.status} → 需求评审中`, payload: { from: req.status, to: '需求评审中' }, actorId: user.id })
      }
      return { version: spec.version }
    }
    case 'start_review': {
      requireAction(role, 'review.create')
      const spec = get("SELECT * FROM specs WHERE requirement_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1", req.id)
      if (!spec) throw Object.assign(new Error('说明书尚未发布'), { statusCode: 400 })
      let reviewers = payload.reviewerIds || []
      if (reviewers.length < 2) {
        reviewers = all("SELECT user_id FROM project_members WHERE project_id = ? AND role = 'reviewer'", project.id).map(r => r.user_id).slice(0, 3)
      }
      if (reviewers.length < 2) reviewers = allProjectPms(project.id).filter(id => id !== user.id).slice(0, 2)
      if (reviewers.length < 2) throw Object.assign(new Error('评审人不足两人，请先在项目成员中指定评审人'), { statusCode: 400 })
      const last = get('SELECT MAX(round) AS m FROM reviews WHERE requirement_id = ?', req.id)
      const round = (last?.m || 0) + 1
      const id = uid('RV-')
      run('INSERT INTO reviews (id, requirement_id, spec_id, round, reviewers_json, deadline, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id, req.id, spec.id, round, JSON.stringify(reviewers), payload.deadline || '', '待开始', user.id, now())
      if (req.status === '需求分析中') {
        run("UPDATE requirements SET status = '需求评审中', stall_since = ?, updated_at = ? WHERE id = ?", now(), now(), req.id)
      }
      deliverNotifications(project.id, reviewers, 'review', `需求待评审：${req.code}`, `第 ${round} 轮评审已发起`)
      return { reviewId: id, round }
    }
    case 'add_annotation': {
      const review = get("SELECT * FROM reviews WHERE requirement_id = ? AND status != '已完成' ORDER BY round DESC LIMIT 1", req.id)
      if (!review) throw Object.assign(new Error('没有进行中的评审'), { statusCode: 400 })
      const annId = uid('AN-')
      run('INSERT INTO annotations (id, review_id, section, quote, content, author_id, stale, created_at) VALUES (?,?,?,?,?,?,0,?)',
        annId, review.id, payload.section || '功能设计', payload.quote || '', payload.content, user.id, now())
      const max = get('SELECT MAX(seq) AS m FROM suggestions WHERE review_id = ?', review.id)
      const sid = uid('SG-')
      run('INSERT INTO suggestions (id, review_id, requirement_id, seq, title, detail, expected, status, annotation_ids_json, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        sid, review.id, req.id, (max?.m || 0) + 1, `${payload.section || '功能设计'}：${payload.content.slice(0, 24)}`,
        `- ${user.name}：${payload.content}`, '按意见修改并重新发布说明书', '待处理', JSON.stringify([annId]), user.id, now())
      if (review.status === '待开始') run("UPDATE reviews SET status = '进行中' WHERE id = ?", review.id)
      return { annotationId: annId, suggestionId: sid }
    }
    case 'close_suggestion': {
      requireAction(role, 'suggestion.close')
      const s = get('SELECT * FROM suggestions WHERE id = ? AND requirement_id = ?', payload.suggestionId, req.id)
      if (!s) throw Object.assign(new Error('建议不存在'), { statusCode: 404 })
      const review = get('SELECT * FROM reviews WHERE id = ?', s.review_id)
      const origin = get('SELECT * FROM specs WHERE id = ?', review.spec_id)
      const target = latestSpec(req.id)
      if (!target) throw Object.assign(new Error('没有可关联的说明书版本'), { statusCode: 400 })
      if (origin && target.version <= origin.version) throw Object.assign(new Error(`必须先生成新版本（当前最新 V${target.version}，评审版本 V${origin.version}）`), { statusCode: 400 })
      if (origin && target.markdown === origin.markdown) throw Object.assign(new Error('说明书内容没有实际变化，不能关闭建议'), { statusCode: 400 })
      run("UPDATE suggestions SET status = '已消除', resolution_version = ?, resolution_note = ?, closed_at = ? WHERE id = ?", target.version, payload.note || '', now(), s.id)
      return { version: target.version }
    }
    case 'request_change': {
      requireAction(role, 'change.create')
      const text = `${payload.reason || ''} ${payload.content || ''}`
      const flags = {
        apps: /涉及应用|应用调整/.test(text), integration: /集成点|接口/.test(text),
        acceptance: /验收口径|验收标准/.test(text), functions: /功能|页面|原型|流程/.test(text)
      }
      let grade = flags.functions ? '中等' : '一般'
      if (flags.apps || flags.integration || flags.acceptance) grade = '重大'
      const last = get('SELECT MAX(seq) AS m FROM changes WHERE requirement_id = ?', req.id)
      const id = uid('CHG-')
      const before = latestSpec(req.id)
      run(`INSERT INTO changes (id, requirement_id, seq, reason, content, grade, impact_json, handling, status, before_spec, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, req.id, (last?.m || 0) + 1, payload.reason, payload.content, grade,
        JSON.stringify({ flags, notes: Object.entries(flags).filter(([, v]) => v).map(([k]) => ({ apps: '涉及应用', integration: '集成点', acceptance: '验收口径', functions: '功能或原型' })[k]) }),
        '', grade === '重大' ? '待决定' : grade === '中等' ? '待知会' : '待应用', before?.id || '', user.id, now())
      return { changeId: id, grade }
    }
    case 'advance_status': {
      requireAction(role, 'status.advance')
      const result = transitionRequirement({
        req, to: payload.to, note: payload.note || '', effectiveAt: payload.effectiveAt, actorId: user.id
      })
      if (!result.ok) throw Object.assign(new Error(result.reason), { statusCode: 400, details: result.issues })
      return { status: result.to, milestones: result.milestones }
    }
    case 'schedule': {
      requireAction(role, 'planning.schedule')
      let it = payload.iterationId ? get('SELECT * FROM iterations WHERE id = ? AND project_id = ?', payload.iterationId, project.id) : null
      if (!it && payload.iterationName) it = get('SELECT * FROM iterations WHERE project_id = ? AND name = ?', project.id, payload.iterationName)
      if (!it) throw Object.assign(new Error('找不到迭代表'), { statusCode: 404 })
      const used = all('SELECT priority_json FROM requirements WHERE iteration_id = ? AND status NOT IN (?,?)', it.id, '已丢弃', '需求调研中')
        .reduce((s, r) => s + (parseJson(r.priority_json, {})?.estimateDays || 0), 0)
      const add = parseJson(req.priority_json, {})?.estimateDays || 0
      if (it.capacity_days > 0 && used + add > it.capacity_days) throw Object.assign(new Error('迭代容量不足'), { statusCode: 400 })
      run('UPDATE requirements SET iteration_id = ?, updated_at = ? WHERE id = ?', it.id, now(), req.id)
      return { iteration: it.name }
    }
    case 'link_related': {
      const target = get('SELECT * FROM requirements WHERE id = ? AND project_id = ?', payload.requirementId, project.id)
      if (!target) throw Object.assign(new Error('关联需求不存在'), { statusCode: 404 })
      logEvent({ projectId: project.id, requirementId: req.id, type: 'related', message: `关联需求 ${target.code || target.title}：${payload.reason || ''}`, payload: { targetId: target.id, reason: payload.reason || '' }, actorId: user.id })
      return { target: target.code || target.title }
    }
    default:
      throw Object.assign(new Error('动作不在封闭清单中'), { statusCode: 400 })
  }
}

aiRouter.get('/projects/:projectId/model', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    const row = get('SELECT value FROM settings WHERE key = ?', `model:${project.id}`)
    const cfg = parseJson(row?.value, {}) || {}
    res.json({
      baseUrl: cfg.baseUrl || '', model: cfg.model || '',
      hasKey: Boolean(cfg.apiKeyEnc), configured: Boolean(cfg.baseUrl && cfg.model && cfg.apiKeyEnc),
      keyMasked: cfg.apiKeyEnc ? '••••••••' : ''
    })
  } catch (e) { next(e) }
})

aiRouter.put('/projects/:projectId/model', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'model.manage')
    const { baseUrl, model, apiKey } = hr.body || {}
    const existing = parseJson(get('SELECT value FROM settings WHERE key = ?', `model:${project.id}`)?.value, {}) || {}
    const value = {
      baseUrl: baseUrl ?? existing.baseUrl ?? '',
      model: model ?? existing.model ?? '',
      apiKeyEnc: apiKey ? encryptSecret(apiKey) : existing.apiKeyEnc || ''
    }
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', `model:${project.id}`, JSON.stringify(value))
    recordAudit(hr, 'model.update', 'project', project.id, null, { baseUrl: value.baseUrl, model: value.model, keyChanged: Boolean(apiKey) })
    res.json({ ok: true })
  } catch (e) { next(e) }
})

aiRouter.post('/projects/:projectId/model/test', async (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    const cfg = modelConfig(project.id)
    if (!cfg) { const e = new Error('尚未配置模型网关'); e.statusCode = 400; throw e }
    const resp = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/models', { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(15000) })
    if (!resp.ok) throw new Error(`模型服务返回 ${resp.status}`)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

aiRouter.get('/projects/:projectId/llm-calls', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    const rows = all('SELECT * FROM llm_calls WHERE project_id = ? ORDER BY created_at DESC LIMIT 100', project.id)
    const total = rows.reduce((s, r) => ({ prompt: s.prompt + r.prompt_tokens, completion: s.completion + r.completion_tokens, cost: s.cost + r.cost }), { prompt: 0, completion: 0, cost: 0 })
    const budget = Number(get('SELECT value FROM settings WHERE key = ?', `budget:${project.id}`)?.value || 0)
    res.json({ calls: rows, total, budget })
  } catch (e) { next(e) }
})

aiRouter.get('/projects/:projectId/skills', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    res.json({ skills: listProjectSkills(project.id), stages: SKILL_STAGES, pack: BUILTIN_SKILL_PACK })
  } catch (e) { next(e) }
})

aiRouter.get('/projects/:projectId/skills/coverage', (hr, res, next) => {
  try {
    const { project } = projectFor(hr.user, hr.params.projectId)
    res.json(skillPackCoverage(project.id))
  } catch (e) { next(e) }
})

aiRouter.post('/projects/:projectId/skills/repair', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'skill.manage')
    const resetStages = Boolean(hr.body?.resetStages)
    const result = repairSkillPack({ projectId: project.id, resetStages })
    recordAudit(hr, 'skill.pack-repair', 'project', project.id, null, {
      pack: BUILTIN_SKILL_PACK.name, version: BUILTIN_SKILL_PACK.version,
      resetStages, changes: result.changes
    })
    logEvent({
      projectId: project.id, type: 'skill-repair',
      message: `技能包补齐：处理 ${result.changed} 项${resetStages ? '（含重置环节）' : ''}`,
      payload: { changes: result.changes, resetStages }, actorId: hr.user.id
    })
    res.json(result)
  } catch (e) { next(e) }
})

aiRouter.get('/projects/:projectId/skills/reference-candidates', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'skill.manage')
    res.json({ candidates: referenceCandidates(project.id, hr.user.id) })
  } catch (e) { next(e) }
})

aiRouter.post('/projects/:projectId/skills/import', async (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'skill.manage')
    hr.projectId = project.id
    const { archiveBase64, files, stages } = hr.body || {}
    const view = await importSkillPackage({ projectId: project.id, userId: hr.user.id, archiveBase64, files, stages })
    recordAudit(hr, 'skill.import', 'project_skill', view.id, null, {
      projectId: project.id, slug: view.slug, version: view.version, sourceType: view.sourceType, stages: view.stages
    })
    res.status(201).json(view)
  } catch (e) { next(e) }
})

aiRouter.post('/projects/:projectId/skills/reference', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'skill.manage')
    hr.projectId = project.id
    const { sourceBindingId, stages } = hr.body || {}
    const view = referenceSkill({ projectId: project.id, userId: hr.user.id, sourceBindingId, stages })
    recordAudit(hr, 'skill.reference', 'project_skill', view.id, null, {
      projectId: project.id, slug: view.slug, sourceType: view.sourceType, sourceProjectId: view.sourceProject?.id, stages: view.stages
    })
    res.status(201).json(view)
  } catch (e) { next(e) }
})

aiRouter.patch('/projects/:projectId/skills/:bindingId', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'skill.manage')
    hr.projectId = project.id
    const row = projectSkillRow(project.id, hr.params.bindingId)
    if (!row) { const e = new Error('项目技能不存在'); e.statusCode = 404; throw e }
    const before = projectSkillView(row)
    const view = updateProjectSkill({ projectId: project.id, bindingId: hr.params.bindingId, stages: hr.body?.stages, enabled: hr.body?.enabled })
    const meta = { projectId: project.id, slug: view.slug, sourceType: view.sourceType, sourceProjectId: view.sourceProject?.id }
    if (view.bindingEnabled !== before.bindingEnabled) {
      recordAudit(hr, 'skill.toggle', 'project_skill', view.id, { ...meta, enabled: before.bindingEnabled }, { ...meta, enabled: view.bindingEnabled })
    }
    if (JSON.stringify(view.stages) !== JSON.stringify(before.stages)) {
      recordAudit(hr, 'skill.config', 'project_skill', view.id, { ...meta, stages: before.stages }, { ...meta, stages: view.stages })
    }
    res.json(view)
  } catch (e) { next(e) }
})

aiRouter.delete('/projects/:projectId/skills/:bindingId', (hr, res, next) => {
  try {
    const { project, role } = projectFor(hr.user, hr.params.projectId)
    requireAction(role, 'skill.manage')
    hr.projectId = project.id
    const view = removeProjectSkill({ projectId: project.id, bindingId: hr.params.bindingId })
    recordAudit(hr, 'skill.remove', 'project_skill', view.id, {
      projectId: project.id, slug: view.slug, sourceType: view.sourceType, sourceProjectId: view.sourceProject?.id, stages: view.stages
    }, null)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

aiRouter.post('/requirements/:id/skills/:bindingId/run', async (hr, res, next) => {
  try {
    const { req, project } = requirementFor(hr.user, hr.params.id)
    const stage = conversationStage(hr.body?.stage, stageOfRequirement(req))
    const skill = executableSkill(project.id, hr.params.bindingId, stage)
    const result = await runSkillRuntime({ req, project, user: hr.user, skill, stage, triggerType: 'manual' })
    addMessage(req.id, 'assistant', result.content, result.proposal?.id || null)
    res.json({
      ...result, stage,
      skill: { id: skill.id, slug: skill.slug, name: skill.name, version: skill.version }
    })
  } catch (e) { next(e) }
})
