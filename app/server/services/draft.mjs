import { normalizeAnalysis } from './render.mjs'

function clarOf(req) {
  try { return JSON.parse(req.clarification_json || '{}') } catch { return {} }
}
function appsOf(req) {
  try { return JSON.parse(req.involved_apps_json || '[]') } catch { return [] }
}

const VERBS = /支持|能够|可以|实现|提供|管理|查询|配置|审批|通知|生成|导出|统计|录入|校验|同步|查看|提交|审核|分配|归档/

function candidateSentences(text) {
  return String(text || '')
    .split(/[。；\n]/)
    .map(s => s.replace(/^[\s\d.、)（(]+/, '').trim())
    .filter(s => s.length >= 6 && s.length <= 80)
}

export function generateAnalysisDraft(req, project) {
  const clar = clarOf(req)
  const answers = clar.answers || {}
  let source = {}
  try { source = JSON.parse(req.source_json || '{}') } catch { source = {} }
  const text = source.fullText || source.excerpt || ''
  const apps = appsOf(req)
  const scope = JSON.parse(project.system_scope_json || '{}')
  const scopeAll = [...(scope.platforms || []), ...(scope.applications || []), ...(scope.modules || [])]
  const role = answers.roles?.value || '业务用户'
  const goal = answers.goal?.value || `完成「${req.title}」并达到可验收状态`
  const scopeText = answers.scope?.value || (scope.applications || []).join('、')
  const boundary = answers.boundary?.value || '不做范围外的系统改造'
  const acceptanceText = answers.acceptance?.value || '关键流程可完整走通'

  const sentences = candidateSentences(text)
  const picked = sentences.filter(s => VERBS.test(s)).slice(0, 5)
  const fallback = [
    `${req.title}信息登记与查询`,
    `${req.title}业务处理`,
    `${req.title}结果反馈`,
    '权限与操作留痕'
  ]
  const functions = (picked.length >= 2 ? picked : fallback).map((s, i) => {
    const name = s.length > 24 ? s.slice(0, 24) : s
    return {
      id: `F-${String(i + 1).padStart(2, '0')}`,
      name: /^[\u4e00-\u9fa5A-Za-z]/.test(name) ? name : `功能 ${i + 1}`,
      description: picked.length >= 2 ? s : `${req.title}的${name}能力，需覆盖主要业务场景与异常处理。`,
      priority: i === 0 ? 'P0' : 'P1',
      acceptance: `可完成「${name}」的完整操作，异常场景有明确提示，操作结果可查询。`,
      group: '核心功能'
    }
  })

  const support = []
  if (/通知|消息|提醒/.test(text + req.title)) support.push({ id: 'S-01', name: '消息通知', description: '关键节点向相关角色发送站内信与邮件提醒' })
  if (/权限|角色|审批/.test(text + req.title + role)) support.push({ id: 'S-02', name: '权限控制', description: '按角色控制可见范围与操作权限，敏感操作留痕' })
  if (/导出|报表|统计/.test(text + req.title)) support.push({ id: 'S-03', name: '导出与统计', description: '支持按筛选条件导出结果并生成统计视图' })
  if (!support.length) support.push({ id: 'S-01', name: '操作审计', description: '记录关键操作人与时间，支持追溯' })

  const steps = [
    { no: 1, node: '提出申请', role, action: '填写并提交需求所需信息', branch: '信息不完整', result: '提示补齐', next: '提交申请' },
    { no: 2, node: '审核确认', role: '业务管理员', action: '校验信息与规则，确认是否受理', branch: '不符合规则', result: '退回并说明原因', next: '业务处理' },
    { no: 3, node: '业务处理', role: '业务管理员', action: '按规则完成处理并记录结果', branch: '处理异常', result: '进入异常清单并提醒', next: '结果反馈' },
    { no: 4, node: '结果反馈', role: '系统', action: '向发起人反馈处理结果', branch: '无', result: '—', next: '结束' }
  ]

  const points = apps.slice(0, 3).map((a, i) => ({
    id: `IP-${String(i + 1).padStart(2, '0')}`, app: a.name,
    direction: '双向', object: i === 0 ? '需求与处理结果数据' : '基础主数据',
    trigger: i === 0 ? '提交与状态变更时' : '进入页面时校验', note: '由应用提供接口，按约定字段交互'
  }))

  const analysis = normalizeAnalysis({
    description: {
      background: text ? text.slice(0, 260) : (req.title + '相关业务目前缺少统一承载，依赖人工处理。'),
      goal,
      roles: role.split(/[、,，]/).filter(Boolean),
      value: `覆盖${scopeText || '相关业务场景'}，落实「${boundary}」的边界要求。`
    },
    process: { summary: `${req.title}的主流程为：提出申请 → 审核确认 → 业务处理 → 结果反馈。`, steps },
    functions: {
      architecture: [
        { id: 'A-00', name: req.title, parent: '', description: '需求主域', priority: 'P0' },
        ...functions.map((f, i) => ({ id: `A-${String(i + 1).padStart(2, '0')}`, name: f.name, parent: '核心功能', description: f.description, priority: f.priority }))
      ],
      list: functions,
      flow: [
        { id: 'FF-01', from: '用户', action: '进入功能页面', condition: '已登录且有权限', to: '功能列表' },
        { id: 'FF-02', from: '功能列表', action: '发起处理', condition: '校验通过', to: '处理结果' },
        { id: 'FF-03', from: '处理结果', action: '查看与导出', condition: '有查看权限', to: '结束' }
      ],
      support
    },
    integration: {
      apps: apps.length ? apps : scope.applications?.slice(0, 1).map(name => ({ name, kind: 'internal' })) || [],
      points
    },
    acceptance: {
      steps: [
        `完成「${functions[0].name}」主流程，数据正确落库`,
        '异常输入有明确提示，不产生脏数据',
        '权限、通知等辅助能力按约定生效',
        `满足澄清结论中的范围与边界：${boundary}`
      ],
      overall: `${acceptanceText}；全部功能通过一致性校验，评审建议闭环后方可进入开发。`,
      metrics: [
        { name: '主流程处理时长', target: '较现状下降 30%', period: '上线后一个月' },
        { name: '操作差错率', target: '低于 1%', period: '上线后一个月' }
      ]
    },
    meta: { requiresSupport: support.length > 0, revisionNotes: [] }
  })
  if (!analysis.integration.apps.length && scopeAll[0]) {
    analysis.integration.apps.push({ name: scopeAll[0], kind: 'internal', note: '暂按主应用推断，请确认' })
  }
  return analysis
}

export function applyInstruction(analysis, instruction) {
  const a = normalizeAnalysis(analysis)
  const text = String(instruction || '').trim()
  const changes = []
  if (!text) return { analysis: a, changes }

  const addFn = text.match(/(?:新增|增加|添加)功能[「“"]?([^」”"，。]{2,24})[」”"]?/) || text.match(/(?:新增|增加|添加)[「“"]?([^」”"，。]{2,24})[」”"]?功能/)
  if (addFn) {
    const name = addFn[1]
    const id = `F-${String(a.functions.list.length + 1).padStart(2, '0')}`
    a.functions.list.push({ id, name, description: `由会话补充：${text}`, priority: 'P1', acceptance: `「${name}」可完整操作并有异常提示`, group: '核心功能' })
    a.functions.architecture.push({ id: 'A-' + id.slice(2), name, parent: '核心功能', description: text, priority: 'P1' })
    a.functions.flow.push({ id: 'FF-' + id.slice(2), from: '功能列表', action: name, condition: '权限校验通过', to: '处理结果' })
    changes.push(`新增功能「${name}」`)
    return { analysis: a, changes }
  }

  const addStep = text.match(/(?:流程|步骤)(?:新增|增加|添加)[「“"]?([^」”"，。]{2,30})[」”"]?/) || text.match(/(?:新增|增加|添加)流程(?:步骤|节点)?[「“"]?([^」”"，。]{2,30})[」”"]?/)
  if (addStep) {
    a.process.steps.push({ no: a.process.steps.length + 1, node: addStep[1], role: '业务角色', action: addStep[1], branch: '—', result: '—', next: '结束' })
    changes.push(`新增流程节点「${addStep[1]}」`)
    return { analysis: a, changes }
  }

  const addPoint = text.match(/(?:对接|集成|调用)[「“"]?([^」”"，。]{2,24})[」”"]?/)
  if (addPoint) {
    const appName = addPoint[1]
    if (!a.integration.apps.some(x => x.name === appName)) a.integration.apps.push({ name: appName, kind: 'internal', note: '由会话补充' })
    a.integration.points.push({ id: `IP-${String(a.integration.points.length + 1).padStart(2, '0')}`, app: appName, direction: '双向', object: '业务数据', trigger: '用户操作时', note: text })
    changes.push(`新增集成点「${appName}」`)
    return { analysis: a, changes }
  }

  if (/验收/.test(text)) {
    const value = text.replace(/^.*?验收(口径|标准)?[：:是为]?/, '').trim() || text
    a.acceptance.steps.push(value)
    if (/整体|全部|最终/.test(text)) a.acceptance.overall = value
    changes.push('补充验收标准')
    return { analysis: a, changes }
  }

  const goalMatch = text.match(/(?:目标|价值)(?:改为|调整为|是|为)[：:]?(.+)/)
  if (goalMatch) { a.description.goal = goalMatch[1].trim(); changes.push('更新目标'); return { analysis: a, changes } }

  if (/辅助支撑|权限|通知|日志/.test(text)) {
    const name = text.slice(0, 20)
    a.functions.support.push({ id: `S-${String(a.functions.support.length + 1).padStart(2, '0')}`, name, description: text })
    changes.push('补充辅助支撑功能')
    return { analysis: a, changes }
  }

  const target = text.match(/功能[「“"]?([^」”"，。]{2,24})[」”"]?/)
  if (target) {
    const fn = a.functions.list.find(f => f.name === target[1] || f.name.includes(target[1]))
    if (fn) {
      fn.description = `${fn.description || ''}${fn.description ? '；' : ''}${text}`
      changes.push(`更新功能「${fn.name}」说明`)
      return { analysis: a, changes }
    }
  }

  a.meta.revisionNotes = [...(a.meta.revisionNotes || []), { instruction: text, at: new Date().toISOString() }]
  a.description.value = `${a.description.value || ''}${a.description.value ? '；' : ''}${text}`
  changes.push('补充需求说明')
  return { analysis: a, changes }
}
