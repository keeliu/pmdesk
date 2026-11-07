import { parseJson } from '../db.mjs'

export const PRIORITY_MODEL = 'priority-100-v1'

export const LEVEL_LABEL = { P0: 'P0-极高', P1: 'P1-高', P2: 'P2-中', P3: 'P3-低' }

export const DIMENSIONS = [
  {
    key: 'closure', label: '流程闭环必要性', weight: 30,
    options: [
      { value: 'block', score: 30, label: '缺失则流程无法闭环' },
      { value: 'workaround', score: 15, label: '需人工绕行' },
      { value: 'enhance', score: 0, label: '增强项' }
    ]
  },
  {
    key: 'breadth', label: '影响广度', weight: 20,
    options: [
      { value: 'all', score: 20, label: '全部单位/全部用户' },
      { value: 'multi', score: 14, label: '多单位/多角色' },
      { value: 'unit', score: 8, label: '单单位' },
      { value: 'role', score: 3, label: '单岗位' }
    ]
  },
  {
    key: 'level', label: '提出人级别/岗位', weight: 15,
    options: [
      { value: 'high', score: 15, label: '高层/关键岗位' },
      { value: 'middle', score: 10, label: '中层/业务负责人' },
      { value: 'basic', score: 5, label: '基层' },
      { value: 'external', score: 3, label: '外部提出方' }
    ]
  },
  {
    key: 'business', label: '业务增量', weight: 15,
    options: [
      { value: 'high', score: 15, label: '直接收入、合规或风险控制' },
      { value: 'mid', score: 10, label: '明显提升' },
      { value: 'low', score: 5, label: '一般' }
    ]
  },
  {
    key: 'efficiency', label: '效率提升', weight: 10,
    options: [
      { value: 'high', score: 10, label: '显著' },
      { value: 'mid', score: 5, label: '一般' },
      { value: 'none', score: 0, label: '不可量化' }
    ]
  },
  {
    key: 'cost', label: '成本降低', weight: 10,
    options: [
      { value: 'high', score: 10, label: '显著' },
      { value: 'mid', score: 5, label: '一般' },
      { value: 'none', score: 0, label: '不可量化' }
    ]
  },
  {
    key: 'roi', label: '投入产出比', weight: 0,
    options: [
      { value: 'good', score: 10, label: '高产出低投入' },
      { value: 'flat', score: 0, label: '持平' },
      { value: 'bad', score: -10, label: '低产出高投入' }
    ]
  }
]

const DIM = Object.fromEntries(DIMENSIONS.map(d => [d.key, d]))
const optionOf = (key, value) => DIM[key]?.options.find(o => o.value === value) || DIM[key]?.options[DIM[key].options.length - 1]

export function levelOfText(text = '') {
  if (/高层|领导|总经理|董事长|总裁|负责人|主管|总监/.test(text)) return 'high'
  if (/中层|经理|业务负责人|科长|主任/.test(text)) return 'middle'
  if (/外部|客户|供应商|第三方/.test(text)) return 'external'
  return 'basic'
}

export function extractSignals({ req = {}, project = {}, text = '', estimateDays = 5 } = {}) {
  const hay = String(text || '')
  const clar = parseJson(req.clarification_json, {}) || {}
  const rolesText = clar.answers?.roles?.value || ''
  const requester = parseJson(req.requester_json, {}) || {}
  const apps = parseJson(req.involved_apps_json, [])
  const roleCount = String(rolesText).split(/[、,，/]/).filter(Boolean).length

  let closure = 'enhance'
  let closureEvidence = '未识别到流程阻断信号'
  if (/无法闭环|不能完成|阻断|流程走不通|缺失.*(环节|节点)/.test(hay)) {
    closure = 'block'; closureEvidence = '材料提到缺失该能力会阻断流程闭环'
  } else if (/绕过|手工|线下|人工核对|临时方案/.test(hay)) {
    closure = 'workaround'; closureEvidence = '材料提到当前依赖人工绕行'
  } else if (/必须|审批|校验|闭环/.test(hay)) {
    closure = 'workaround'; closureEvidence = '材料提到必须经过该环节'
  }

  let breadth = 'role'
  let breadthEvidence = `识别到 ${roleCount || 1} 个角色`
  if (/全部单位|所有单位|全公司|全部用户|所有用户|各单位/.test(hay)) {
    breadth = 'all'; breadthEvidence = '材料提到全部单位或全部用户'
  } else if (roleCount >= 2 || apps.length >= 2 || /多单位|多部门|跨部门|多角色/.test(hay)) {
    breadth = 'multi'; breadthEvidence = `涉及 ${apps.length} 个应用、${roleCount || 1} 个角色`
  } else if (/单单位|某个分公司|本部门/.test(hay)) {
    breadth = 'unit'; breadthEvidence = '材料限定在单一单位'
  }

  const level = ['high', 'middle', 'basic', 'external'].includes(requester.level)
    ? requester.level
    : levelOfText(`${requester.position || ''} ${rolesText}`)

  let business = 'low'
  let businessEvidence = '未识别到直接业务增量'
  if (/收入|结算|合规|风险|审计|资金|监管/.test(hay)) {
    business = 'high'; businessEvidence = '材料涉及收入、资金、合规或风险控制'
  } else if (/提升|增长|转化|拓展|增量/.test(hay)) {
    business = 'mid'; businessEvidence = '材料提到业务提升'
  }

  let efficiency = 'none'
  let efficiencyEvidence = '效率收益不可量化'
  if (/缩短|减少.*时间|自动化|一键|批量|秒级/.test(hay)) {
    efficiency = 'high'; efficiencyEvidence = '材料给出了可量化的效率收益'
  } else if (/效率|简化|优化/.test(hay)) {
    efficiency = 'mid'; efficiencyEvidence = '材料提到效率优化'
  }

  let cost = 'none'
  let costEvidence = '未识别到成本降低'
  if (/降低.*成本|节省|降本|减少.*人力/.test(hay)) {
    cost = 'high'; costEvidence = '材料提到显著降低成本'
  } else if (/成本|费用/.test(hay)) {
    cost = 'mid'; costEvidence = '材料提到成本优化'
  }

  const benefitPoints = (business === 'high' ? 2 : business === 'mid' ? 1 : 0) + (efficiency === 'high' ? 1 : 0) + (cost === 'high' ? 1 : 0)
  let roi = 'flat'
  let roiEvidence = '投入产出比持平'
  if (benefitPoints >= 3 && estimateDays <= 8) {
    roi = 'good'; roiEvidence = `收益信号 ${benefitPoints} 项且预计投入 ${estimateDays} 人日`
  } else if (benefitPoints <= 1 && estimateDays >= 12) {
    roi = 'bad'; roiEvidence = `收益信号较弱且预计投入 ${estimateDays} 人日`
  }

  const floor = closure === 'block' && /合规|资金|安全|无替代|监管/.test(hay)
  return {
    values: { closure, breadth, level, business, efficiency, cost, roi },
    evidence: { closure: closureEvidence, breadth: breadthEvidence, level: requester.level ? `提出方级别为${optionOf('level', requester.level).label}` : '提出方级别未填写，按最低取值', business: businessEvidence, efficiency: efficiencyEvidence, cost: costEvidence, roi: roiEvidence },
    floor,
    floorReason: floor ? '命中合规、资金、安全或无替代路径的流程阻断，等级不低于 P0' : ''
  }
}

function gradeFromScore(score) {
  if (score >= 75) return 'P0'
  if (score >= 55) return 'P1'
  if (score >= 35) return 'P2'
  return 'P3'
}

export function computePriority({ values = {}, evidence = {}, floor = false, floorReason = '', manualGrade, reason, estimateDays = 5, aiCandidate = null, actor = '' }) {
  const dimensions = DIMENSIONS.map(d => {
    const value = values[d.key] ?? d.options[d.options.length - 1].value
    const opt = optionOf(d.key, value)
    return {
      key: d.key, label: d.label, weight: d.weight, value: opt.value, valueLabel: opt.label,
      score: opt.score, evidence: evidence[d.key] || '', source: values[d.key] ? 'user' : 'rules'
    }
  })
  const score = dimensions.reduce((s, d) => s + d.score, 0)
  let suggestedGrade = gradeFromScore(score)
  const explanations = []
  if (floor) {
    suggestedGrade = 'P0'
    explanations.push(floorReason || '命中 P0 底线规则')
  }
  const closureScore = dimensions.find(d => d.key === 'closure').score
  const breadthScore = dimensions.find(d => d.key === 'breadth').score
  const businessScore = dimensions.find(d => d.key === 'business').score
  const effScore = dimensions.find(d => d.key === 'efficiency').score
  const costScore = dimensions.find(d => d.key === 'cost').score
  const levelScore = dimensions.find(d => d.key === 'level').score
  if (!floor && levelScore >= 10 && closureScore <= 15 && breadthScore <= 8 && businessScore <= 5 && effScore <= 0 && costScore <= 0) {
    if (suggestedGrade === 'P0' || suggestedGrade === 'P1') suggestedGrade = 'P2'
    explanations.push('提出人级别只贡献有限分值，不能单独把需求抬到 P0 或 P1')
  }
  if (floor) explanations.push('P0 底线依据：' + (floorReason || '流程阻断'))
  const grade = ['P0', 'P1', 'P2', 'P3'].includes(manualGrade) ? manualGrade : suggestedGrade
  return {
    model: PRIORITY_MODEL,
    score,
    grade,
    gradeLabel: LEVEL_LABEL[grade],
    suggestedGrade,
    suggestedLabel: LEVEL_LABEL[suggestedGrade],
    manual: Boolean(manualGrade && manualGrade !== suggestedGrade),
    reason: manualGrade && manualGrade !== suggestedGrade ? (reason || '') : '',
    floor: Boolean(floor),
    floorReason: floor ? (floorReason || '命中 P0 底线规则') : '',
    dimensions,
    explanations,
    aiCandidate,
    estimateDays: Number(estimateDays) || 0,
    updatedAt: new Date().toISOString(),
    updatedBy: actor
  }
}

export function buildPriority({ req = {}, project = {}, text = '', input = {}, actor = '' }) {
  const estimateDays = Number(input.estimateDays ?? parseJson(req.priority_json, {})?.estimateDays ?? 5)
  const extracted = extractSignals({ req, project, text, estimateDays })
  const aiCandidate = { values: extracted.values, evidence: extracted.evidence, floor: extracted.floor, floorReason: extracted.floorReason }
  const values = { ...extracted.values, ...(input.values || {}) }
  const evidence = { ...extracted.evidence, ...(input.evidence || {}) }
  const merged = computePriority({
    values, evidence, floor: input.floor ?? extracted.floor, floorReason: input.floorReason || extracted.floorReason,
    manualGrade: input.grade, reason: input.reason, estimateDays, aiCandidate, actor
  })
  const diff = Object.fromEntries(Object.keys(aiCandidate.values).map(k => ({
    key: k, ai: aiCandidate.values[k], rule: values[k],
    changed: aiCandidate.values[k] !== values[k]
  })).map(x => [x.key, x]))
  merged.ruleValues = values
  merged.aiDiff = diff
  return merged
}

export function comparePriority(a, b) {
  const pa = parseJson(a.priority_json, {}) || {}
  const pb = parseJson(b.priority_json, {}) || {}
  const scoreDiff = (pb.score || 0) - (pa.score || 0)
  if (scoreDiff) return scoreDiff
  const dims = ['closure', 'breadth', 'business']
  for (const key of dims) {
    const va = pa.dimensions?.find(d => d.key === key)?.score || 0
    const vb = pb.dimensions?.find(d => d.key === key)?.score || 0
    if (vb !== va) return vb - va
  }
  return String(a.code || a.title).localeCompare(String(b.code || b.title), 'zh-CN')
}

export function priorityIssues(priority) {
  if (!priority || priority.model !== PRIORITY_MODEL) return ['优先级尚未按新模型生成']
  const issues = []
  if (!priority.dimensions?.length) issues.push('缺少逐项评分依据')
  if (priority.manual && !priority.reason) issues.push('人工调整优先级必须填写理由')
  return issues
}
