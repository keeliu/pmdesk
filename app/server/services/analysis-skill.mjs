import { parseJson } from '../db.mjs'
import { normalizeAnalysis, checkAnalysis } from './render.mjs'
import { requesterIssues, normalizeRequester } from './requester.mjs'

export const ANALYSIS_SKILL = { slug: 'prd-analysis', version: '2.1.0', contract: 'analysis-4-section@1' }

const CAPABILITIES = [
  { key: 'config', re: /配置|规则|参数|策略|设置/, group: '业务办理', name: o => `配置${o}`, trigger: o => `业务人员维护${o}时`, rules: o => `按澄清结论校验${o}的取值与生效范围`, result: o => `保存${o}并生成变更记录` },
  { key: 'calculate', re: /累积|计算|核算|统计|汇总|计分/, group: '数据处理', name: o => `计算${stripRule(o)}累积`, trigger: o => `${stripRule(o)}业务数据发生变化时`, rules: o => `按等级、规则与生效时间计算${stripRule(o)}累积值`, result: o => `生成${stripRule(o)}计算结果并记入明细` },
  { key: 'redeem', re: /兑换|结算|核销|抵扣|支付/, group: '业务办理', name: o => `处理${stripRule(o)}兑换`, trigger: o => `用户发起${stripRule(o)}兑换时`, rules: () => '校验可用额度、兑换规则与库存', result: () => '完成兑换并返回结果凭证' },
  { key: 'merge', re: /合并/, group: '业务办理', name: o => `合并${o}`, trigger: o => `业务人员发现重复${o}记录时`, rules: o => `指定主记录，校验${o}冲突字段并迁移关联业务数据`, result: o => `生成${o}合并记录，保留来源与前后值` },
  { key: 'dedupe', re: /查重|去重|重复/, group: '数据处理', name: o => `查重${o}`, trigger: o => `新建或导入${o}时`, rules: o => `按名称、证照与联系方式匹配${o}重复项`, result: o => `标记疑似重复的${o}并提示合并或忽略` },
  { key: 'transfer', re: /调拨|移库|调仓/, group: '业务办理', name: o => `发起${o}调拨`, trigger: o => `业务人员发起${o}调拨申请时`, rules: () => '校验收发仓库、可用库存与审批额度', result: () => '生成调拨单并进入审批流程' },
  { key: 'update', re: /修改|变更|更新|维护/, group: '业务办理', name: o => `修改${o}信息`, trigger: o => `业务人员或客户需要更新${o}信息时`, rules: o => `校验身份、${o}字段规则与可变更范围`, result: o => `更新${o}信息并记录变更前后值` },
  { key: 'filter', re: /筛选|标签|排序/, group: '业务办理', name: o => `筛选${o}`, trigger: o => `用户在${o}列表中按条件筛选时`, rules: () => '支持多条件组合并记住上次筛选条件', result: o => `返回符合条件的${o}列表` },
  { key: 'register', re: /登记|录入|建档|申请|提交|采集/, group: '业务办理', name: o => `登记${o}`, trigger: o => `业务人员受理${o}业务时`, rules: o => `校验必填项与${o}业务规则`, result: o => `生成${o}记录并进入后续流程` },
  { key: 'query', re: /查询|检索|查看|列表|追踪|台账/, group: '业务办理', name: o => `查询${o}`, trigger: o => `业务人员或管理者查看${o}时`, rules: () => '按角色与筛选条件限定可见范围', result: o => `返回${o}列表与明细` },
  { key: 'approve', re: /审批|审核|复核|会签/, group: '流程处理', name: o => `审批${o}`, trigger: o => `${o}提交后进入审批环节`, rules: () => '按审批链与条件路由审批人', result: () => '记录审批意见并推进流程' },
  { key: 'assign', re: /分配|指派|派发|认领/, group: '流程处理', name: o => `分配${o}`, trigger: o => `产生新的${o}待办时`, rules: () => '按规则匹配责任人并控制并发认领', result: o => `生成${o}待办并通知责任人` },
  { key: 'sync', re: /同步|对接|集成|推送|拉取/, group: '数据处理', name: o => `同步${o}数据`, trigger: o => `${o}数据变更或定时任务触发时`, rules: () => '按接口字段映射与幂等规则处理', result: o => `更新${o}数据并记录同步结果` },
  { key: 'export', re: /导出|报表|下载|看板/, group: '数据处理', name: o => `导出${o}报表`, trigger: o => `管理人员需要汇总${o}数据时`, rules: () => '按筛选范围与权限生成报表', result: o => `下载${o}报表并登记导出记录` },
  { key: 'notify', re: /通知|提醒|消息|预警/, group: '辅助支撑', name: o => `发送${o}通知`, trigger: o => `${o}状态变化或到达提醒节点时`, rules: () => '按通知模板与接收人规则发送', result: () => '站内信与邮件送达并记录发送状态' }
]

const SUPPORT_RULES = [
  { re: /通知|消息|提醒|预警/, name: '消息通知', description: '关键节点向相关角色发送站内信与邮件，失败可重试' },
  { re: /权限|角色|审批/, name: '权限控制', description: '按角色与数据范围控制可见与操作权限，敏感操作留痕' },
  { re: /配置|参数|规则/, name: '规则配置管理', description: '集中维护业务规则与参数，变更需记录生效范围与操作人' },
  { re: /日志|审计|追溯/, name: '操作留痕', description: '记录关键操作人、时间与前后值，支持按对象追溯' },
  { re: /导出|报表|统计/, name: '导出与统计', description: '按筛选条件导出结果并生成统计视图' }
]

function stripRule(object) {
  return String(object || '').replace(/规则$/, '').replace(/管理$/, '') || object
}

const TITLE_ACTION = /(?:批量|自动|统一|自助|手动|一键)?(?:合并|查重|配置|生效|导入|校验|生成|调拨|申请|审批|审核|复核|会签|登记|录入|建档|提交|采集|查询|检索|查看|追踪|分配|指派|派发|认领|同步|对接|集成|推送|拉取|导出|下载|通知|提醒|预警|修改|更新|启用|停用|解除|绑定|关联|调整|撤销|回滚|发布|管理|编辑|创建|关闭|统计|计算|核算|汇总|结算|核销|支付|处理|发送|维护|办理|归档|接收|上传|打印|复制|切换|筛选|排序|分页|展示|带出|匹配|核对)/

export function extractObject(title = '') {
  let text = String(title)
    .replace(/[，。；、].*$/, '')
    .replace(/^(支持|实现|新增|优化|建设|完成|提供|需要|希望|拟|按|根据|基于|针对|面向)/, '')
    .replace(/(需要|应当|应该|希望).*$/, '')
    .replace(/(功能|需求|能力|模块|系统|平台)$/, '')
    .trim()
  const cut = text.search(TITLE_ACTION)
  if (cut > 1) {
    text = text.slice(0, cut)
      .replace(/(的|自动|自助|手动|批量|统一|一键|快速|在线)+$/, '')
      .trim()
  }
  if (text.length < 2) text = String(title).slice(0, 12)
  return text.slice(0, 18)
}

function clarValue(clar, key, fallback = '') {
  const raw = clar?.[key]
  const value = raw && typeof raw === 'object' ? raw.value : raw
  const text = String(value ?? '').trim()
  return text || fallback
}

export function assembleSkillInput({ req, project, related = [], priorAnalyses = [] }) {
  const clar = parseJson(req.clarification_json, {}) || {}
  const source = parseJson(req.source_json, {}) || {}
  const requester = normalizeRequester(parseJson(req.requester_json, {}) || {}, project, {})
  const scope = parseJson(project?.system_scope_json, {}) || {}
  const snapshot = parseJson(req.snapshot_json, null)
  return {
    skill: ANALYSIS_SKILL,
    requirement: {
      id: req.id, code: req.code, title: req.title,
      clarification: clar.answers || {}, involvedApps: parseJson(req.involved_apps_json, []),
      snapshotAt: snapshot?.confirmedAt || req.confirmed_at || '', priority: parseJson(req.priority_json, null)
    },
    requester,
    project: { id: project?.id, code: project?.code, name: project?.name, scope, enterpriseScope: parseJson(project?.enterprise_scope_json, {}) },
    source: { text: source.fullText || source.excerpt || '', type: source.type || '', fileName: source.fileName || '' },
    related: related.map(r => ({ id: r.id, code: r.code, title: r.title, status: r.status })),
    priorAnalyses: priorAnalyses.map(v => ({ version: v.version, at: v.created_at })),
    template: { sections: ['业务流程说明', '功能设计', '集成说明', '验收口径'] }
  }
}

export function missingInputs({ req, project }) {
  const input = assembleSkillInput({ req, project })
  const missing = []
  if (!clarValue(input.requirement.clarification, 'goal')) missing.push({ field: 'goal', label: '目标与价值' })
  if (!clarValue(input.requirement.clarification, 'scope')) missing.push({ field: 'scope', label: '范围' })
  if (!clarValue(input.requirement.clarification, 'acceptance')) missing.push({ field: 'acceptance', label: '验收口径' })
  if (!input.requirement.involvedApps.length) missing.push({ field: 'involvedApps', label: '涉及应用' })
  const rIssues = requesterIssues(input.requester, project)
  if (rIssues.length) missing.push({ field: 'requester', label: '提出方信息', detail: rIssues.map(i => i.message).join('；') })
  if (!input.source.text && !clarValue(input.requirement.clarification, 'goal')) missing.push({ field: 'source', label: '原始材料' })
  return missing
}

function detectCapabilities(text, object) {
  const hits = CAPABILITIES.filter(c => c.re.test(text))
  if (hits.length < 2) {
    for (const key of ['register', 'query', 'approve']) {
      const cap = CAPABILITIES.find(c => c.key === key)
      if (!hits.some(h => h.key === key)) hits.push(cap)
      if (hits.length >= 3) break
    }
  }
  const seen = new Set()
  return hits.filter(c => (seen.has(c.key) ? false : (seen.add(c.key), true))).slice(0, 5)
    .map(c => ({
      ...c, displayName: c.name(object),
      trigger: c.trigger(object), rules: c.rules(object), result: c.result(object)
    }))
}

function buildFunctions(text, object, roles) {
  const caps = detectCapabilities(text, object)
  return caps.map((c, i) => ({
    id: `F-${String(i + 1).padStart(2, '0')}`,
    name: c.displayName,
    description: `${c.trigger}，${c.rules}，${c.result}。`,
    group: c.group,
    priority: i === 0 ? 'P0' : (c.group === '辅助支撑' ? 'P2' : 'P1'),
    trigger: c.trigger,
    rules: c.rules,
    result: c.result,
    acceptance: `${c.trigger}可完成「${c.displayName}」，${c.result}，页面可查询到对应记录；规则不满足时给出明确提示且不产生脏数据。`
  }))
}

function buildProcess(object, roles, text) {
  const primary = roles[0] || '业务经办人'
  const manager = roles.find(r => /管理|审批|负责/.test(r)) || '业务管理员'
  const steps = [
    { no: 1, node: `发起${object}业务`, role: primary, action: `填写并提交${object}相关信息`, branch: '信息不完整', result: '提示补齐并保留草稿', next: '规则校验' },
    { no: 2, node: '规则校验', role: '系统', action: `校验${object}业务规则、数据范围与操作权限`, branch: '校验不通过', result: '返回失败原因，不写入业务数据', next: '业务处理' },
    { no: 3, node: '业务处理', role: manager, action: `按${object}规则完成业务处理`, branch: '处理异常', result: '进入异常清单并通知责任人', next: '结果确认' },
    { no: 4, node: '结果确认', role: primary, action: `查看并确认${object}处理结果`, branch: '结果有异议', result: '退回业务处理重新核算', next: '归档' },
    { no: 5, node: '归档与通知', role: '系统', action: '归档业务记录并发送结果通知', branch: '通知失败', result: '进入重试队列', next: '结束' }
  ]
  return {
    summary: `${object}主流程：发起 → 规则校验 → 业务处理 → 结果确认 → 归档通知。`,
    exceptionNote: /异常|失败|退回|驳回/.test(text) ? '' : '异常分支覆盖信息不完整、规则校验不通过、处理异常与结果异议四种情况。',
    steps
  }
}

function buildIntegration(apps, object) {
  const list = apps.length ? apps : []
  const points = list.map((a, i) => ({
    id: `IP-${String(i + 1).padStart(2, '0')}`,
    app: a.name,
    direction: i === 0 ? '双向' : '读取',
    object: /消息/.test(a.name) ? '通知消息与送达状态'
      : /权限/.test(a.name) ? '角色、数据范围与操作权限'
        : /数据|中台/.test(a.name) ? '主数据与指标口径'
          : i === 0 ? `${object}业务数据与处理结果` : `${object}基础数据`,
    trigger: i === 0 ? '提交、状态变更与查询时' : '进入页面校验与定时同步时',
    note: i === 0 ? '主应用承载业务流程与数据落库' : '按接口约定读取或回写，失败进入重试队列'
  }))
  return { apps: list, points }
}

function buildSupport(text) {
  const support = SUPPORT_RULES.filter(r => r.re.test(text)).map((r, i) => ({
    id: `S-${String(i + 1).padStart(2, '0')}`, name: r.name, description: r.description
  }))
  return support.slice(0, 4)
}

export function generateSkillDraft({ req, project, related = [], priorAnalyses = [], missing = [] }) {
  const input = assembleSkillInput({ req, project, related, priorAnalyses })
  const clar = input.requirement.clarification
  const goal = clarValue(clar, 'goal')
  const scope = clarValue(clar, 'scope')
  const boundary = clarValue(clar, 'boundary', '不做范围外的系统改造')
  const acceptanceText = clarValue(clar, 'acceptance')
  const rolesText = clarValue(clar, 'roles')
  const text = [req.title, input.source.text, goal, scope, boundary, acceptanceText, rolesText].join('\n')
  const object = extractObject(req.title)
  const roles = rolesText
    .split(/[、,，/]/).map(s => s.trim()).filter(Boolean)
    .filter(s => !/提出/.test(s))
  const functions = buildFunctions(text, object, roles)
  const process = buildProcess(object, roles, text)
  const integration = buildIntegration(input.requirement.involvedApps, object)
  const support = buildSupport(text)

  const analysis = normalizeAnalysis({
    description: {
      background: goal ? `${req.title}：${goal}。当前流程依赖${/人工|线下/.test(text) ? '人工处理与线下沟通' : '分散的系统操作'}，缺少统一承载。` : input.source.text.slice(0, 260),
      goal,
      roles,
      value: `覆盖${scope || '本期约定范围'}，落实「${boundary}」的边界要求，形成可查询、可追溯的${object}业务记录。`
    },
    process,
    functions: {
      architecture: [
        ...['业务办理', '数据处理', '辅助支撑'].filter(g => functions.some(f => f.group === g) || g === '业务办理')
          .map((g, i) => ({ id: `A-${String(i + 1).padStart(2, '0')}`, name: g, parent: '', description: `${g}相关能力`, priority: i === 0 ? 'P0' : 'P1' })),
        ...functions.map((f, i) => ({ id: `A-1${i + 1}`, name: f.name, parent: f.group, description: f.description, priority: f.priority }))
      ],
      list: functions,
      flow: [
        { id: 'FF-01', from: '用户', action: `进入${object}页面`, condition: '已登录且具备查看权限', to: '业务列表' },
        { id: 'FF-02', from: '业务列表', action: functions[0]?.name || `处理${object}`, condition: '必填项与规则校验通过', to: '处理结果' },
        { id: 'FF-03', from: '处理结果', action: '查看、导出与归档', condition: '具备查看或导出权限', to: '结束' }
      ],
      support: support.length ? support : [{ id: 'S-01', name: '操作留痕', description: '记录关键操作人、时间与变更内容，支持按对象追溯' }]
    },
    integration,
    acceptance: {
      steps: [
        `可完成「${functions[0]?.name || object}」主流程，${object}数据正确落库并可按条件查询`,
        '规则不满足、权限不足或信息缺失时给出明确提示，不产生脏数据',
        '关键节点记录操作人、时间与前后值，可按需求编号追溯',
        `满足澄清结论中的范围与边界：${boundary}`
      ],
      overall: `${acceptanceText || '关键流程可完整走通'}；全部功能通过一致性校验，评审建议闭环后方可进入开发。`,
      metrics: [
        { name: `${object}主流程处理时长`, target: '较现状下降 30%', period: '上线后一个月' },
        { name: `${object}操作差错率`, target: '低于 1%', period: '上线后一个月' }
      ]
    },
    meta: {
      requiresSupport: (support || []).length > 0,
      revisionNotes: [],
      skill: ANALYSIS_SKILL,
      evidence: {
        description: [`澄清回答：${clarValue(clar, 'goal') ? '目标与价值' : '原始材料'}`, `提出方：${input.requester.enterprise || '—'} / ${input.requester.department || '—'}`],
        process: [`角色来源：澄清回答「角色与岗位」`, `异常分支来源：${/异常|失败|退回|驳回/.test(text) ? '原始材料' : '按业务流程规则约定'}`],
        functions: functions.map(f => `${f.name}：${f.trigger}`),
        integration: integration.points.map(p => `${p.app}：${p.object}`),
        acceptance: ['逐步完成标准来自澄清验收口径与功能验收要点']
      },
      missing: missing.map(m => m.label)
    }
  })
  const quality = checkAnalysis(analysis, req, project)
  return { ok: quality.ok, analysis, quality, input }
}

export function buildSkeleton(input, missing, reason) {
  const labels = missing.map(m => m.label).join('、') || '关键输入'
  const base = normalizeAnalysis({
    description: {
      background: `待补充：${labels}。`,
      goal: clarValue(input.requirement.clarification, 'goal'),
      roles: [],
      value: ''
    },
    process: { summary: '待补充：业务流程', steps: [] },
    functions: { architecture: [], list: [], flow: [], support: [] },
    integration: { apps: input.requirement.involvedApps, points: [] },
    acceptance: { steps: [], overall: '', metrics: [] },
    meta: {
      skeleton: true, degradation: reason || 'missing-input',
      pendingSections: ['业务流程说明', '功能设计', '集成说明', '验收口径'],
      missing: missing.map(m => m.label)
    }
  })
  return base
}
