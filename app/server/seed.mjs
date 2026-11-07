import { db, get, all, run, now, uid, nextCounter, parseJson } from './db.mjs'
import { generateSkillDraft } from './services/analysis-skill.mjs'
import { buildPrototypePages, specMarkdown, specHtml, normalizeAnalysis } from './services/render.mjs'
import { buildPriority } from './services/priority.mjs'
import { normalizeMilestones } from './services/milestones.mjs'
import { normalizeRequester } from './services/requester.mjs'
import {
  collectIterationSources, buildIterationSpec, newIterationSpecId, nextIterationSpecVersion
} from './services/iteration-spec.mjs'
import { ensureBuiltinSkills } from './services/skills.mjs'

const force = process.env.FORCE === '1' || process.argv.includes('--force')
if (get('SELECT id FROM users LIMIT 1') && !force) {
  console.log('已有数据，跳过初始化。需要重建请执行：npm run seed -- --force')
  process.exit(0)
}

db.exec('BEGIN IMMEDIATE')
try {
  for (const t of ['users', 'projects', 'project_members', 'iterations', 'requirements', 'requirement_versions',
    'prototypes', 'specs', 'reviews', 'annotations', 'suggestions', 'changes', 'events', 'notifications',
    'chat_messages', 'proposals', 'skills', 'llm_calls', 'audits', 'share_links', 'exports', 'settings', 'counters',
    'dependencies', 'similarity_ignores', 'iteration_specs', 'batch_operations', 'project_messages', 'project_proposals']) {
    run(`DELETE FROM ${t}`)
  }

  const ts = now()
  const users = [
    ['U-pm', '林知远', '产品经理', 'pm'],
    ['U-pm2', '周维', '产品经理', 'pm'],
    ['U-r1', '陈立', '业务评审人', 'reviewer'],
    ['U-r2', '许安', '技术评审人', 'reviewer'],
    ['U-dev', '王珂', '研发负责人', 'developer'],
    ['U-guest', '外部业务方', '业务提交人', 'guest'],
    ['U-admin', '系统管理员', '平台管理员', 'admin']
  ]
  for (const [id, name, title, role] of users) {
    run('INSERT INTO users (id, name, title, role, avatar) VALUES (?,?,?,?,?)', id, name, title, role, '')
  }

  const projectId = 'PRJ-CRM'
  run(`INSERT INTO projects (id, code, name, description, background, goals_json, owner_org, owner_id,
       system_scope_json, enterprise_scope_json, conventions_json, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    projectId, 'CRM', '客户经营与销售协同平台', '面向集团及下属单位的客户、销售与采购协同需求池。',
    '客户数据分散在多个系统，销售与采购流程依赖线下表格，需求变更缺少统一留痕。',
    JSON.stringify(['统一客户与订单主数据', '缩短需求从提出到上线的周期', '让评审与变更全程可追溯']),
    '集团数字化中心', 'U-pm',
    JSON.stringify({
      platforms: ['Web 端', '移动端'],
      applications: ['销售管理平台', '采购协同系统', '客户服务平台', '数据中台'],
      modules: ['订单中心', '库存管理', '消息中心', '权限中心'],
      excluded: ['财务核算系统', '人力系统'],
      notes: '财务与人力系统由集团统一建设，本项目只做集成对接。'
    }),
    JSON.stringify({
      mode: 'hybrid', total: 12,
      specialCompanies: ['集团总部', '华东子公司', '华南子公司'],
      provinceCompanies: ['华北分公司', '西南分公司'],
      personalized: [{ unit: '华东子公司', differences: '需要保留本地化审批层级' }],
      notes: '统建为主，华东子公司有个性化审批要求。'
    }),
    JSON.stringify({ style: 'neutral', tokenSource: 'Q-001 中性基线', density: 'comfortable' }),
    'active', ts, ts)

  const memberRoles = [['U-pm', 'pm'], ['U-pm2', 'pm'], ['U-r1', 'reviewer'], ['U-r2', 'reviewer'], ['U-dev', 'developer'], ['U-guest', 'guest'], ['U-admin', 'admin']]
  for (const [userId, role] of memberRoles) {
    run('INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?,?,?,?)', projectId, userId, role, ts)
  }

  const it1 = 'IT-2026Q4-1', it2 = 'IT-2026Q4-2', it0 = 'IT-2026-10'
  run('INSERT INTO iterations (id, project_id, name, goal, start_date, end_date, capacity_days, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    it1, projectId, '2026 Q4 迭代一', '完成客户与订单主线能力', '2026-10-20', '2026-11-14', 24, 'active', ts)
  run('INSERT INTO iterations (id, project_id, name, goal, start_date, end_date, capacity_days, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    it2, projectId, '2026 Q4 迭代二', '采购协同与库存联动', '2026-11-17', '2026-12-12', 20, 'planning', ts)
  run('INSERT INTO iterations (id, project_id, name, goal, start_date, end_date, capacity_days, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    it0, projectId, '2026-10 已发布迭代', '客户档案基础能力', '2026-09-22', '2026-10-17', 20, 'released', ts)

  const projectRow = get('SELECT * FROM projects WHERE id = ?', projectId)

  const CLAR = (roles, goal, scope, boundary, acceptance) => ({
    answers: {
      roles: { value: roles, at: ts, by: '林知远', source: 'user' },
      goal: { value: goal, at: ts, by: '林知远', source: 'user' },
      scope: { value: scope, at: ts, by: '林知远', source: 'user' },
      boundary: { value: boundary, at: ts, by: '林知远', source: 'user' },
      acceptance: { value: acceptance, at: ts, by: '林知远', source: 'user' }
    },
    history: [], completed: true
  })

  const MS = (productManager, actual = {}, plan = {}) => ({ productManager, ...actual, plan })

  function addReq({ id, title, status, code, origin, text, clarification, apps, owner = 'U-pm', iteration = null,
    requester, milestones, priorityInput = {} }) {
    const source = {
      type: origin || 'text', fileName: origin === 'file' ? '需求清单-2026Q4.docx' : '',
      excerpt: text, fullText: text, submitter: '林知远', parseNote: ''
    }
    const requesterValue = normalizeRequester(requester || {
      enterprise: '集团总部', department: '数字化中心', name: '林知远', level: 'middle', position: '产品经理'
    }, projectRow, {})
    const appList = (apps || []).map(a => ({ name: a, kind: 'internal' }))
    const priority = buildPriority({
      req: {
        title,
        clarification_json: JSON.stringify(clarification || { answers: {} }),
        source_json: JSON.stringify(source),
        involved_apps_json: JSON.stringify(appList),
        requester_json: JSON.stringify(requesterValue),
        priority_json: ''
      },
      project: projectRow,
      text: [title, text].join('\n'),
      input: priorityInput,
      actor: '林知远'
    })
    const ms = normalizeMilestones(milestones || {})
    run(`INSERT INTO requirements (id, project_id, code, title, status, origin_type, source_json, clarification_json,
         involved_apps_json, requester_json, milestones_json, snapshot_json, iteration_id, owner_id, priority_json,
         confirmed_at, confirmed_by, created_at, updated_at, stall_since) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, projectId, code || null, title, status, source.type, JSON.stringify(source),
      JSON.stringify(clarification || { answers: {}, history: [], completed: false }),
      JSON.stringify(appList), JSON.stringify(requesterValue), JSON.stringify(ms),
      code ? JSON.stringify({
        title, clarification: clarification?.answers || {}, involvedApps: apps,
        requester: { enterprise: requesterValue.enterprise, department: requesterValue.department, name: requesterValue.name, level: requesterValue.level },
        confirmedAt: ts, confirmedBy: '林知远'
      }) : null,
      iteration, owner, JSON.stringify(priority), code ? ts : null, code ? 'U-pm' : null, ts, ts, ts)
  }

  function addAnalysis(reqId, reqTitle, code, clarification, apps, text, version = 1, note = '分析初稿') {
    const req = { ...get('SELECT * FROM requirements WHERE id = ?', reqId), title: reqTitle, code, clarification_json: JSON.stringify(clarification || { answers: {} }), source_json: JSON.stringify({ fullText: text, excerpt: text }), involved_apps_json: JSON.stringify(apps.map(a => ({ name: a, kind: 'internal' }))) }
    const draft = generateSkillDraft({ req, project: projectRow })
    const analysis = normalizeAnalysis(draft.analysis)
    run('INSERT INTO requirement_versions (id, requirement_id, version, analysis_json, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
      uid('AV-'), reqId, version, JSON.stringify(analysis), note, 'U-pm', ts)
    return analysis
  }

  // 1-3 需求调研中
  addReq({ id: 'REQ-inbox-1', title: '按客户等级自动匹配折扣策略', status: '需求调研中', origin: 'text',
    text: '希望销售在创建订单时，系统能根据客户等级自动带出折扣策略，减少手工核对。目前折扣由销售自己在表格里查，容易出错。',
    requester: { enterprise: '集团总部', name: '林知远' } })
  addReq({ id: 'REQ-inbox-2', title: '采购订单审批支持多级会签', status: '需求调研中', origin: 'file',
    text: '采购订单金额超过 50 万需要走多级会签，采购协同系统要能看到会签进度并催办，涉及消息中心通知。',
    requester: { enterprise: '集团总部', department: '采购中心', name: '周维' } })
  addReq({ id: 'REQ-inbox-3', title: '移动端查看库存预警', status: '需求调研中', origin: 'form',
    text: '业务人员希望能在移动端查看库存预警列表，并且能直接发起补货申请，涉及库存管理和订单中心。',
    requester: { enterprise: '华东子公司', department: '仓储部', name: '外部业务方', level: 'external', external: true } })

  // 4 待需求分析
  const clar4 = CLAR('销售运营、销售经理', '把批量导入订单的人工核对时间降低一半',
    '销售管理平台订单中心的核心导入与校验', '不做历史订单迁移，不做移动端',
    '批量导入 200 条订单 5 分钟内完成，错误行可导出')
  addReq({ id: 'REQ-1', title: '销售订单批量导入与校验', status: '待需求分析', code: 'REQ-CRM-0001', origin: 'file',
    text: '支持销售订单批量导入与校验，导入前做客户、商品、价格三项校验，失败行可下载错误清单。', clarification: clar4,
    apps: ['销售管理平台', '订单中心'], iteration: it1,
    milestones: MS('林知远', {}, { reviewedAt: '2026-11-06T09:00:00', submittedAt: '2026-11-12T09:00:00' }) })

  // 5 需求分析中
  const clar5 = CLAR('销售运营、数据管理员', '消除客户重复档案，提升客户数据准确率',
    '客户服务平台客户档案模块', '不做跨集团客户合并', '重复客户识别准确率不低于 90%，合并后历史订单可追溯')
  addReq({ id: 'REQ-2', title: '客户档案合并与查重', status: '需求分析中', code: 'REQ-CRM-0002',
    text: '客户档案在销售和客服两个系统都有记录，需要支持查重、合并，合并后保留来源与历史订单关联。', clarification: clar5,
    apps: ['客户服务平台', '销售管理平台'], iteration: it1,
    requester: { enterprise: '集团总部', department: '客户运营部', name: '陈立', level: 'middle', position: '客户运营负责人' },
    milestones: MS('林知远', {}, { reviewedAt: '2026-11-10T09:00:00' }) })
  addAnalysis('REQ-2', '客户档案合并与查重', 'REQ-CRM-0002', clar5, ['客户服务平台', '销售管理平台'],
    '客户档案在销售和客服两个系统都有记录，需要支持查重、合并，合并后保留来源与历史订单关联。')

  // 6 需求分析中（已有原型草稿）
  const clar6 = CLAR('活动运营、销售经理', '活动配置从提出到生效缩短到半天',
    '销售管理平台的促销活动配置', '不做优惠券核销，不做外部渠道投放',
    '活动配置可完整走通，生效与失效时间准确，冲突有提示')
  addReq({ id: 'REQ-3', title: '促销活动配置与生效', status: '需求分析中', code: 'REQ-CRM-0003',
    text: '活动运营需要配置满减、折扣两类促销活动，设置生效时间与适用客户范围，冲突时给出提示。', clarification: clar6,
    apps: ['销售管理平台', '订单中心'], iteration: it1,
    requester: { enterprise: '华南子公司', department: '营销中心', name: '许安', level: 'basic', position: '活动运营' },
    milestones: MS('林知远', {}, { reviewedAt: '2026-11-07T09:00:00' }) })
  const a6 = addAnalysis('REQ-3', '促销活动配置与生效', 'REQ-CRM-0003', clar6, ['销售管理平台', '订单中心'],
    '活动运营需要配置满减、折扣两类促销活动，设置生效时间与适用客户范围，冲突时给出提示。')
  const pages6 = buildPrototypePages(a6, { code: 'REQ-CRM-0003', title: '促销活动配置与生效' })
  run('INSERT INTO prototypes (id, requirement_id, version, pages_json, status, analysis_version, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
    'PT-3-1', 'REQ-3', 1, JSON.stringify(pages6), 'draft', 1, 'U-pm', ts)

  // 7 需求评审中（已发布说明书）
  const clar7 = CLAR('采购员、采购主管', '询价比价单自动生成，减少手工汇总',
    '采购协同系统询价模块', '不做供应商准入审核', '3 家以上供应商报价可自动汇总比价，结果可导出')
  addReq({ id: 'REQ-4', title: '采购询价比价单生成', status: '需求评审中', code: 'REQ-CRM-0004',
    text: '采购员发起询价后，系统自动汇总供应商报价生成比价单，支持按价格、交期排序并导出。', clarification: clar7,
    apps: ['采购协同系统', '数据中台'], iteration: it2,
    requester: { enterprise: '华北分公司', department: '采购部', name: '周维', level: 'middle', position: '采购主管' },
    milestones: MS('周维', {}, { reviewedAt: '2026-11-05T09:00:00', submittedAt: '2026-11-14T09:00:00' }) })
  const a7 = addAnalysis('REQ-4', '采购询价比价单生成', 'REQ-CRM-0004', clar7, ['采购协同系统', '数据中台'],
    '采购员发起询价后，系统自动汇总供应商报价生成比价单，支持按价格、交期排序并导出。')
  const pages7 = buildPrototypePages(a7, { code: 'REQ-CRM-0004', title: '采购询价比价单生成' })
  run('INSERT INTO prototypes (id, requirement_id, version, pages_json, status, analysis_version, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
    'PT-4-1', 'REQ-4', 1, JSON.stringify(pages7), 'confirmed', 1, 'U-pm', ts)
  const req4row = get('SELECT * FROM requirements WHERE id = ?', 'REQ-4')
  const md4 = specMarkdown({ req: req4row, project: projectRow, analysis: a7, pages: pages7, version: 1, reviews: [], changes: [] })
  const html4 = specHtml({ req: req4row, project: projectRow, analysis: a7, pages: pages7, version: 1, reviews: [], changes: [], protoId: 'PT-4-1' })
  run('INSERT INTO specs (id, requirement_id, version, markdown, html, analysis_version, prototype_version, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    'SPEC-4-1', 'REQ-4', 1, md4, html4, 1, 1, 'published', 'U-pm', ts)

  // 8 需求评审中
  const clar8 = CLAR('客服专员、客服主管、财务', '退货审批全流程在线，缩短退款周期',
    '客户服务平台退货单与审批流', '不做逆向物流轨迹', '退货单平均处理时长下降 40%，审批节点可追溯')
  addReq({ id: 'REQ-5', title: '销售退货单审批流', status: '需求评审中', code: 'REQ-CRM-0005',
    text: '客户发起退货后，客服专员登记退货单，客服主管与财务依次审批，审批通过后触发退款，涉及消息中心通知。', clarification: clar8,
    apps: ['客户服务平台', '订单中心', '消息中心'], iteration: it1,
    requester: { enterprise: '集团总部', department: '客户服务中心', name: '陈立', level: 'middle', position: '客服主管' },
    milestones: MS('林知远', {}, { reviewedAt: '2026-10-30T09:00:00', submittedAt: '2026-11-08T09:00:00' }) })
  const a8 = addAnalysis('REQ-5', '销售退货单审批流', 'REQ-CRM-0005', clar8, ['客户服务平台', '订单中心', '消息中心'],
    '客户发起退货后，客服专员登记退货单，客服主管与财务依次审批，审批通过后触发退款，涉及消息中心通知。')
  const pages8 = buildPrototypePages(a8, { code: 'REQ-CRM-0005', title: '销售退货单审批流' })
  run('INSERT INTO prototypes (id, requirement_id, version, pages_json, status, analysis_version, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
    'PT-5-1', 'REQ-5', 1, JSON.stringify(pages8), 'confirmed', 1, 'U-pm', ts)
  const req5row = get('SELECT * FROM requirements WHERE id = ?', 'REQ-5')
  const md5 = specMarkdown({ req: req5row, project: projectRow, analysis: a8, pages: pages8, version: 1, reviews: [], changes: [] })
  const html5 = specHtml({ req: req5row, project: projectRow, analysis: a8, pages: pages8, version: 1, reviews: [], changes: [], protoId: 'PT-5-1' })
  run('INSERT INTO specs (id, requirement_id, version, markdown, html, analysis_version, prototype_version, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    'SPEC-5-1', 'REQ-5', 1, md5, html5, 1, 1, 'published', 'U-pm', ts)
  run('INSERT INTO reviews (id, requirement_id, spec_id, round, reviewers_json, deadline, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    'RV-5-1', 'REQ-5', 'SPEC-5-1', 1, JSON.stringify(['U-r1', 'U-r2']), '2026-11-10', '进行中', 'U-pm', ts)
  const suggestions = [
    ['SG-5-1', 1, '功能设计：补充财务复核节点', '财务审批后缺少复核环节，建议增加财务复核节点并记录复核人。', '在审批流中补充财务复核节点'],
    ['SG-5-2', 2, '验收口径：退款时效不明确', '验收口径需要写明退款到账的时限要求。', '补充退款到账时限与统计口径'],
    ['SG-5-3', 3, '集成说明：消息中心模板未定义', '通知模板与触发时机未说明，开发阶段容易返工。', '补充消息模板与触发时机']
  ]
  for (const [id, seq, title, detail, expected] of suggestions) {
    run(`INSERT INTO suggestions (id, review_id, requirement_id, seq, title, detail, expected, status, annotation_ids_json, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, 'RV-5-1', 'REQ-5', seq, title, detail, expected, '待处理', '[]', 'U-r1', ts)
  }
  run('INSERT INTO annotations (id, review_id, section, quote, content, author_id, stale, created_at) VALUES (?,?,?,?,?,?,0,?)',
    'AN-5-1', 'RV-5-1', '功能设计', '客服主管与财务依次审批', '财务审批后缺少复核环节。', 'U-r1', ts)

  // 9 开发中（评审已通过，V2 说明书）
  const clar9 = CLAR('仓管员、仓储主管', '跨仓调拨从申请到出库全流程在线',
    '库存管理跨仓调拨', '不做自动补货算法', '调拨单可完整流转，出库与入库库存一致')
  addReq({ id: 'REQ-6', title: '库存跨仓调拨申请', status: '开发中', code: 'REQ-CRM-0006',
    text: '仓管员发起跨仓调拨申请，仓储主管审批后，出库仓与入库仓分别确认，库存实时变化。', clarification: clar9,
    apps: ['销售管理平台', '库存管理', '订单中心'], iteration: it2,
    requester: { enterprise: '西南分公司', department: '仓储部', name: '王珂', level: 'basic', position: '仓储主管' },
    milestones: MS('王珂', { reviewedAt: '2026-10-28T09:00:00' },
      { submittedAt: '2026-11-08T09:00:00', testedAt: '2026-11-12T09:00:00', uatAt: '2026-11-16T09:00:00', releasedAt: '2026-11-20T09:00:00' }) })
  const a9 = addAnalysis('REQ-6', '库存跨仓调拨申请', 'REQ-CRM-0006', clar9, ['销售管理平台', '库存管理', '订单中心'],
    '仓管员发起跨仓调拨申请，仓储主管审批后，出库仓与入库仓分别确认，库存实时变化。', 1, '分析初稿')
  const a9v2 = normalizeAnalysis({ ...a9, description: { ...a9.description, value: `${a9.description.value}（已按评审意见补充审批留痕说明）` } })
  run('INSERT INTO requirement_versions (id, requirement_id, version, analysis_json, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
    uid('AV-'), 'REQ-6', 2, JSON.stringify(a9v2), '评审修改', 'U-pm', ts)
  const pages9 = buildPrototypePages(a9v2, { code: 'REQ-CRM-0006', title: '库存跨仓调拨申请' })
  run('INSERT INTO prototypes (id, requirement_id, version, pages_json, status, analysis_version, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
    'PT-6-1', 'REQ-6', 1, JSON.stringify(pages9), 'confirmed', 2, 'U-pm', ts)
  const req6row = get('SELECT * FROM requirements WHERE id = ?', 'REQ-6')
  const md9v1 = specMarkdown({ req: req6row, project: projectRow, analysis: a9, pages: pages9, version: 1, reviews: [], changes: [] })
  const md9v2 = specMarkdown({ req: req6row, project: projectRow, analysis: a9v2, pages: pages9, version: 2, reviews: [], changes: [] })
  const html9v2 = specHtml({ req: req6row, project: projectRow, analysis: a9v2, pages: pages9, version: 2, reviews: [], changes: [], protoId: 'PT-6-1' })
  run('INSERT INTO specs (id, requirement_id, version, markdown, html, analysis_version, prototype_version, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    'SPEC-6-1', 'REQ-6', 1, md9v1, html9v2, 1, 1, 'superseded', 'U-pm', ts)
  run('INSERT INTO specs (id, requirement_id, version, markdown, html, analysis_version, prototype_version, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    'SPEC-6-2', 'REQ-6', 2, md9v2, html9v2, 2, 1, 'published', 'U-pm', ts)
  run('INSERT INTO reviews (id, requirement_id, spec_id, round, reviewers_json, deadline, status, conclusion, summary, created_by, created_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    'RV-6-1', 'REQ-6', 'SPEC-6-1', 1, JSON.stringify(['U-r1', 'U-r2']), '2026-10-28', '已完成', '通过', '审批留痕已补充，同意进入开发。', 'U-pm', ts, ts)
  run(`INSERT INTO suggestions (id, review_id, requirement_id, seq, title, detail, expected, status, annotation_ids_json, resolution_version, resolution_note, created_by, created_at, closed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'SG-6-1', 'RV-6-1', 'REQ-6', 1, '功能设计：补充审批留痕', '审批节点需记录处理人与意见。', '在说明书中补充留痕说明', '已消除', '[]', 2, '已在 V2 说明书补充', 'U-r1', ts, ts)

  // 10 待测试验证
  const clar10 = CLAR('客服专员', '客户可以在线自助修改联系方式',
    '客户服务平台的客户自助中心', '不做实名认证流程改造', '修改后 1 分钟内同步至销售管理平台')
  addReq({ id: 'REQ-7', title: '客户自助修改联系方式', status: '待测试验证', code: 'REQ-CRM-0007',
    text: '客户在自助中心修改手机号与地址，校验通过后同步到销售管理平台。', clarification: clar10,
    apps: ['客户服务平台', '销售管理平台'], iteration: it1,
    milestones: MS('林知远', { reviewedAt: '2026-10-12T09:00:00', submittedAt: '2026-10-26T09:00:00' },
      { testedAt: '2026-11-02T09:00:00', uatAt: '2026-11-06T09:00:00', pilotAt: '2026-11-09T09:00:00', releasedAt: '2026-11-10T09:00:00' }) })
  const a10 = addAnalysis('REQ-7', '客户自助修改联系方式', 'REQ-CRM-0007', clar10, ['客户服务平台', '销售管理平台'],
    '客户在自助中心修改手机号与地址，校验通过后同步到销售管理平台。')
  const pages10 = buildPrototypePages(a10, { code: 'REQ-CRM-0007', title: '客户自助修改联系方式' })
  run('INSERT INTO prototypes (id, requirement_id, version, pages_json, status, analysis_version, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
    'PT-7-1', 'REQ-7', 1, JSON.stringify(pages10), 'confirmed', 1, 'U-pm', ts)
  const req7row = get('SELECT * FROM requirements WHERE id = ?', 'REQ-7')
  const md10 = specMarkdown({ req: req7row, project: projectRow, analysis: a10, pages: pages10, version: 1, reviews: [], changes: [] })
  const html10 = specHtml({ req: req7row, project: projectRow, analysis: a10, pages: pages10, version: 1, reviews: [], changes: [], protoId: 'PT-7-1' })
  run('INSERT INTO specs (id, requirement_id, version, markdown, html, analysis_version, prototype_version, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    'SPEC-7-1', 'REQ-7', 1, md10, html10, 1, 1, 'published', 'U-pm', ts)
  run('INSERT INTO reviews (id, requirement_id, spec_id, round, reviewers_json, deadline, status, conclusion, summary, created_by, created_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    'RV-7-1', 'REQ-7', 'SPEC-7-1', 1, JSON.stringify(['U-r1', 'U-r2']), '2026-10-10', '已完成', '通过', '同意开发。', 'U-pm', ts, ts)

  // 11 全国推广中
  const clar11 = CLAR('销售运营', '客户列表支持标签筛选',
    '客户服务平台客户列表', '不做标签自动打标', '筛选结果准确，响应时间小于 2 秒')
  addReq({ id: 'REQ-8', title: '客户列表标签筛选', status: '全国推广中', code: 'REQ-CRM-0008',
    text: '客户列表支持按标签组合筛选，并保存常用筛选条件。', clarification: clar11,
    apps: ['客户服务平台'], iteration: it0, priorityInput: { estimateDays: 3 },
    milestones: MS('林知远',
      { reviewedAt: '2026-09-10T09:00:00', submittedAt: '2026-09-24T09:00:00', testedAt: '2026-10-02T09:00:00', uatAt: '2026-10-08T09:00:00', pilotAt: '2026-10-14T09:00:00', releasedAt: '2026-10-16T09:00:00' }) })
  const a11 = addAnalysis('REQ-8', '客户列表标签筛选', 'REQ-CRM-0008', clar11, ['客户服务平台'],
    '客户列表支持按标签组合筛选，并保存常用筛选条件。')
  const pages11 = buildPrototypePages(a11, { code: 'REQ-CRM-0008', title: '客户列表标签筛选' })
  run('INSERT INTO prototypes (id, requirement_id, version, pages_json, status, analysis_version, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
    'PT-8-1', 'REQ-8', 1, JSON.stringify(pages11), 'confirmed', 1, 'U-pm', ts)
  const req8row = get('SELECT * FROM requirements WHERE id = ?', 'REQ-8')
  const md11 = specMarkdown({ req: req8row, project: projectRow, analysis: a11, pages: pages11, version: 1, reviews: [], changes: [] })
  const html11 = specHtml({ req: req8row, project: projectRow, analysis: a11, pages: pages11, version: 1, reviews: [], changes: [], protoId: 'PT-8-1' })
  run('INSERT INTO specs (id, requirement_id, version, markdown, html, analysis_version, prototype_version, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    'SPEC-8-1', 'REQ-8', 1, md11, html11, 1, 1, 'published', 'U-pm', ts)

  // 12 挂起
  const req9Requester = normalizeRequester({
    enterprise: '集团总部', department: '会员运营部', name: '周维', level: 'middle', position: '会员运营负责人'
  }, projectRow, {})
  const req9Source = {
    type: 'text', excerpt: '客户积分规则需要支持按等级差异化累积，并支持兑换。',
    fullText: '客户积分规则需要支持按等级差异化累积，并支持兑换。', submitter: '周维'
  }
  const req9Priority = buildPriority({
    req: {
      title: '客户积分体系升级',
      clarification_json: JSON.stringify({ answers: {} }),
      source_json: JSON.stringify(req9Source),
      involved_apps_json: JSON.stringify([{ name: '客户服务平台', kind: 'internal' }]),
      requester_json: JSON.stringify(req9Requester),
      priority_json: ''
    },
    project: projectRow,
    text: [ '客户积分体系升级', req9Source.fullText ].join('\n'),
    input: { estimateDays: 8 },
    actor: '周维'
  })
  run(`INSERT INTO requirements (id, project_id, title, status, origin_type, source_json, clarification_json, involved_apps_json,
       requester_json, milestones_json, iteration_id, owner_id, priority_json, suspended_from, created_at, updated_at, stall_since)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    'REQ-9', projectId, '客户积分体系升级', '挂起', 'text',
    JSON.stringify(req9Source),
    JSON.stringify({ answers: {}, history: [], completed: false }),
    JSON.stringify([{ name: '客户服务平台', kind: 'internal' }]),
    JSON.stringify(req9Requester), JSON.stringify(normalizeMilestones({})),
    null, 'U-pm2', JSON.stringify(req9Priority), '待需求分析', ts, ts, ts)

  // 变更记录
  run(`INSERT INTO changes (id, requirement_id, seq, reason, content, grade, impact_json, handling, status, before_spec, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    'CHG-6-1', 'REQ-6', 1, '评审意见要求补充审批留痕', '功能设计调整：增加审批处理人与意见记录', '中等',
    JSON.stringify({ grade: '中等', flags: { functions: true }, notes: ['调整功能或原型'] }), '已应用', '已应用', 'SPEC-6-1', 'U-pm', ts)

  // 依赖
  run('INSERT INTO dependencies (id, project_id, from_req, to_req, created_at) VALUES (?,?,?,?,?)', 'DEP-1', projectId, 'REQ-6', 'REQ-3', ts)
  run('INSERT INTO dependencies (id, project_id, from_req, to_req, created_at) VALUES (?,?,?,?,?)', 'DEP-2', projectId, 'REQ-5', 'REQ-1', ts)

  // 迭代级说明书草稿（演示缺项待补与版本系列）
  const iterationRow = get('SELECT * FROM iterations WHERE id = ?', it1)
  const iterationReqRows = all("SELECT * FROM requirements WHERE iteration_id = ? AND status NOT IN ('需求调研中','已丢弃') ORDER BY created_at", it1)
  const iterationItems = collectIterationSources({ project: projectRow, requirements: iterationReqRows })
  const iterationVersion = nextIterationSpecVersion(it1)
  const iterationBuilt = buildIterationSpec({
    project: projectRow, iteration: iterationRow, items: iterationItems, version: iterationVersion, mode: 'draft'
  })
  run(`INSERT INTO iteration_specs (id, project_id, iteration_id, version, mode, status, html, markdown, source_json,
       requirement_count, missing_json, stale, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newIterationSpecId(), projectId, it1, iterationVersion, 'draft', 'draft',
    iterationBuilt.html, iterationBuilt.markdown, JSON.stringify(iterationBuilt.source),
    iterationBuilt.requirementCount, JSON.stringify(iterationBuilt.missing), 0, 'U-pm', ts)

  // 内置技能包（qoder-prd-skill-pack）
  ensureBuiltinSkills()

  // 通知与事件
  const notes = [
    ['NTF-1', 'U-pm', 'review', '评审有新意见', '需求 REQ-CRM-0005 收到 3 条评审建议'],
    ['NTF-2', 'U-r1', 'review', '待评审提醒', '需求 REQ-CRM-0004 已发布说明书，等待评审'],
    ['NTF-3', 'U-dev', 'requirement', '需求进入开发', 'REQ-CRM-0006 库存跨仓调拨申请已进入开发'],
    ['NTF-4', 'U-pm', 'risk', '风险预警', 'REQ-CRM-0002 停留在需求分析中超过 7 天']
  ]
  for (const [id, userId, type, title, body] of notes) {
    run('INSERT INTO notifications (id, user_id, project_id, type, title, body, read, created_at) VALUES (?,?,?,?,?,?,0,?)',
      id, userId, projectId, type, title, body, ts)
  }

  const eventSeed = [
    ['REQ-1', 'confirm', '确认需求并分配编号 REQ-CRM-0001', 'U-pm'],
    ['REQ-2', 'analysis', '保存分析 V1（manual）', 'U-pm'],
    ['REQ-3', 'status', '待需求分析 → 需求分析中', 'U-pm'],
    ['REQ-4', 'spec-publish', '发布说明书 V1', 'U-pm'],
    ['REQ-5', 'review', '发起第 1 轮评审', 'U-pm'],
    ['REQ-6', 'status', '需求评审中 → 开发中', 'U-pm'],
    ['REQ-7', 'status', '开发中 → 待测试验证', 'U-dev'],
    ['REQ-8', 'status', '待测试验证 → 全国推广中', 'U-dev']
  ]
  let offset = 0
  for (const [reqId, type, message, actor] of eventSeed) {
    offset += 3600000
    run('INSERT INTO events (id, project_id, requirement_id, type, message, payload_json, actor_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
      uid('EV-'), projectId, reqId, type, message, '{}', actor, new Date(Date.now() - 86400000 + offset).toISOString())
  }

  run("UPDATE prototypes SET updated_at = created_at WHERE updated_at IS NULL")
  run("UPDATE specs SET updated_at = created_at WHERE updated_at IS NULL")
  run("UPDATE iteration_specs SET updated_at = created_at WHERE updated_at IS NULL")

  // 计数器与实际编号对齐
  run('INSERT INTO counters (scope, value) VALUES (?, ?)', `req:${projectId}`, 8)

  db.exec('COMMIT')
  console.log('演示数据已写入：7 个账号、1 个项目、3 个迭代、12 条需求、5 个技能包。')
  console.log('产品经理账号：林知远（U-pm）')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('初始化失败：', err)
  process.exit(1)
}
