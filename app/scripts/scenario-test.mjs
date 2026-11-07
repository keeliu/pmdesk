import JSZip from 'jszip'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const PORT = 4399
const dbFile = path.join(os.tmpdir(), `wb-scenario-${Date.now()}.db`)
const env = { ...process.env, WORKBENCH_DB: dbFile, PORT: String(PORT), PYTHONUTF8: '1' }

const results = []
let server = null
const ctx = {}

function assert(cond, message) { if (!cond) throw new Error(message) }
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

async function test(capability, name, fn) {
  try {
    await fn()
    results.push({ capability, name, ok: true })
    console.log(`  ✓ ${name}`)
  } catch (e) {
    results.push({ capability, name, ok: false, error: e.message })
    console.log(`  ✗ ${name}\n      ${e.message}`)
  }
}

async function waitHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      if (r.ok) return
    } catch { /* 等待启动 */ }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('API 未能启动')
}

async function login(userId) {
  const r = await api(null, 'POST', '/api/session', { userId })
  if (r.status !== 200) throw new Error(`登录失败：${JSON.stringify(r.body)}`)
  const raw = r.setCookie
  assert(raw, '登录未返回会话 Cookie')
  return raw.split(';')[0]
}

const cookies = {}

async function api(who, method, p, body) {
  const headers = { 'Content-Type': 'application/json' }
  if (who) headers.Cookie = cookies[who] || who
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method, headers,
    body: body === undefined || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
  const setCookie = res.headers.getSetCookie?.()[0] || res.headers.get('set-cookie') || ''
  return { status: res.status, body: parsed, text, headers: res.headers, setCookie }
}

async function ok(who, method, p, body = {}) {
  const r = await api(who, method, p, body)
  if (r.status >= 400) throw new Error(`${method} ${p} 返回 ${r.status}：${r.body?.error || r.text.slice(0, 120)}`)
  return r.body
}

async function fails(who, method, p, status, body = {}) {
  const r = await api(who, method, p, body)
  if (r.status !== status) throw new Error(`${method} ${p} 期望 ${status}，实际 ${r.status}：${r.body?.error || r.text.slice(0, 120)}`)
  return r.body
}

function analysisPayload() {
  return {
    description: {
      background: '客户与订单信息分散在多个系统，检索依赖线下表格。',
      goal: '在一个页面统一查看客户与订单，并支持按名称检索。',
      roles: ['客户经理', '运营专员'],
      value: '缩短信息查找时间，减少重复核对。'
    },
    process: {
      summary: '登记 → 分配 → 处理 → 回写',
      steps: [
        { node: '登记', role: '客户经理', action: '提交查询申请', branch: '', result: '生成申请单', next: '分配' },
        { node: '分配', role: '运营专员', action: '分配负责人', branch: '无人可分配时退回', result: '确定处理人', next: '处理' },
        { node: '处理', role: '运营专员', action: '查询并记录结果', branch: '', result: '形成查询记录', next: '回写' },
        { node: '回写', role: '系统', action: '同步订单状态', branch: '', result: '数据一致', next: '结束' }
      ]
    },
    functions: {
      architecture: [
        { name: '客户管理', description: '支撑客户信息的统一检索与查看' },
        { name: '检索客户与订单', parent: '客户管理', description: '按名称或编号检索客户及其订单' },
        { name: '查看客户详情', parent: '客户管理', description: '查看客户基础信息与订单明细' }
      ],
      list: [
        {
          id: 'F1', name: '检索客户与订单', group: '客户管理', priority: 'P0',
          description: '输入客户名称或编号，返回匹配客户及关联订单列表',
          trigger: '客户经理在客户检索页输入关键词',
          rules: '支持名称模糊匹配，单次最多返回 50 条，无结果时提示调整关键词',
          result: '展示客户与订单列表，可下钻到客户详情',
          acceptance: '按名称检索能在 1 秒内返回客户及其关联订单，结果与源系统一致'
        },
        {
          id: 'F2', name: '查看客户详情', group: '客户管理', priority: 'P1',
          description: '展示客户基础信息、联系人以及最近订单明细',
          trigger: '客户经理在检索结果中点击某条客户记录',
          rules: '仅展示当前登录人有权限查看的客户，订单按时间倒序排列',
          result: '显示客户档案与订单明细，可返回检索结果',
          acceptance: '详情页能完整显示客户档案与最近 20 条订单，无权限数据不展示'
        }
      ],
      flow: [
        { id: 'FF-01', from: '客户检索页', action: '输入关键词 <script>alert(1)</script>', condition: '已登录且有查看权限', to: '结果列表' },
        { id: 'FF-02', from: '结果列表', action: '查看客户详情', condition: '存在匹配记录', to: '客户详情' }
      ],
      support: [{ name: '配置客户查看权限', description: '按角色配置可检索与查看的客户范围，变更后实时生效' }]
    },
    integration: {
      apps: [{ name: '客户中心', kind: 'internal' }, { name: '销售管理', kind: 'internal' }],
      points: [{ id: 'IP1', app: '客户中心', direction: '读取', object: '客户', trigger: '检索时' }]
    },
    acceptance: { steps: ['申请提交成功', '检索返回结果', '回写状态一致'], overall: '关键流程完整走通且数据一致', metrics: [] },
    meta: { requiresSupport: false, revisionNotes: [] }
  }
}

async function setup() {
  console.log('启动测试环境…')
  const seed = spawnSync(process.execPath, ['server/seed.mjs'], { cwd: root, env, encoding: 'utf8' })
  if (seed.status !== 0) throw new Error(`种子数据初始化失败：${seed.stderr || seed.stdout}`)
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  server.stdout.on('data', d => { logs += d })
  server.stderr.on('data', d => { logs += d })
  server.on('exit', code => { if (code && code !== 0) console.error(`服务进程退出 ${code}\n${logs.slice(-2000)}`) })
  await waitHealth()
  for (const u of ['U-pm', 'U-r1', 'U-r2', 'U-dev', 'U-guest', 'U-pm2', 'U-admin']) cookies[u] = await login(u)
}

async function run() {
  await setup()

  console.log('\n[project-iteration-management]')
  await test('project-iteration-management', '创建项目并写入系统范围与成员', async () => {
    const code = 'T' + String(Date.now()).slice(-6)
    const p = await ok('U-pm', 'POST', '/api/projects', {
      name: '场景测试项目', code, description: '自动化验收',
      goals: ['验证端到端门禁'],
      systemScope: { applications: ['客户中心', '销售管理', '工作台'], platforms: ['统一门户'], modules: ['客户检索'] },
      enterpriseScope: {
        mode: 'unified', total: 2,
        specialCompanies: ['集团总部', '华东子公司'], provinceCompanies: [], personalized: []
      },
      members: [
        { userId: 'U-pm', role: 'pm' }, { userId: 'U-r1', role: 'reviewer' }, { userId: 'U-r2', role: 'reviewer' },
        { userId: 'U-dev', role: 'developer' }, { userId: 'U-guest', role: 'guest' }
      ]
    })
    ctx.projectId = p.id
    eq(p.code, code, '项目代号')
    const list = await ok('U-pm', 'GET', '/api/projects')
    assert(list.some(x => x.id === p.id), '项目列表应包含新项目')
    const detail = await ok('U-pm', 'GET', `/api/projects/${p.id}`)
    eq(detail.systemScope.applications.length, 3, '系统范围应用数')
    const members = await ok('U-pm', 'GET', `/api/projects/${p.id}/members`)
    assert(members.some(m => m.id === 'U-r1' && m.project_role === 'reviewer'), '成员角色应落库')
  })

  await test('project-iteration-management', '创建迭代并校验容量字段', async () => {
    ctx.iteration = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/iterations`, {
      name: '迭代 A', goal: '完成客户检索', startDate: '2026-11-10', endDate: '2026-11-24', capacityDays: 20
    })
    ctx.tinyIteration = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/iterations`, {
      name: '迭代 B', goal: '容量校验', startDate: '2026-11-25', endDate: '2026-12-01', capacityDays: 0.5
    })
    const list = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/iterations`)
    const it = list.find(x => x.id === ctx.iteration.id)
    eq(it.capacity_days, 20, '迭代容量')
    eq(it.status, 'planning', '迭代初始状态')
  })

  console.log('\n[requirement-intake]')
  await test('requirement-intake', '待澄清箱分页返回总数与指定页数据', async () => {
    await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/intake`, { text: '分页用例一：库存预警需要按仓库维度分别设置阈值。' })
    await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/intake`, { text: '分页用例二：消息中心需要支持按级别免打扰。' })
    await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/intake`, { text: '分页用例三：权限中心需要支持按岗位批量授权。' })
    const r = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/requirements?inbox=1&page=1&pageSize=2`)
    eq(r.page, 1, '页码')
    eq(r.pageSize, 2, '每页条数')
    eq(r.items.length, 2, '第一页应只有两条')
    assert(r.total >= 3, '总数应不小于三条')
    const r2 = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/requirements?inbox=1&page=999&pageSize=2`)
    eq(r2.items.length, 0, '超页码应返回空数组')
    eq(r2.total, r.total, '总数不受页码影响')
    const arr = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/requirements?inbox=1`)
    assert(Array.isArray(arr), '不带分页参数应保持原数组结构')
  })

  await test('requirement-intake', '批量丢弃须同项目且全部待澄清', async () => {
    const a = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/intake`, { text: '批量丢弃用例一：订单导出需要支持自定义字段选择。' })
    const b = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/intake`, { text: '批量丢弃用例二：客户列表需要增加标签筛选。' })
    await fails('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/batch-discard`, 400, { ids: [a.created[0].id], reason: '' })
    const r = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/batch-discard`, { ids: [a.created[0].id, b.created[0].id], reason: '测试清理' })
    eq(r.count, 2, '应丢弃两条')
    const detail = await ok('U-pm', 'GET', `/api/requirements/${a.created[0].id}`)
    eq(detail.status, '已丢弃', '丢弃后状态')
    eq(detail.discard_reason, '测试清理', '丢弃原因')
    await fails('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/batch-discard`, 400, { ids: [a.created[0].id], reason: '再次丢弃' })
  })

  await test('requirement-intake', '文本登记进入待澄清箱且不分配编号', async () => {
    const r = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/intake`, {
      text: '客户经理需要在一个页面查看客户与订单信息，并支持按名称检索。', submitter: '林知远'
    })
    assert(r.created.length >= 1, '应创建至少一条需求')
    ctx.req1 = r.created[0].id
    const inbox = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/requirements?inbox=1`)
    const row = inbox.find(x => x.id === ctx.req1)
    assert(row, '待澄清箱应包含新需求')
    eq(row.code, null, '待澄清需求不应有编号')
    eq(row.source.submitter, '林知远', '来源提交人')
    const pool = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/requirements`)
    assert(!pool.some(x => x.id === ctx.req1), '未确认需求不应出现在需求池')
  })

  await test('requirement-intake', '相似需求检测与忽略留痕', async () => {
    const r = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/intake`, {
      text: '客户经理需要在一个页面查看客户与订单信息，并支持按名称检索。', submitter: '林知远'
    })
    ctx.req2 = r.created[0].id
    assert(r.created[0].duplicate?.id === ctx.req1, '应识别出与首条需求的重复')
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req2}/similarity-ignore`, { similarId: ctx.req1 })
    const detail = await ok('U-pm', 'GET', `/api/requirements/${ctx.req2}`)
    assert(!(detail.related || []).some(x => x.id === ctx.req1), '忽略后不应再对同一对需求提示')
  })

  console.log('\n[requirement-intake-distill]')
  await test('requirement-intake-distill', '大模型提炼文档需求并预填提出方与涉及应用', async () => {
    const canned = {
      requirements: [
        {
          title: '客户等级折扣自动匹配',
          description: '销售创建订单时希望系统按客户等级自动带出折扣策略，减少手工查表出错。',
          requester: { enterprise: '集团总部', department: '销售运营部', name: '林知远' },
          apps: ['客户中心']
        },
        {
          title: '订单列表增加导出',
          description: '运营人员需要把订单列表导出为 Excel 以便线下核对，导出字段与列表一致。',
          requester: {},
          apps: []
        }
      ]
    }
    const mockModel = createServer((rq, rs) => {
      rs.writeHead(200, { 'Content-Type': 'application/json' })
      rs.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(canned) } }], usage: { prompt_tokens: 100, completion_tokens: 80 } }))
    })
    await new Promise(r => mockModel.listen(4398, '127.0.0.1', r))
    try {
      await ok('U-pm', 'PUT', `/api/projects/${ctx.projectId}/model`, { baseUrl: 'http://127.0.0.1:4398/v1', model: 'mock', apiKey: 'mock-key' })
      const doc = [
        '会议纪要',
        '',
        '会议时间：2026-10-27 14:00，会议方式：线上视频，主持人：张敏，参会人：各部门负责人。',
        '',
        '议题一：销售部门提出，销售创建订单时希望系统按客户等级自动带出折扣策略，减少手工查表出错。希望纳入客户中心建设范围，提出人为销售运营部林知远。',
        '',
        '议题二：运营人员反馈订单列表需要增加导出功能，便于线下核对，导出字段应与列表保持一致。'
      ].join('\n')
      const r = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/intake`, {
        file: { name: '会议纪要.md', base64: Buffer.from(doc, 'utf8').toString('base64') }
      })
      eq(r.created.length, 2, '应只提炼两条真实需求而非逐行拆分')
      assert(r.created.some(x => x.title === '客户等级折扣自动匹配'), '第一条提炼标题')
      assert(r.created.some(x => x.title === '订单列表增加导出'), '第二条提炼标题')
      assert(r.parseNote.includes('大模型提炼 2 条需求'), '解析说明应标注提炼条数')
      const first = await ok('U-pm', 'GET', `/api/requirements/${r.created.find(x => x.title === '客户等级折扣自动匹配').id}`)
      eq(first.requester.name, '林知远', '提炼的提出人应预填')
      eq(first.requester.enterprise, '集团总部', '提炼的提出企业应预填')
      eq(first.involvedApps.length, 1, '应预填涉及应用')
      eq(first.involvedApps[0].name, '客户中心', '应用应命中系统范围')
      eq(first.involvedApps[0].kind, 'internal', '应用应标记为内部')
      eq(first.source.distilled, true, '来源应标注大模型提炼')
    } finally {
      await new Promise(r => mockModel.close(r))
      await ok('U-pm', 'PUT', `/api/projects/${ctx.projectId}/model`, { baseUrl: '', model: '' })
    }
  })

  await test('requirement-intake-distill', '模型不可达时降级为段落拆分并留痕', async () => {
    await ok('U-pm', 'PUT', `/api/projects/${ctx.projectId}/model`, { baseUrl: 'http://127.0.0.1:9/v1', model: 'mock', apiKey: 'mock-key' })
    try {
      const doc = '议题一：销售创建订单时希望系统按客户等级自动带出折扣策略，减少手工查表出错。\n\n议题二：运营人员反馈订单列表需要增加导出功能，便于线下核对，导出字段应与列表保持一致。'
      const r = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/intake`, {
        file: { name: '会议纪要.md', base64: Buffer.from(doc, 'utf8').toString('base64') }
      })
      eq(r.created.length, 2, '降级后仍应拆分出两条')
      assert(r.created.every(x => x.title.startsWith('议题')), '降级应按段落拆分')
      assert(r.parseNote.includes('提炼失败') || r.parseNote.includes('未启用'), '解析说明应标注降级原因')
      const first = await ok('U-pm', 'GET', `/api/requirements/${r.created[0].id}`)
      eq(first.involvedApps.length, 0, '降级路径不应预填涉及应用')
      assert(!first.source.distilled, '降级来源不应标注大模型提炼')
    } finally {
      await ok('U-pm', 'PUT', `/api/projects/${ctx.projectId}/model`, { baseUrl: '', model: '' })
    }
  })

  console.log('\n[requirement-clarification]')
  await test('requirement-clarification', '缺口识别与结构化追问不超过四题', async () => {
    const q = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}/clarification/questions`)
    assert(q.gaps.length >= 5, '应识别出澄清缺口')
    assert(q.questions.length <= 4, '单次追问不应超过四题')
    const infer = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}/clarification/infer-apps`)
    assert(infer.apps.length >= 1, '应推断出涉及应用')
  })

  await test('requirement-clarification', '补齐五项澄清与涉及应用后缺口归零', async () => {
    const scope = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/scope-apps`)
    const r = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/clarification/answers`, {
      answers: [
        { field: 'requester', value: { enterprise: '集团总部', department: '销售运营部', name: '林知远', level: 'middle', position: '产品经理' } },
        { field: 'roles', value: '客户经理提出，运营专员处理' },
        { field: 'goal', value: '统一查看客户与订单' },
        { field: 'scope', value: '仅覆盖客户检索与订单查看' },
        { field: 'boundary', value: '本期不做订单编辑' },
        { field: 'acceptance', value: '检索结果与订单一致' },
        { field: 'involvedApps', value: [scope.all[0], scope.all[1]] }
      ]
    })
    eq(r.gaps.length, 0, '澄清缺口应归零')
    assert(r.clarification.completed, '应标记澄清完成')
  })

  console.log('\n[requester-governance]')
  await test('requester-governance', '提出方信息补全、级别归一与范围校验', async () => {
    await fails('U-pm', 'PATCH', `/api/requirements/${ctx.req2}/requester`, 400, {
      enterprise: '范围外公司', department: '测试部', name: '林知远', level: '中层'
    })
    const r = await ok('U-pm', 'PATCH', `/api/requirements/${ctx.req2}/requester`, {
      enterprise: '集团总部', department: '销售运营部', name: '林知远', level: '中层', position: '产品经理'
    })
    eq(r.requester.enterprise, '集团总部', '提出企业')
    eq(r.requester.level, 'middle', '级别应按字典归一')
    eq(r.requester.levelText, '中层', '级别文案')
    eq(r.requester.issues.length, 0, '提出方信息应完整')
    const detail = await ok('U-pm', 'GET', `/api/requirements/${ctx.req2}`)
    eq(detail.requester.department, '销售运营部', '详情应返回提出部门')
  })

  console.log('\n[requirement-confirmation]')
  await test('requirement-confirmation', '确认清单校验、事务内编号与不可变快照', async () => {
    await fails('U-pm', 'POST', `/api/requirements/${ctx.req2}/confirm`, 400)
    const r = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/confirm`, {})
    eq(r.code, `REQ-${(await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}`)).code}-0001`, '编号应按项目代号与流水生成')
    ctx.code = r.code
    const detail = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)
    eq(detail.status, '待需求分析', '确认后状态')
    eq(detail.snapshot.clarification.roles.value, '客户经理提出，运营专员处理', '快照应固化澄清结论')
    eq(detail.snapshot.requester.enterprise, '集团总部', '快照应固化提出企业与部门')
    eq(detail.snapshot.requester.department, '销售运营部', '快照应固化提出部门')
    assert(detail.priority?.score != null, '确认时应按百分制生成优先级')
    await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/confirm`, 400)
  })

  await test('requirement-confirmation', '待澄清与已确认分别计入不同统计口径', async () => {
    const o = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/overview`)
    assert(o.totals.inbox >= 1, '待澄清箱应包含未确认需求')
    assert(o.totals.pool >= 1, '需求池应包含已确认需求')
    const summary = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/summary`)
    assert(summary.lines.some(l => l.includes('需求调研中')), '摘要应标注需求调研中口径')
  })

  console.log('\n[requirement-analysis]')
  await test('requirement-analysis', '超出系统范围的分析被一致性校验拦截', async () => {
    const bad = analysisPayload()
    bad.integration.apps.push({ name: '外部财务系统', kind: 'internal' })
    const r = await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/analysis`, 400, { analysis: bad, submit: true })
    assert(JSON.stringify(r).includes('超出项目系统范围'), '应提示范围越界')
  })

  await test('requirement-analysis', '结构化分析缺项被质量门禁拦截且不写入版本', async () => {
    const bad = {
      description: { background: '', goal: '', roles: [], value: '' },
      process: { summary: '', steps: [] },
      functions: { architecture: [], list: [], flow: [], support: [] },
      integration: { apps: [], points: [] },
      acceptance: { steps: [], overall: '', metrics: [] },
      meta: {}
    }
    const r = await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/analysis`, 400, { analysis: bad, submit: true })
    assert(Array.isArray(r.details) && r.details.length >= 1, '应返回质量门禁问题清单')
    const versions = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}/versions`)
    eq(versions.length, 0, '未通过门禁的分析不应写入版本')
  })

  await test('requirement-analysis', '有效分析提交后生成版本并推进状态', async () => {
    const r = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/analysis`, { analysis: analysisPayload(), submit: true })
    assert(r.version >= 1, '应生成分析版本')
    ctx.analysisVersion = r.version
    const saved = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}/analysis`)
    assert(saved.check.ok, `分析校验应通过：${JSON.stringify(saved.check.issues)}`)
    const detail = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)
    eq(detail.status, '需求分析中', '提交分析后应进入需求分析中')
    const versions = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}/versions`)
    assert(versions.length >= 1, '版本列表应可查')
  })

  console.log('\n[prototype-workbench]')
  await test('prototype-workbench', '未经分析不能生成原型', async () => {
    await fails('U-pm', 'POST', `/api/requirements/${ctx.req2}/prototypes/generate`, 400)
  })

  await test('prototype-workbench', '生成原型覆盖页面与状态并可确认', async () => {
    const p = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/prototypes/generate`)
    ctx.proto1 = p
    assert(p.pages.length >= 2, '应生成概览页与功能页')
    assert(p.pages.every(x => (x.states || []).length), '每页应覆盖状态')
    await ok('U-pm', 'POST', `/api/prototypes/${p.id}/confirm`)
    const detail = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)
    eq(detail.status, '需求分析中', '原型属于需求分析阶段，不单独变更状态')
  })

  await test('prototype-workbench', '自然语言改稿生成新版本并同步分析', async () => {
    const r = await ok('U-pm', 'POST', `/api/prototypes/${ctx.proto1.id}/revise`, { instruction: '新增页面「明细页」' })
    assert(r.version === ctx.proto1.version + 1, '改稿应递增版本')
    assert(r.changes.length >= 1, '应返回改动说明')
    assert(r.analysisVersion > ctx.analysisVersion, '改稿应同步分析版本')
    ctx.proto2 = r
    await ok('U-pm', 'POST', `/api/prototypes/${r.id}/confirm`)
    const cmp = await ok('U-pm', 'GET', `/api/prototypes/${r.id}/compare?from=${ctx.proto1.version}`)
    assert(cmp.added.length >= 1, '版本对比应识别新增页面')
  })

  console.log('\n[specification-publishing]')
  await test('specification-publishing', '原型未确认时不能写入说明书', async () => {
    await fails('U-pm', 'POST', `/api/requirements/${ctx.req2}/specs/generate`, 400)
  })

  await test('specification-publishing', '说明书生成、发布与版本互锁', async () => {
    const s = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/specs/generate`)
    ctx.spec1 = s
    eq(s.skill?.slug, 'prd-assemble', '说明书应记录生成技能')
    await ok('U-pm', 'POST', `/api/specs/${s.id}/publish`)
    const detail = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)
    eq(detail.status, '需求评审中', '发布说明书后应进入需求评审中')
    const preview = await api('U-pm', 'GET', `/api/specs/${s.id}/preview`)
    assert(preview.status === 200 && preview.text.includes('需求分析说明书'), '自包含 HTML 预览应可访问')
    for (const id of ['overview', 'need', 'functions', 'integration', 'approval', 'appendix-a', 'appendix-o', 'appendix-q']) {
      assert(preview.text.includes(`id="${id}"`), `说明书应包含章节 ${id}`)
    }
    const body = preview.text.split('id="appendix-a"')[0]
    assert(!body.includes(ctx.code), '需求编号不得出现在正文与附录之前的叙述中')
    const docx = await fetch(`http://127.0.0.1:${PORT}/api/specs/${s.id}/docx`, { headers: { Cookie: cookies['U-pm'] } })
    const buf = Buffer.from(await docx.arrayBuffer())
    assert(docx.status === 200 && buf.subarray(0, 2).toString() === 'PK' && buf.length > 5000, 'Word 导出应为有效 docx')
    const specs = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}/specs`)
    const row = specs.find(x => x.id === s.id)
    eq(row.skill?.slug, 'prd-assemble', '说明书列表应带技能信息')
    eq(row.legacy, false, '新生成的说明书不应标记为旧版渲染')
  })

  await test('specification-publishing', '需求清单 Excel 导出与导出记录', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/projects/${ctx.projectId}/requirements-export.xlsx`, { headers: { Cookie: cookies['U-pm'] } })
    const buf = Buffer.from(await r.arrayBuffer())
    assert(r.status === 200 && buf.subarray(0, 2).toString() === 'PK' && buf.length > 3000, 'Excel 导出应为有效 xlsx')
    const exports = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/exports`)
    assert(exports.some(e => e.type === 'requirements' && e.format === 'xlsx'), '导出记录应留痕')
  })

  console.log('\n[requirement-review]')
  await test('requirement-review', '评审人不足两人或未发布说明书时拒绝发起', async () => {
    await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/reviews`, 400, { reviewerIds: ['U-r1'] })
    await fails('U-pm', 'POST', `/api/requirements/${ctx.req2}/reviews`, 400, { reviewerIds: ['U-r1', 'U-r2'] })
  })

  await test('requirement-review', '批注归并为建议且未闭环不能通过', async () => {
    const rv = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/reviews`, { reviewerIds: ['U-r1', 'U-r2'], deadline: '2026-11-20' })
    ctx.reviewId = rv.id
    const ann = await ok('U-r1', 'POST', `/api/reviews/${rv.id}/annotations`, {
      section: '功能设计', quote: '客户检索', content: '检索结果需要支持导出，便于线下核对。'
    })
    ctx.suggestionId = ann.suggestionId
    const sug = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/suggestions`)
    assert(sug.some(s => s.id === ctx.suggestionId), '批注应归并为建议')
    await fails('U-pm', 'POST', `/api/reviews/${rv.id}/conclude`, 400, { conclusion: '通过' })
  })

  await test('requirement-review', '建议关闭必须关联更新后的说明书且差异非空', async () => {
    await fails('U-pm', 'POST', `/api/suggestions/${ctx.suggestionId}/close`, 400, { version: ctx.spec1.version })
    const revised = analysisPayload()
    revised.description.goal = '在一个页面统一查看客户与订单，并支持按名称检索与结果导出。'
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/analysis`, { analysis: revised, submit: true, note: '补充导出目标' })
    const spec2 = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/specs/generate`)
    assert(spec2.version > ctx.spec1.version, '应生成更新的说明书版本')
    const s2 = await ok('U-pm', 'GET', `/api/specs/${spec2.id}`)
    const s1 = await ok('U-pm', 'GET', `/api/specs/${ctx.spec1.id}`)
    assert(s2.markdown !== s1.markdown, '新版本说明书内容应发生实际变化')
    await ok('U-pm', 'POST', `/api/specs/${spec2.id}/publish`)
    ctx.spec2 = spec2
    const r = await ok('U-pm', 'POST', `/api/suggestions/${ctx.suggestionId}/close`, { version: spec2.version, note: '已在明细页补充导出' })
    eq(r.version, spec2.version, '建议应关联新版本说明书')
  })

  await test('requirement-review', '建议闭环后评审通过并进入待开发', async () => {
    await ok('U-pm', 'POST', `/api/reviews/${ctx.reviewId}/conclude`, { conclusion: '通过', summary: '建议已闭环' })
    const after = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)
    eq(after.status, '待开发', '评审闭环并通过后应进入待开发')
    assert(after.milestones.reviewedAt, '评审通过应回填评审完成时间')
  })

  console.log('\n[change-control]')
  await test('change-control', '一般变更直接待应用并可落地', async () => {
    const c = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/changes`, { reason: '提示文案调整', content: '调整检索页提示文案' })
    eq(c.grade, '一般', '文案变更分级')
    eq(c.status, '待应用', '一般变更状态')
    await ok('U-pm', 'POST', `/api/changes/${c.id}/apply`)
    ctx.changeMinor = c
  })

  await test('change-control', '重大变更禁止直接应用并派生新需求', async () => {
    const c = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/changes`, {
      reason: '验收口径调整', content: '验收口径调整为按门店维度核对'
    })
    eq(c.grade, '重大', '触及验收口径应判重大')
    await fails('U-pm', 'POST', `/api/changes/${c.id}/apply`, 400)
    await ok('U-pm', 'POST', `/api/changes/${c.id}/resolve`, { handling: '重新登记' })
    const inbox = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/requirements?inbox=1`)
    const derived = inbox.find(x => x.title.includes('变更派生'))
    assert(derived, '应派生出新的待澄清需求')
    ctx.derivedId = derived.id
  })

  await test('change-control', '分级只能上调，下调需管理员豁免', async () => {
    const c = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/changes`, { reason: '说明补充', content: '补充检索说明' })
    const up = await ok('U-pm', 'POST', `/api/changes/${c.id}/grade`, { grade: '中等' })
    eq(up.grade, '中等', '允许上调')
    await fails('U-pm', 'POST', `/api/changes/${c.id}/grade`, 403, { grade: '一般' })
    const down = await ok('U-admin', 'POST', `/api/changes/${c.id}/grade`, { grade: '一般', exemption: '测试豁免说明' })
    eq(down.grade, '一般', '管理员可豁免下调')
  })

  console.log('\n[requirement-tracking]')
  await test('requirement-tracking', '事件时间线覆盖登记到变更', async () => {
    const tl = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}/timeline`)
    const types = new Set(tl.map(x => x.type))
    for (const t of ['intake', 'clarify', 'confirm', 'analysis', 'prototype', 'spec', 'review', 'change']) {
      assert(types.has(t), `时间线缺少 ${t} 事件`)
    }
  })

  await test('requirement-tracking', '挂起需原因，恢复回原状态', async () => {
    await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, 400, { to: '挂起' })
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, { to: '挂起', note: '等待数据源确认' })
    eq((await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)).status, '挂起', '应处于挂起')
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, { to: '恢复' })
    eq((await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)).status, '待开发', '应恢复为挂起前状态')
  })

  await test('requirement-tracking', '待办聚合、风险与通知', async () => {
    const todos = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/todos`)
    assert(Array.isArray(todos.tasks), '待办应返回任务列表')
    const risks = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/risks`)
    assert(Array.isArray(risks), '风险应为列表')
    const n = await ok('U-r1', 'GET', '/api/notifications')
    assert(n.items.length >= 1, '评审人应收到站内通知')
    await ok('U-r1', 'POST', '/api/notifications/read')
    eq((await ok('U-r1', 'GET', '/api/notifications')).unread, 0, '标记已读后未读数应为 0')
  })

  console.log('\n[priority-scoring]')
  await test('priority-scoring', '七维百分制评分、等级映射与 AI 依据', async () => {
    const model = await ok('U-pm', 'GET', '/api/priorities/model')
    eq(model.dimensions.length, 7, '模型应包含七个维度')
    eq(model.levels.P0, 'P0-极高', '等级字典')
    const p = await ok('U-pm', 'PUT', `/api/requirements/${ctx.req1}/priority`, {
      values: { closure: 'block', breadth: 'all', level: 'high', business: 'high', efficiency: 'high', cost: 'high', roi: 'good' },
      evidence: { closure: '缺少该能力订单流程无法闭环' },
      estimateDays: 6
    })
    eq(p.model, 'priority-100-v1', '模型版本')
    eq(p.score, 110, '百分制总分')
    eq(p.grade, 'P0', '高分应判 P0')
    eq(p.dimensions.length, 7, '应保留逐项评分')
    assert(p.aiDiff?.closure?.ai, '应保留 AI 候选差异')
    assert(p.dimensions.find(d => d.key === 'closure').evidence.includes('无法闭环'), '应保留评分依据')
  })

  await test('priority-scoring', '人工调整必须填写理由并保留建议等级', async () => {
    const low = { closure: 'enhance', breadth: 'role', level: 'basic', business: 'low', efficiency: 'none', cost: 'none', roi: 'bad' }
    await fails('U-pm', 'PUT', `/api/requirements/${ctx.derivedId}/priority`, 400, {
      values: low, grade: 'P2', estimateDays: 4
    })
    const manual = await ok('U-pm', 'PUT', `/api/requirements/${ctx.derivedId}/priority`, {
      values: low, grade: 'P1', reason: '战略需要', estimateDays: 4
    })
    eq(manual.grade, 'P1', '人工调整优先级')
    assert(manual.manual, '应标记为人工调整')
    eq(manual.suggestedGrade, 'P3', '应保留规则建议等级')
    eq(manual.reason, '战略需要', '应保留调整理由')
  })

  console.log('\n[milestone-governance]')
  await test('milestone-governance', '保留状态不可直接进入、里程碑顺序与逾期提醒', async () => {
    const reserved = await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, 400, { to: '待需求分析' })
    assert(reserved.error.includes('确认、丢弃或登记'), '保留状态应提示由确认动作产生')
    await fails('U-pm', 'PATCH', `/api/requirements/${ctx.req1}/milestones`, 400, {
      reviewedAt: '2026-11-03T09:00:00', submittedAt: '2026-11-01T09:00:00'
    })
    const r = await ok('U-pm', 'PATCH', `/api/requirements/${ctx.req1}/milestones`, {
      productManager: '林知远',
      reviewedAt: '2026-10-29T09:00:00',
      submittedAt: '2026-11-01T09:00:00',
      plan: { testedAt: '2026-10-30T09:00:00' }
    })
    eq(r.milestones.productManager, '林知远', '产品经理应落库')
    assert(r.milestones.overdue.some(o => o.field === 'testedAt'), '计划已过且未完成应标记逾期')
    const detail = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)
    eq(detail.milestones.fields.length, 6, '应返回六个完成时间里程碑')
  })

  console.log('\n[batch-update]')
  await test('batch-update', '批量更新部分成功并记录批次与逐项审计', async () => {
    await fails('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/batch-status`, 400, {
      requirementIds: [ctx.req1], to: '待UAT', effectiveAt: '2099-01-01T00:00:00Z'
    })
    await fails('U-r1', 'POST', `/api/projects/${ctx.projectId}/requirements/batch-status`, 403, {
      requirementIds: [ctx.req1], to: '开发中'
    })
    await ok('U-pm', 'PATCH', `/api/requirements/${ctx.req1}/profile`, { leads: { tech: '技术负责人甲' } })
    const r = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/batch-status`, {
      requirementIds: [ctx.req1, ctx.req2], to: '开发中', note: '统一进入开发'
    })
    assert(r.batchId, '应返回批次号')
    eq(r.success.length, 1, '仅满足门禁的需求成功')
    eq(r.failed.length, 1, '不满足门禁的需求失败')
    assert(r.failed[0].reason, '失败项应给出原因')
    ctx.batchId = r.batchId
    eq((await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)).status, '开发中', '成功项状态应生效')
    const history = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/tracking/batches`)
    assert(history.some(b => b.id === r.batchId && b.target_status === '开发中' && b.kind === 'status'), '批次记录应可追溯')
  })

  await test('batch-update', '批量进展维护预检、部分成功与进展批次留痕', async () => {
    const payload = { requirementIds: [ctx.req1, ctx.req2], milestones: { submittedAt: '2026-10-01T09:00:00' } }
    const preview = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/batch-progress/preview`, payload)
    eq(preview.total, 2, '预检应覆盖两条需求')
    eq(preview.ok, 1, '预检应识别一条可更新')
    eq(preview.failed, 1, '预检应识别一条冲突')
    const r = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/batch-progress`, payload)
    eq(r.success.length, 1, '进展维护应部分成功')
    eq(r.failed.length, 1, '冲突项应失败并给出原因')
    assert(r.failed[0].reason.includes('不能早于'), '失败原因应说明里程碑顺序冲突')
    const history = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/tracking/batches`)
    const batch = history.find(b => b.id === r.batchId)
    assert(batch && batch.kind === 'progress', '进展批次应标记 kind=progress')
    assert(batch.changes_json.includes('submittedAt'), '批次应记录目标字段与值')
    await fails('U-dev', 'POST', `/api/projects/${ctx.projectId}/requirements/batch-progress`, 403, {
      requirementIds: [ctx.req1], to: '待试点'
    })
  })

  await test('batch-update', '批量更新按迭代范围与空范围拦截', async () => {
    await fails('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/batch-status`, 400, {
      iterationId: ctx.iteration.id, to: '开发中'
    })
    await fails('U-pm', 'POST', `/api/projects/${ctx.projectId}/requirements/batch-status`, 400, {
      requirementIds: ['REQ-not-exists'], to: '开发中'
    })
  })

  await test('milestone-governance', '负责人门禁拦截并自动回填六个完成时间', async () => {
    const noTestLead = await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, 400, { to: '待测试验证' })
    assert(JSON.stringify(noTestLead).includes('测试负责人'), '缺少测试负责人不能进入待测试验证')
    await ok('U-pm', 'PATCH', `/api/requirements/${ctx.req1}/profile`, { leads: { test: '测试负责人乙' } })
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, { to: '待测试验证' })
    const submitted = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)
    eq(submitted.status, '待测试验证', '应进入待测试验证')
    assert(submitted.milestones.submittedAt, '进入待测试验证应回填开发完成时间')

    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, { to: '测试验证中' })
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, { to: '待UAT' })
    const tested = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)
    assert(tested.milestones.testedAt, '进入待UAT应回填测试完成时间')

    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, { to: 'UAT中' })
    const noImpl = await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, 400, { to: '待试点' })
    assert(JSON.stringify(noImpl).includes('实施负责人'), '缺少实施负责人不能进入待试点')
    await ok('U-pm', 'PATCH', `/api/requirements/${ctx.req1}/profile`, { leads: { implementation: '实施负责人丙' } })
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, { to: '待试点' })
    const uat = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)
    assert(uat.milestones.uatAt, '进入待试点应回填 UAT 完成时间')

    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, { to: '试点中' })
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, { to: '待上线发版' })
    const pilot = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)
    assert(pilot.milestones.pilotAt, '进入待上线发版应回填试点完成时间')

    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, { to: '全国推广中' })
    const released = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)
    assert(released.milestones.releasedAt, '进入全国推广中应回填上线推广时间')
    eq(released.milestones.fields.length, 6, '应返回六个完成时间里程碑')
  })

  console.log('\n[tracking-session]')
  await test('tracking-session', '会话只查询与生成提案，确认后才写入', async () => {
    const chat = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/tracking-chat`)
    assert(Array.isArray(chat.messages), '应返回会话消息')
    const q = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/tracking-chat`, { message: '当前项目有哪些风险和阻塞' })
    assert(q.reply.includes('需求'), '应返回统计摘要')
    eq(q.proposal, null, '查询不应生成写提案')

    const up = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/tracking-chat`, { message: '把需求状态统一改为挂起' })
    assert(up.proposal?.id, '应生成待确认提案')
    eq(up.proposal.payload.to, '挂起', '提案目标状态')
    assert(up.proposal.diff.length >= 1, '提案应包含逐项预检')
    eq((await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)).status, '全国推广中', '提案未确认前不写入')
    await fails('U-r1', 'POST', `/api/project-proposals/${up.proposal.id}/apply`, 403)
    const applied = await ok('U-pm', 'POST', `/api/project-proposals/${up.proposal.id}/apply`)
    eq(applied.result.success.length, 1, '确认后执行提案')
    eq((await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)).status, '挂起', '提案确认后状态生效')
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/status`, { to: '恢复' })
    eq((await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}`)).status, '全国推广中', '恢复回原状态')

    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/schedule`, { iterationId: ctx.iteration.id })
    const scoped = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/tracking-chat`, { message: '把迭代 A 中全国推广中的需求统一改为挂起' })
    eq(scoped.proposal.payload.iterationName, '迭代 A', '应识别会话中的迭代范围')
    eq(scoped.proposal.payload.from, '全国推广中', '应识别来源状态过滤')
    eq(scoped.proposal.diff.length, 1, '仅覆盖迭代内符合来源状态的需求')
    await ok('U-pm', 'POST', `/api/project-proposals/${scoped.proposal.id}/discard`)
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/schedule`, { iterationId: null })
  })

  console.log('\n[iteration-detail]')
  await test('iteration-detail', '迭代详情聚合需求、覆盖、里程碑与权限', async () => {
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/schedule`, { iterationId: ctx.iteration.id })
    const d = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/iterations/${ctx.iteration.id}`)
    eq(d.iteration.id, ctx.iteration.id, '迭代标识')
    eq(d.iteration.requirementCount, 1, '关联需求数')
    assert(d.iteration.usedDays > 0 && d.iteration.utilization != null, '应计算容量占用')
    eq(d.requirements.length, 1, '需求明细')
    eq(d.requirements[0].productManager, '林知远', '需求应带产品经理')
    eq(d.requirements[0].milestones.fields.length, 6, '应返回六个完成时间里程碑')
    assert(d.coverage.analysis.done === 1 && d.coverage.prototype.done === 1 && d.coverage.spec.done === 1, '产物覆盖应完整')
    assert(d.permissions.canBatch && d.permissions.canGenerateSpec, '产品经理应可批量更新与生成说明书')
    assert(Array.isArray(d.statusDistribution) && Array.isArray(d.blockers), '应返回状态分布与阻塞项')
    const guest = await ok('U-guest', 'GET', `/api/projects/${ctx.projectId}/iterations/${ctx.iteration.id}`)
    assert(guest.permissions.canBatch === false, '访客不可批量更新')
  })

  console.log('\n[requirement-detail]')
  await test('requirement-detail', '维护需求说明、应用功能点与负责人并校验', async () => {
    const apps = [
      { name: '客户中心', functions: [{ name: '客户检索', description: '按名称检索客户' }, { name: '客户详情', description: '' }] },
      { name: '销售管理', functions: [{ name: '订单查询', description: '查看客户订单' }] }
    ]
    const r = await ok('U-pm', 'PATCH', `/api/requirements/${ctx.req1}/profile`, {
      description: '客户与订单统一检索，减少线下核对。',
      apps,
      leads: { tech: '技术负责人甲', test: '测试负责人乙', implementation: '实施负责人丙' }
    })
    eq(r.description, '客户与订单统一检索，减少线下核对。', '需求说明应可维护')
    eq(r.involvedApps.length, 2, '应保存两个关联应用')
    const client = r.involvedApps.find(a => a.name === '客户中心')
    eq(client.functions.length, 2, '应保存应用功能点')
    const fnId = client.functions[0].id
    assert(/^FN-[0-9a-f]{10}$/.test(fnId), '功能点应生成稳定标识')
    const again = await ok('U-pm', 'PATCH', `/api/requirements/${ctx.req1}/profile`, {
      apps: [{ name: '客户中心', functions: [{ name: '客户检索', description: '更新说明' }] }]
    })
    eq(again.involvedApps[0].functions[0].id, fnId, '同名功能点应沿用标识')
    await fails('U-pm', 'PATCH', `/api/requirements/${ctx.req1}/profile`, 400, {
      apps: [{ name: '客户中心', functions: [{ name: '客户检索' }, { name: '客户检索' }] }]
    })
    await fails('U-pm', 'PATCH', `/api/requirements/${ctx.req1}/profile`, 400, {
      apps: [{ name: '外部财务系统' }]
    })
    await fails('U-pm', 'PATCH', `/api/requirements/${ctx.req1}/profile`, 400, {
      leads: { tech: '技术负责人姓名超过二十个字符的非法输入示例' }
    })
    await fails('U-r1', 'PATCH', `/api/requirements/${ctx.req1}/profile`, 403, { description: '越权修改' })
    const restored = await ok('U-pm', 'PATCH', `/api/requirements/${ctx.req1}/profile`, {
      apps: [
        { name: '客户中心', functions: [{ name: '客户检索', description: '按名称检索客户' }, { name: '客户详情', description: '' }] },
        { name: '销售管理', functions: [{ name: '订单查询', description: '查看客户订单' }] }
      ]
    })
    eq(restored.involvedApps[1].functions[0].name, '订单查询', '应恢复完整功能点')
  })

  await test('requirement-detail', '详情聚合基本信息、过程文档与进展', async () => {
    const d = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}/detail`)
    eq(d.basic.code, ctx.code, '应返回需求编号')
    eq(d.basic.status, '全国推广中', '应返回当前状态')
    assert(d.basic.submittedBy && d.basic.submittedAt, '应返回提交人与提交时间')
    eq(d.basic.apps.length, 2, '应返回关联应用')
    assert(d.basic.apps.every(a => a.functions.length >= 1), '关联应用应带功能点')
    eq(d.basic.leads.productManager, '林知远', '应返回产品经理')
    assert(d.basic.leads.tech && d.basic.leads.test && d.basic.leads.implementation, '应返回三个负责人')
    assert(d.docs.flowcharts.length >= 1, '应聚合流程图')
    assert(d.docs.prototypes.length >= 2, '应聚合原型版本')
    assert(d.docs.specs.length >= 2, '应聚合说明书版本')
    assert(d.docs.outputs.some(o => o.formats.some(f => f.format === 'docx')), '输出物应含 Word 下载')
    eq(d.progress.steps.length, 14, '应返回 14 个阶段')
    eq(d.progress.steps.find(s => s.current)?.name, '全国推广中', '当前阶段应标记')
    assert(d.progress.events.length >= 5, '应返回事件时间线')
    assert(d.progress.batches.length >= 2, '应返回批次记录')
    assert(d.progress.transitions.some(t => t.status === '已关闭'), '应返回可推进状态')
    assert(d.permissions.advanceStatus && d.permissions.editMilestones && d.permissions.enterWorkbench, '产品经理应有维护权限')
  })

  await test('requirement-detail', '空产物详情与访客过滤', async () => {
    const empty = await ok('U-pm', 'GET', `/api/requirements/${ctx.req2}/detail`)
    eq(empty.docs.flowcharts.length, 0, '无分析版本时流程图应为空')
    eq(empty.docs.prototypes.length, 0, '无原型时原型应为空')
    eq(empty.docs.specs.length, 0, '无说明书时说明书应为空')
    eq(empty.docs.outputs.length, 0, '无输出物时输出物应为空')
    const guest = await ok('U-guest', 'GET', `/api/requirements/${ctx.req1}/detail`)
    eq(guest.docs.flowcharts.length, 0, '访客不应看到流程图')
    assert(guest.docs.prototypes.every(p => p.status === 'confirmed'), '访客只应看到已确认原型')
    assert(guest.docs.specs.every(s => s.status === 'published'), '访客只应看到已发布说明书')
    eq(guest.permissions.guest, true, '应标记访客身份')
    eq(guest.permissions.editDescription, false, '访客不可编辑需求说明')
    eq(guest.permissions.advanceStatus, false, '访客不可推进状态')
    await fails('U-pm2', 'GET', `/api/requirements/${ctx.req1}/detail`, 403)
  })

  await test('requirement-detail', '流程图预览自包含、转义内容并拒绝缺失版本', async () => {
    const d = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}/detail`)
    const chart = d.docs.flowcharts[0]
    assert(chart && chart.steps >= 1, '流程图应包含步骤')
    eq(chart.renderer, 'archify', '默认绑定下应使用 archify 渲染器')
    eq(chart.rendererText, '交互图', '应返回渲染器中文名')
    eq(chart.skill?.slug, 'archify', '应记录生成技能')
    assert(chart.analysisVersionRowId, '应暴露分析版本行 id')
    eq(chart.backfilled, false, '新保存的分析不应标记为历史补登记')
    const res = await api('U-pm', 'GET', chart.previewUrl)
    eq(res.status, 200, '流程图预览应可访问')
    assert(res.headers.get('content-security-policy').includes("default-src 'none'"), '应声明严格 CSP')
    assert(res.text.includes('客户检索页'), '应渲染流程节点')
    assert(res.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '应转义脚本内容')
    assert(!res.text.includes('<script>alert(1)</script>'), '不得输出未转义脚本')
    assert(!/https?:\/\//.test(res.text.replace(/https?:\/\/www\.w3\.org/g, '')), '不得引用外部资源')
    await fails('U-pm', 'GET', `/api/requirements/${ctx.req1}/flowcharts/RV-not-exists/preview`, 404)
    const db = new DatabaseSync(dbFile)
    db.prepare(`INSERT INTO requirement_versions (id, requirement_id, version, analysis_json, note, created_by, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run('RV-empty-flow', ctx.req2, 1, JSON.stringify({ functions: { flow: [] } }), '空流程', 'U-pm', new Date().toISOString())
    db.close()
    await fails('U-pm', 'GET', `/api/requirements/${ctx.req2}/flowcharts/RV-empty-flow/preview`, 404)
  })

  await test('requirement-detail', '流程图重新生成走技能链路，历史版本自动补登记', async () => {
    const d = await ok('U-pm', 'GET', `/api/requirements/${ctx.req1}/detail`)
    const chart = d.docs.flowcharts[0]
    await fails('U-guest', 'POST', `/api/requirements/${ctx.req1}/analysis/${chart.analysisVersionRowId}/flowchart/regenerate`, 403)
    const r = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/analysis/${chart.analysisVersionRowId}/flowchart/regenerate`, {})
    eq(r.renderer, 'archify', '重新生成应走 archify 技能链路')
    eq(r.skill?.slug, 'archify', '应返回技能信息')
    eq(r.fallback, null, '默认绑定下不应降级')
    const db = new DatabaseSync(dbFile)
    db.prepare(`INSERT INTO requirement_versions (id, requirement_id, version, analysis_json, note, created_by, created_at)
      VALUES (?,?,?,?,?,?,?)`)
      .run('RV-backfill', ctx.req2, 2, JSON.stringify({ functions: { flow: [{ from: '开始', action: '提交申请', to: '结束' }] } }), '历史版本', 'U-pm', new Date().toISOString())
    db.close()
    const after = await ok('U-pm', 'GET', `/api/requirements/${ctx.req2}/detail`)
    eq(after.docs.flowcharts.length, 1, '历史分析版本应补登记流程图')
    const backfilled = after.docs.flowcharts[0]
    eq(backfilled.renderer, 'builtin', '补登记应使用内置渲染器')
    eq(backfilled.rendererText, '步骤清单', '补登记渲染器中文名')
    eq(backfilled.skill, null, '补登记不关联技能')
    eq(backfilled.backfilled, true, '应标记为历史补登记')
    const res = await api('U-pm', 'GET', backfilled.previewUrl)
    eq(res.status, 200, '补登记流程图应可预览')
    assert(res.text.includes('提交申请'), '应渲染历史流程步骤')
  })

  console.log('\n[knowledge-base]')
  await test('knowledge-base', '按类别聚合产物并返回统计、元数据与分页', async () => {
    const all = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/knowledge`)
    assert(all.total >= 4, '知识库应聚合项目产物')
    assert(all.counts.flowchart >= 1 && all.counts.prototype >= 2 && all.counts.spec >= 1, '三类产物均应有条目')
    eq(all.counts.all, all.total, '合计应与条目总数一致')
    const reqItem = all.items.find(i => i.requirement?.id === ctx.req1)
    assert(reqItem?.requirement.id, '条目应关联需求')
    assert(reqItem.iteration?.name, '条目应关联迭代')
    assert(reqItem.createdAt && reqItem.updatedAt, '条目应带创建与更新时间')
    assert(reqItem.previewUrl, '条目应带预览地址')
    const onlyProto = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/knowledge?category=prototype`)
    assert(onlyProto.items.every(i => i.category === 'prototype'), '类别过滤应只返回原型')
    eq(onlyProto.total, all.counts.prototype, '类别总数应与统计一致')
    const paged = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/knowledge?page=1&pageSize=2`)
    eq(paged.pageSize, 2, '分页大小应生效')
    assert(paged.items.length <= 2, '单页不应超过分页大小')
    const searched = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/knowledge?q=${encodeURIComponent(ctx.code)}`)
    assert(searched.items.every(i => i.requirement?.code === ctx.code), '关键字应命中需求编号')
    const meta = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/knowledge/meta`)
    assert(meta.iterations.some(i => i.id === ctx.iteration.id), '元数据应包含迭代')
    assert(meta.productManagers.includes('林知远'), '元数据应包含产品经理')
  })

  await test('knowledge-base', '访客知识库过滤草稿与流程图', async () => {
    const guest = await ok('U-guest', 'GET', `/api/projects/${ctx.projectId}/knowledge`)
    assert(guest.items.every(i => i.category !== 'flowchart'), '访客不应看到流程图')
    assert(guest.items.every(i => i.kind !== 'prototype' || i.status === 'confirmed'), '访客只看已确认原型')
    assert(guest.items.every(i => i.kind !== 'spec' || i.status !== 'draft'), '访客不看说明书草稿')
    await fails('U-pm2', 'GET', `/api/projects/${ctx.projectId}/knowledge`, 403)
  })

  await test('knowledge-base', '知识库产物可直接预览', async () => {
    const all = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/knowledge?pageSize=100`)
    const spec = all.items.find(i => i.kind === 'spec' && i.previewUrl)
    const proto = all.items.find(i => i.kind === 'prototype' && i.previewUrl)
    const overview = await api('U-pm', 'GET', spec.previewUrl)
    eq(overview.status, 200, '说明书预览应可访问')
    assert(overview.text.includes('需求分析说明书'), '预览应为自包含说明书')
    const page = await api('U-pm', 'GET', proto.previewUrl)
    eq(page.status, 200, '原型页面预览应可访问')
  })

  console.log('\n[iteration-spec]')
  await test('iteration-spec', '草稿版允许缺项，正式版需全部齐备且版本递增', async () => {
    const draft = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/iterations/${ctx.iteration.id}/specs/generate`, { mode: 'draft' })
    eq(draft.status, 'draft', '草稿版状态')
    eq(draft.requirementCount, 1, '纳入需求数')
    ctx.iterationSpec = draft
    const formal = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/iterations/${ctx.iteration.id}/specs/generate`, { mode: 'formal' })
    eq(formal.status, 'published', '正式版应发布')
    eq(formal.version, draft.version + 1, '版本应递增')
    ctx.iterationSpecFormal = formal
    const list = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/iterations/${ctx.iteration.id}/specs`)
    assert(list.length >= 2, '应保留版本系列')
  })

  await test('iteration-spec', '自包含 HTML 预览、锚点与多格式导出', async () => {
    const draftPreview = await api('U-pm', 'GET', `/api/iteration-specs/${ctx.iterationSpec.id}/preview`)
    eq(draftPreview.status, 200, '草稿预览应可访问')
    assert(draftPreview.text.includes('迭代需求分析说明书'), '预览应为说明书')
    assert(draftPreview.text.includes(`id="req-${ctx.req1}"`), '应包含需求锚点')
    assert(!/<(img|script|link)[^>]+(src|href)=["']https?:/i.test(draftPreview.text), '不应引用外部资源')
    const md = await fetch(`http://127.0.0.1:${PORT}/api/iteration-specs/${ctx.iterationSpec.id}/markdown`, { headers: { Cookie: cookies['U-pm'] } })
    const mdText = await md.text()
    assert(md.status === 200 && mdText.includes('迭代需求分析说明书'), 'Markdown 应可导出')
    const docx = await fetch(`http://127.0.0.1:${PORT}/api/iteration-specs/${ctx.iterationSpec.id}/docx`, { headers: { Cookie: cookies['U-pm'] } })
    const buf = Buffer.from(await docx.arrayBuffer())
    assert(docx.status === 200 && buf.subarray(0, 2).toString() === 'PK' && buf.length > 5000, 'Word 导出应为有效 docx')
    const pdf = await fetch(`http://127.0.0.1:${PORT}/api/iteration-specs/${ctx.iterationSpec.id}/pdf`, { headers: { Cookie: cookies['U-pm'] } })
    const pdfBuf = Buffer.from(await pdf.arrayBuffer())
    if (pdf.status === 200) {
      assert(pdfBuf.subarray(0, 4).toString() === '%PDF', 'PDF 导出应为有效文件')
    } else {
      assert([501, 502].includes(pdf.status) && pdfBuf.toString().includes('PDF'), 'PDF 导出失败应明示原因')
    }
    const guestDraft = await api('U-guest', 'GET', `/api/iteration-specs/${ctx.iterationSpec.id}/preview`)
    eq(guestDraft.status, 403, '访客不可查看草稿')
    const guestFormal = await api('U-guest', 'GET', `/api/iteration-specs/${ctx.iterationSpecFormal.id}/preview`)
    eq(guestFormal.status, 200, '访客可查看正式版')
  })

  await test('iteration-spec', '生成权限受控', async () => {
    await fails('U-dev', 'POST', `/api/projects/${ctx.projectId}/iterations/${ctx.iteration.id}/specs/generate`, 403, { mode: 'draft' })
    await fails('U-r1', 'POST', `/api/projects/${ctx.projectId}/iterations/${ctx.iteration.id}/specs/generate`, 403, { mode: 'draft' })
  })

  const specGenPath = () => `/api/projects/${ctx.projectId}/iterations/${ctx.iteration.id}/specs/generate`
  const specListPath = () => `/api/projects/${ctx.projectId}/iterations/${ctx.iteration.id}/specs`
  const skillPath = id => `/api/projects/${ctx.projectId}/skills/${id}`
  const specSkillPackage = (slug, template) => ({
    files: [{
      path: 'skill.json',
      base64: Buffer.from(JSON.stringify({
        slug, name: `说明书技能 ${slug}`, version: '1.0.0',
        description: '测试用说明书技能', stages: ['spec'], artifactTemplate: template
      })).toString('base64')
    }]
  })
  const CUSTOM_SPEC_TEMPLATE = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{{docTitle}}</title>'
    + '<style>body{font-family:sans-serif}</style></head><body><div class="custom-skin"><h1>{{docTitle}}</h1>'
    + '<p class="sub">{{docSubtitle}}</p><nav class="toc">{{toc}}</nav><main class="content">{{content}}</main>'
    + '<footer>{{footer}}</footer></div></body></html>'

  console.log('\n[skill-driven-spec]')
  await test('specification-publishing', '按技能生成说明书并留下技能与双产物记录', async () => {
    const skills = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/skills`)
    const specSkill = skills.skills.find(s => s.slug === 'prd-assemble')
    assert(specSkill?.enabled && specSkill.stages.includes('spec'), '项目应启用内置说明书技能')
    ctx.specSkill = specSkill
    const gen = await ok('U-pm', 'POST', specGenPath(), { mode: 'draft', skillBindingId: specSkill.id })
    eq(gen.skill.slug, 'prd-assemble', '应返回所用技能')
    eq(gen.skill.version, specSkill.version, '应返回技能版本')
    eq(gen.skillFallbackFrom, null, '显式选择不应标记回退')
    assert(gen.artifacts?.html === true && gen.artifacts.docx.size > 5000, '应同时产出 HTML 与 Word')
    assert(/^[0-9a-f]{64}$/.test(gen.artifacts.docx.sha256), '应返回 Word 摘要')

    const list = await ok('U-pm', 'GET', specListPath())
    const row = list.find(x => x.id === gen.id)
    eq(row.skill.slug, 'prd-assemble', '版本列表应返回技能标识')
    eq(row.docxSize, gen.artifacts.docx.size, '版本列表应返回 Word 大小')
    assert(row.html === undefined && row.docx_file === undefined, '版本列表不应返回文档内容')

    const detail = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/iterations/${ctx.iteration.id}`)
    eq(detail.specs.find(x => x.id === gen.id).skill.slug, 'prd-assemble', '迭代详情应返回技能标识')

    const db = new DatabaseSync(dbFile)
    const stored = db.prepare(`SELECT skill_binding_id, skill_slug, skill_version, template_hash, docx_file, docx_size, docx_sha256
      FROM iteration_specs WHERE id = ?`).get(gen.id)
    db.close()
    eq(stored.skill_binding_id, specSkill.id, '应记录技能绑定')
    eq(stored.skill_slug, 'prd-assemble', '应记录技能标识')
    eq(stored.skill_version, specSkill.version, '应记录技能版本')
    assert(/^[0-9a-f]{64}$/.test(stored.template_hash), '应记录模板摘要')
    eq(stored.docx_file, `${gen.id}.docx`, 'Word 应固化到文件存储')
    eq(stored.docx_size, gen.artifacts.docx.size, '应记录 Word 大小')
    eq(stored.docx_sha256, gen.artifacts.docx.sha256, '应记录 Word 摘要')

    const calls = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/llm-calls`)
    const call = calls.calls.find(c => c.skill_slug === 'prd-assemble' && c.stage === 'spec')
    assert(call && call.provider === 'skill-runtime' && call.trigger_type === 'document', '应记录文档技能执行')
    eq(call.prompt_tokens + call.completion_tokens + call.cost, 0, '确定性组装不应消耗令牌与费用')
  })

  await test('specification-publishing', '重新生成沿用上一版本技能，停用后回退内置技能', async () => {
    const custom = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/skills/import`,
      specSkillPackage('spec-custom-a', CUSTOM_SPEC_TEMPLATE))
    ctx.specCustom = custom
    const first = await ok('U-pm', 'POST', specGenPath(), { mode: 'draft', skillBindingId: custom.id })
    eq(first.skill.slug, 'spec-custom-a', '应使用显式选择的技能')
    const preview = await api('U-pm', 'GET', `/api/iteration-specs/${first.id}/preview`)
    assert(preview.status === 200 && preview.text.includes('custom-skin'), '应按技能模板渲染')

    const reused = await ok('U-pm', 'POST', specGenPath(), { mode: 'draft' })
    eq(reused.skill.slug, 'spec-custom-a', '未显式选择时应沿用上一版本技能')
    eq(reused.skillFallbackFrom, null, '沿用上一版本不应标记回退')

    await ok('U-pm', 'PATCH', skillPath(custom.id), { enabled: false })
    const fallback = await ok('U-pm', 'POST', specGenPath(), { mode: 'draft' })
    eq(fallback.skill.slug, 'prd-assemble', '上一版本技能不可用时应回退内置技能')
    eq(fallback.skillFallbackFrom?.slug, 'spec-custom-a', '应标记回退来源')
    const denied = await fails('U-pm', 'POST', specGenPath(), 403, { mode: 'draft', skillBindingId: custom.id })
    eq(denied.code, 'SPEC_SKILL_UNAVAILABLE', '显式指定停用技能应拒绝')
  })

  await test('specification-publishing', '模板契约与安全校验拒绝非法模板且不落库', async () => {
    const before = (await ok('U-pm', 'GET', specListPath())).length
    const cases = [
      ['spec-bad-missing', '<html><body><h1>{{docTitle}}</h1></body></html>', 'SPEC_TEMPLATE_INVALID'],
      ['spec-bad-unknown', '<html><body>{{content}}{{unknownSlot}}</body></html>', 'SPEC_TEMPLATE_INVALID'],
      ['spec-bad-script', '<html><body><script>alert(1)</script>{{content}}</body></html>', 'SPEC_TEMPLATE_UNSAFE'],
      ['spec-bad-external', '<html><body><img src="https://example.com/a.png">{{content}}</body></html>', 'SPEC_TEMPLATE_UNSAFE']
    ]
    for (const [slug, template, code] of cases) {
      const skill = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/skills/import`, specSkillPackage(slug, template))
      const r = await fails('U-pm', 'POST', specGenPath(), 400, { mode: 'draft', skillBindingId: skill.id })
      eq(r.code, code, `${slug} 应返回 ${code}`)
      await ok('U-pm', 'DELETE', skillPath(skill.id))
    }
    const after = (await ok('U-pm', 'GET', specListPath())).length
    eq(after, before, '非法模板不应创建版本')
    eq((await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/skills`)).skills
      .filter(s => s.slug.startsWith('spec-bad-')).length, 0, '非法模板技能应已清理')
  })

  await test('specification-publishing', '技能解析错误码与会话环节隔离', async () => {
    const analyze = (await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/skills`)).skills.find(s => s.slug === 'prd-analysis')
    const mismatch = await fails('U-pm', 'POST', specGenPath(), 400, { mode: 'draft', skillBindingId: analyze.id })
    eq(mismatch.code, 'SPEC_SKILL_STAGE_MISMATCH', '未声明说明书环节的技能应拒绝')

    const chat = await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/chat`, 400, { message: '生成说明书', stage: 'spec' })
    assert(chat.error.includes('不支持环节'), '会话应拒绝说明书环节')
    const run = await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/skills/${ctx.specSkill.id}/run`, 400, { stage: 'spec' })
    assert(run.error.includes('不支持环节'), '手动执行应拒绝说明书环节')

    const b = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/skills/import`, specSkillPackage('spec-custom-b', CUSTOM_SPEC_TEMPLATE))
    const c = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/skills/import`, specSkillPackage('spec-custom-c', CUSTOM_SPEC_TEMPLATE))
    await ok('U-pm', 'PATCH', skillPath(ctx.specSkill.id), { enabled: false })
    const multi = await fails('U-pm', 'POST', specGenPath(), 400, { mode: 'draft' })
    eq(multi.code, 'SPEC_SKILL_REQUIRED', '多个可用技能时应要求选择')
    eq(multi.details.candidates.length, 2, '应列出候选技能')

    await ok('U-pm', 'PATCH', skillPath(b.id), { enabled: false })
    await ok('U-pm', 'PATCH', skillPath(c.id), { enabled: false })
    const none = await fails('U-pm', 'POST', specGenPath(), 400, { mode: 'draft' })
    eq(none.code, 'SPEC_SKILL_REQUIRED', '没有可用技能时应阻断')
    eq(none.details.candidates.length, 0, '应给出空候选')

    await ok('U-pm', 'PATCH', skillPath(ctx.specSkill.id), { enabled: true })
    for (const s of [b, c, ctx.specCustom]) await ok('U-pm', 'DELETE', skillPath(s.id))
    const remaining = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/skills`)
    assert(remaining.skills.every(s => s.sourceType === 'builtin'), '测试结束应清理导入技能')
  })

  await test('specification-publishing', '预览安全响应头与 Word 固化/回退导出', async () => {
    const id = ctx.iterationSpec.id
    const preview = await api('U-pm', 'GET', `/api/iteration-specs/${id}/preview`)
    eq(preview.status, 200, '预览应可访问')
    eq(preview.headers.get('cache-control'), 'no-store', '预览应禁用缓存')
    eq(preview.headers.get('x-frame-options'), 'DENY', '预览应禁止嵌入')
    eq(preview.headers.get('x-content-type-options'), 'nosniff', '预览应禁用类型嗅探')
    const csp = preview.headers.get('content-security-policy') || ''
    assert(csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'"), '预览应限制脚本与外部资源')
    assert((preview.headers.get('content-disposition') || '').startsWith('inline'), '预览应内联展示')

    const fixed = await fetch(`http://127.0.0.1:${PORT}/api/iteration-specs/${id}/docx`, { headers: { Cookie: cookies['U-pm'] } })
    const fixedBuf = Buffer.from(await fixed.arrayBuffer())
    eq(fixed.headers.get('x-spec-fallback'), 'false', '应返回固化 Word')
    assert(fixedBuf.subarray(0, 2).toString() === 'PK' && fixedBuf.length > 5000, '固化 Word 应为有效 docx')

    const db = new DatabaseSync(dbFile)
    const original = db.prepare('SELECT docx_file FROM iteration_specs WHERE id = ?').get(id)
    db.prepare('UPDATE iteration_specs SET docx_file = NULL WHERE id = ?').run(id)
    db.close()
    assert(original.docx_file, '生成时应固化 Word 文件')

    const missing = await fails('U-pm', 'GET', `/api/iteration-specs/${id}/docx`, 500)
    eq(missing.code, 'SPEC_ARTIFACT_FAILED', '已记录产物的版本缺失文件时应拒绝导出')

    const db2 = new DatabaseSync(dbFile)
    db2.prepare('UPDATE iteration_specs SET docx_sha256 = NULL, skill_slug = NULL, skill_version = NULL WHERE id = ?').run(id)
    db2.close()
    const fallback = await fetch(`http://127.0.0.1:${PORT}/api/iteration-specs/${id}/docx`, { headers: { Cookie: cookies['U-pm'] } })
    const fallbackBuf = Buffer.from(await fallback.arrayBuffer())
    eq(fallback.headers.get('x-spec-fallback'), 'true', '历史版本缺失固化文件时应即时生成')
    assert(fallbackBuf.subarray(0, 2).toString() === 'PK', '回退导出应为有效 docx')
    const db3 = new DatabaseSync(dbFile)
    const after = db3.prepare('SELECT docx_file FROM iteration_specs WHERE id = ?').get(id)
    db3.close()
    eq(after.docx_file, null, '回退不回写历史记录')
  })

  await test('specification-publishing', 'Word 章节数与需求条目不一致时拒绝导出', async () => {
    const gen = await ok('U-pm', 'POST', specGenPath(), { mode: 'draft' })
    const db = new DatabaseSync(dbFile)
    const row = db.prepare('SELECT source_json, docx_file FROM iteration_specs WHERE id = ?').get(gen.id)
    assert(row.docx_file, '生成时应固化 Word')
    db.prepare('UPDATE iteration_specs SET source_json = ?, docx_file = NULL, docx_sha256 = NULL WHERE id = ?')
      .run(JSON.stringify({ ...JSON.parse(row.source_json), requirements: [] }), gen.id)
    db.close()
    const r = await fails('U-pm', 'GET', `/api/iteration-specs/${gen.id}/docx`, 500)
    eq(r.code, 'SPEC_ARTIFACT_FAILED', '章节与需求条目不一致应拒绝导出')
  })

  console.log('\n[release-planning]')

  await test('release-planning', '容量超限阻止排期，移出后恢复', async () => {
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/schedule`, { iterationId: ctx.iteration.id })
    await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/schedule`, 400, { iterationId: ctx.tinyIteration.id })
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/schedule`, { iterationId: null })
    const planning = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/planning`)
    assert(planning.unscheduled.some(x => x.id === ctx.req1), '移出后应回到未排期')
  })

  await test('release-planning', '依赖成环拒绝保存', async () => {
    await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/dependencies`, { fromReq: ctx.req1, toReq: ctx.req2 })
    await fails('U-pm', 'POST', `/api/projects/${ctx.projectId}/dependencies`, 400, { fromReq: ctx.req2, toReq: ctx.req1 })
    await fails('U-pm', 'POST', `/api/projects/${ctx.projectId}/dependencies`, 400, { fromReq: ctx.req1, toReq: ctx.req1 })
  })

  await test('release-planning', '迭代发布门禁拦截未上线需求', async () => {
    const db = new DatabaseSync(dbFile)
    const ts = new Date().toISOString()
    db.prepare(`INSERT INTO requirements (id, project_id, iteration_id, title, status, origin_type, source_json,
      clarification_json, involved_apps_json, created_at, updated_at, stall_since) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('REQ-release-block', ctx.projectId, ctx.iteration.id, '发布门禁待开发需求', '待开发', 'text', '{}', '{"answers":{}}', '[]', ts, ts, ts)
    db.close()
    const blocked = await fails('U-pm', 'POST', `/api/iterations/${ctx.iteration.id}/release`, 400)
    assert(blocked.details.blocked.some(x => x.id === 'REQ-release-block'), '应返回阻塞需求明细')
    const cleanup = new DatabaseSync(dbFile)
    cleanup.prepare('DELETE FROM requirements WHERE id = ?').run('REQ-release-block')
    cleanup.close()
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/schedule`, { iterationId: ctx.iteration.id })
    await ok('U-pm', 'POST', `/api/iterations/${ctx.iteration.id}/release`)
    const list = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/iterations`)
    eq(list.find(x => x.id === ctx.iteration.id).status, 'released', '迭代应已发布')
    await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/schedule`, 400, { iterationId: ctx.iteration.id })
  })

  console.log('\n[ai-orchestration]')
  await test('ai-orchestration', '规则引擎生成提案，确认后才写入', async () => {
    const r = await ok('U-pm', 'POST', `/api/requirements/${ctx.req2}/chat`, { message: '角色是：运营专员独立处理' })
    eq(r.engine, 'rules', '未配置模型时应使用规则引擎')
    assert(r.proposal?.status === 'pending', '应生成待确认提案')
    const before = await ok('U-pm', 'GET', `/api/requirements/${ctx.req2}`)
    assert(!before.clarification.answers.roles, '提案未确认前不应写入')
    await ok('U-pm', 'POST', `/api/proposals/${r.proposal.id}/apply`)
    const after = await ok('U-pm', 'GET', `/api/requirements/${ctx.req2}`)
    eq(after.clarification.answers.roles.value, '运营专员独立处理', '确认后应写入澄清')
  })

  await test('ai-orchestration', '自由描述批量抽取澄清字段生成单一提案', async () => {
    const msg = '这个需求主要是给门店店员使用，店员能够在使用柜台收银进行商品扫描过机的时候可以填写自己的或者他人的员工简码，并且能够把员工简码记录到这个订单上。这个需求是华东子公司门店运营部王雨虹提出的'
    const r = await ok('U-pm', 'POST', `/api/requirements/${ctx.req2}/chat`, { message: msg })
    eq(r.engine, 'rules', '未配置模型时应使用规则引擎')
    assert(r.proposal?.status === 'pending', '应生成待确认提案')
    const values = r.proposal.payload.values || {}
    eq(values.requester?.name, '王雨虹', '应抽取出提出人姓名')
    eq(values.requester?.enterprise, '华东子公司', '应匹配画像内企业')
    eq(values.roles, '门店店员', '应抽取角色')
    assert(values.goal, '应抽取目标与价值')
    assert(values.scope, '应抽取范围')
    await ok('U-pm', 'POST', `/api/proposals/${r.proposal.id}/apply`)
    const after = await ok('U-pm', 'GET', `/api/requirements/${ctx.req2}`)
    eq(after.requester.name, '王雨虹', '提出人应写入')
    eq(after.requester.enterprise, '华东子公司', '提出企业应写入')
    eq(after.clarification.answers.roles.value, '门店店员', '角色应写入')
    assert(after.clarification.answers.goal?.value, '目标应写入')
    assert(after.clarification.answers.scope?.value, '范围应写入')
  })

  await test('ai-orchestration', '多轮追问结合上文再次生成批量补充提案', async () => {
    const r = await ok('U-pm', 'POST', `/api/requirements/${ctx.req2}/chat`, { message: '根据我上面提供的信息，补充角色岗位、目标价值、范围编辑、涉及应用等相关信息' })
    assert(r.proposal?.status === 'pending', '应结合上文再次生成待确认提案')
    const values = r.proposal.payload.values || {}
    assert(values.roles || values.goal || values.scope, '提案应包含从上文抽取的字段')
  })

  await test('ai-orchestration', '模型不可用时降级为规则引擎', async () => {
    await ok('U-pm', 'PUT', `/api/projects/${ctx.projectId}/model`, { baseUrl: 'http://127.0.0.1:9', model: 'demo', apiKey: 'demo-key' })
    const r = await ok('U-pm', 'POST', `/api/requirements/${ctx.req2}/chat`, { message: '目标：减少人工核对' })
    eq(r.engine, 'rules', '模型失败后应降级')
    assert(r.reply.includes('模型调用失败'), '应明示降级原因')
    await ok('U-pm', 'PUT', `/api/projects/${ctx.projectId}/model`, { baseUrl: '', model: '' })
  })

  await test('ai-orchestration', '项目技能列表覆盖技能包 13 个技能与标准环节', async () => {
    const r = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/skills`)
    eq(r.pack.name, 'qoder-prd-skill-pack', '应返回技能包名称')
    eq(r.pack.version, '1.3.1', '应返回技能包版本')
    eq(r.pack.expected, 13, '技能包应声明 13 个技能')
    eq(r.skills.length, 13, '新项目应自动绑定技能包全部技能')
    assert(r.skills.every(s => s.sourceType === 'builtin'), '新项目初始只应有内置技能')
    const analyze = r.skills.find(s => s.slug === 'prd-analysis')
    assert(analyze && analyze.version, '内置分析技能应有版本')
    assert(analyze.stages.includes('analysis'), '内置分析技能应限定分析环节')
    const assemble = r.skills.find(s => s.slug === 'prd-assemble')
    assert(assemble?.enabled && assemble.stages.includes('spec'), '内置说明书技能应启用并声明说明书环节')
    const coverage = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/skills/coverage`)
    eq(coverage.loaded, 13, '技能包应全部注册')
    eq(coverage.bound, 13, '技能包应全部绑定')
    eq(coverage.compliant, 13, '技能包映射应全部合规')
    eq(coverage.problems, 0, '新项目不应有技能包问题')
    const calls = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/llm-calls`)
    assert(typeof calls.total.cost === 'number', '应可统计成本')
  })

  await test('ai-orchestration', '技能包自检识别环节偏差与停用并可一键修复', async () => {
    const skills = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/skills`)
    const analysis = skills.skills.find(s => s.slug === 'prd-analysis')
    await ok('U-pm', 'PATCH', `/api/projects/${ctx.projectId}/skills/${analysis.id}`, { stages: ['prototype'] })
    await ok('U-pm', 'PATCH', `/api/projects/${ctx.projectId}/skills/${analysis.id}`, { enabled: false })
    const broken = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/skills/coverage`)
    const row = broken.skills.find(s => s.slug === 'prd-analysis')
    assert(row.issues.some(i => i.code === 'stage_mismatch'), '应识别环节偏差')
    assert(row.issues.some(i => i.code === 'binding_disabled'), '应识别绑定停用')
    const repaired = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/skills/repair`, { resetStages: true })
    assert(repaired.changed >= 1, '修复应产生变更记录')
    eq(repaired.coverage.compliant, 13, '修复后技能包应全部合规')
    eq(repaired.coverage.problems, 0, '修复后不应残留问题')

    const db = new DatabaseSync(dbFile)
    db.prepare('DELETE FROM project_skills WHERE id = ?').run(analysis.id)
    db.close()
    const unbound = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/skills/coverage`)
    assert(unbound.skills.find(s => s.slug === 'prd-analysis').issues.some(i => i.code === 'not_bound'), '应识别未绑定技能')
    const rebound = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/skills/repair`)
    eq(rebound.coverage.bound, 13, '修复后应重新绑定全部技能')
    await fails('U-r1', 'POST', `/api/projects/${ctx.projectId}/skills/repair`, 403)
  })

  await test('ai-orchestration', '导入技能包并拒绝非法包与重复导入', async () => {
    const zip = new JSZip()
    zip.file('skill.json', JSON.stringify({
      slug: 'custom-brief', name: '需求摘要技能', version: '1.0.0',
      description: '把需求上下文压缩为摘要', stages: ['analysis']
    }))
    zip.file('prompt.md', '请根据需求上下文输出不超过 200 字的摘要。')
    const archiveBase64 = (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64')
    const created = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/skills/import`, { archiveBase64, stages: ['analysis', 'review'] })
    ctx.customSkill = created
    eq(created.slug, 'custom-brief', '应解析技能标识')
    eq(created.sourceType, 'import', '导入技能来源应为 import')
    eq(created.stages.length, 2, '应按提交的环节写入绑定')

    const skillJson = Buffer.from(JSON.stringify({ slug: 'bad-skill', name: '非法包', version: '1.0.0' })).toString('base64')
    const emptyZip = new JSZip()
    emptyZip.file('README.md', '缺少清单')
    await fails('U-pm', 'POST', `/api/projects/${ctx.projectId}/skills/import`, 400, {
      archiveBase64: (await emptyZip.generateAsync({ type: 'nodebuffer' })).toString('base64')
    })
    await fails('U-pm', 'POST', `/api/projects/${ctx.projectId}/skills/import`, 400, {
      files: [
        { path: 'skill.json', base64: skillJson },
        { path: '../escape.md', base64: Buffer.from('x').toString('base64') }
      ]
    })
    await fails('U-pm', 'POST', `/api/projects/${ctx.projectId}/skills/import`, 400, {
      files: [
        { path: 'skill.json', base64: skillJson },
        { path: 'run.sh', base64: Buffer.from('echo hi').toString('base64') }
      ]
    })
    await fails('U-pm', 'POST', `/api/projects/${ctx.projectId}/skills/import`, 409, { archiveBase64 })
    await fails('U-pm', 'PATCH', `/api/projects/${ctx.projectId}/skills/${created.id}`, 400, { stages: ['unknown'] })
  })

  await test('ai-orchestration', '手动执行按环节校验且写回仍走提案', async () => {
    const list = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/skills`)
    const analyze = list.skills.find(s => s.slug === 'prd-analysis')
    await fails('U-pm', 'POST', `/api/requirements/${ctx.req1}/skills/${analyze.id}/run`, 403, { stage: 'prototype' })
    const run = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/skills/${analyze.id}/run`, { stage: 'analysis' })
    eq(run.skill.slug, 'prd-analysis', '应返回执行的技能')
    eq(run.stage, 'analysis', '应记录执行环节')
    assert(run.proposal?.status === 'pending', '技能写回应生成待确认提案')
    const generic = await ok('U-pm', 'POST', `/api/requirements/${ctx.req1}/skills/${ctx.customSkill.id}/run`, { stage: 'analysis' })
    eq(generic.status, 'model-unavailable', '未配置模型时技能应明示未执行')
    assert(generic.content.includes('未执行'), '未配置模型时不得伪装成功')
  })

  await test('ai-orchestration', '跨项目引用技能并受来源可用性约束', async () => {
    const code = 'T' + String(Date.now()).slice(-6)
    const p2 = await ok('U-pm', 'POST', '/api/projects', {
      name: '引用目标项目', code, members: [{ userId: 'U-pm', role: 'pm' }, { userId: 'U-pm2', role: 'pm' }]
    })
    ctx.project2 = p2
    const candidates = await ok('U-pm', 'GET', `/api/projects/${p2.id}/skills/reference-candidates`)
    assert(candidates.candidates.some(c => c.slug === 'custom-brief' && c.sourceProject?.id === ctx.projectId), '候选应包含来源项目技能')
    const referenced = await ok('U-pm', 'POST', `/api/projects/${p2.id}/skills/reference`, { sourceBindingId: ctx.customSkill.id, stages: ['analysis'] })
    ctx.referencedSkill = referenced
    eq(referenced.sourceType, 'reference', '引用来源应为 reference')
    eq(referenced.sourceProject.id, ctx.projectId, '应记录来源项目')
    await fails('U-pm', 'POST', `/api/projects/${p2.id}/skills/reference`, 409, { sourceBindingId: ctx.customSkill.id })

    const outsider = await ok('U-pm2', 'GET', `/api/projects/${p2.id}/skills/reference-candidates`)
    eq(outsider.candidates.length, 0, '非来源项目成员不应看到候选技能')
    await fails('U-pm2', 'POST', `/api/projects/${p2.id}/skills/reference`, 403, { sourceBindingId: ctx.customSkill.id })

    await ok('U-pm', 'PATCH', `/api/projects/${ctx.projectId}/skills/${ctx.customSkill.id}`, { stages: ['analysis'] })
    await ok('U-pm', 'PATCH', `/api/projects/${ctx.projectId}/skills/${ctx.customSkill.id}`, { enabled: false })
    const blocked = await ok('U-pm', 'GET', `/api/projects/${p2.id}/skills`)
    const view = blocked.skills.find(s => s.slug === 'custom-brief')
    eq(view.sourceAvailable, false, '来源停用后引用方应标记不可用')
    eq(view.enabled, false, '来源停用后引用方不应可用')

    await ok('U-pm', 'DELETE', `/api/projects/${ctx.projectId}/skills/${ctx.customSkill.id}`)
    const afterRemove = await ok('U-pm', 'GET', `/api/projects/${p2.id}/skills`)
    eq(afterRemove.skills.find(s => s.slug === 'custom-brief').sourceReason, '来源项目已移除该技能', '来源移除后应给出原因')
    const builtin = (await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/skills`)).skills.find(s => s.sourceType === 'builtin')
    await fails('U-pm', 'DELETE', `/api/projects/${ctx.projectId}/skills/${builtin.id}`, 400)
  })

  await test('access-control', '技能导入、引用、配置、启停与移除写入审计', async () => {
    const audits = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/audits`)
    for (const action of ['skill.import', 'skill.config', 'skill.toggle', 'skill.remove']) {
      assert(audits.some(a => a.action === action), `审计缺少 ${action}`)
    }
    const p2Audits = await ok('U-pm', 'GET', `/api/projects/${ctx.project2.id}/audits`)
    assert(p2Audits.some(a => a.action === 'skill.reference'), '引用动作应写入来源与目标审计')
  })

  console.log('\n[access-control]')
  await test('access-control', '角色越权写入被服务端拒绝', async () => {
    await fails('U-dev', 'POST', `/api/requirements/${ctx.req2}/analysis`, 403, { analysis: analysisPayload() })
    await fails('U-r1', 'POST', `/api/projects/${ctx.projectId}/requirements/intake`, 403, { text: '越权登记' })
    await fails('U-guest', 'GET', `/api/projects/${ctx.projectId}/requirements`, 403)
    await fails(null, 'GET', '/api/projects', 401)
  })

  await test('access-control', '非成员无法跨项目访问', async () => {
    await fails('U-pm2', 'GET', `/api/projects/${ctx.projectId}/requirements`, 403)
  })

  await test('access-control', '只读分享与撤回', async () => {
    const s = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/shares`, { objectId: ctx.req1, objectType: 'requirement', days: 7 })
    const pub = await api(null, 'GET', `/api/public/shares/${s.token}`)
    eq(pub.status, 200, '匿名访问分享')
    eq(pub.body.scope, 'readonly', '分享应为只读')
    await ok('U-pm', 'POST', `/api/shares/${s.id}/revoke`)
    const after = await api(null, 'GET', `/api/public/shares/${s.token}`)
    eq(after.status, 410, '撤回后应返回 410')
  })

  await test('access-control', '对外表单登记与回执隔离', async () => {
    const f = await ok('U-pm', 'POST', `/api/projects/${ctx.projectId}/forms`, { days: 7 })
    const info = await api(null, 'GET', `/api/public/forms/${f.token}`)
    eq(info.status, 200, '匿名访问表单')
    const sub = await api(null, 'POST', `/api/public/forms/${f.token}/submissions`, {
      title: '对外表单：页面需要支持批量导出', content: '业务方希望检索结果支持批量导出。', submitter: '外部提交人'
    })
    eq(sub.status, 201, '匿名提交应成功')
    const own = await api(null, 'GET', `/api/public/forms/${f.token}/submissions/${sub.body.receipt}`)
    eq(own.status, 200, '回执应可查询自己的提交')
    eq(own.body.title, '对外表单：页面需要支持批量导出', '只能看到自己的提交内容')
    const other = await api(null, 'GET', `/api/public/forms/${f.token}/submissions/RC-invalid`)
    eq(other.status, 404, '无效回执不可见')
  })

  await test('access-control', '敏感动作与分享访问写入审计', async () => {
    await fails('U-r1', 'GET', `/api/projects/${ctx.projectId}/audits`, 403)
    const audits = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/audits`)
    assert(audits.length >= 10, '审计日志应记录关键动作')
    for (const action of ['project.create', 'requirement.confirm', 'spec.publish', 'review.conclude', 'share.view']) {
      assert(audits.some(a => a.action === action), `审计缺少 ${action}`)
    }
    const csv = await fetch(`http://127.0.0.1:${PORT}/api/projects/${ctx.projectId}/audits/export`, { headers: { Cookie: cookies['U-pm'] } })
    const text = await csv.text()
    assert(csv.status === 200 && text.includes('操作人'), '审计导出应可下载')
  })

  console.log('\n[performance-probe]')
  await test('performance-probe', '千条需求列表响应时间低于 2 秒', async () => {
    const db = new DatabaseSync(dbFile)
    const ts = new Date().toISOString()
    const insert = db.prepare(`INSERT INTO requirements (id, project_id, title, status, origin_type, source_json,
      clarification_json, involved_apps_json, created_at, updated_at, stall_since) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    db.exec('BEGIN')
    for (let i = 0; i < 1000; i++) {
      insert.run(`REQ-perf-${i}`, ctx.projectId, `性能探针需求 ${i}`, '待需求分析', 'text', '{}', '{"answers":{}}', '[]', ts, ts, ts)
    }
    db.exec('COMMIT')
    db.close()
    const started = Date.now()
    const rows = await ok('U-pm', 'GET', `/api/projects/${ctx.projectId}/requirements?status=待需求分析`)
    const ms = Date.now() - started
    assert(rows.length >= 1000, '应返回千条记录')
    assert(ms < 2000, `千条列表耗时 ${ms}ms，超过 2 秒`)
    console.log(`      千条列表耗时 ${ms}ms`)
  })

  await test('performance-probe', '会话首 token 低于 3 秒', async () => {
    const started = Date.now()
    await ok('U-pm', 'POST', `/api/requirements/${ctx.req2}/chat`, { message: '目标：减少人工核对时间' })
    const ms = Date.now() - started
    assert(ms < 3000, `会话响应耗时 ${ms}ms，超过 3 秒`)
    console.log(`      首 token 耗时 ${ms}ms`)
  })

  await test('performance-probe', '首屏静态资源响应低于 2 秒', async () => {
    const started = Date.now()
    const r = await fetch(`http://127.0.0.1:${PORT}/`)
    const html = await r.text()
    const ms = Date.now() - started
    assert(r.status === 200 && html.includes('<div id="root">'), '应返回应用入口 HTML')
    assert(ms < 2000, `入口响应耗时 ${ms}ms，超过 2 秒`)
    console.log(`      入口响应 ${ms}ms`)
  })

  const total = results.length
  const failed = results.filter(r => !r.ok)
  const caps = [...new Set(results.map(r => r.capability))]
  console.log(`\n结果：${total - failed.length}/${total} 通过，覆盖 ${caps.length} 项能力`)
  if (failed.length) {
    console.log('\n失败明细：')
    for (const f of failed) console.log(`- [${f.capability}] ${f.name}：${f.error}`)
    process.exitCode = 1
  }
}

try {
  await run()
} catch (e) {
  console.error('\n测试执行失败：', e.message)
  process.exitCode = 1
} finally {
  if (server) server.kill()
  await new Promise(r => setTimeout(r, 300))
  try {
    const cleanup = new DatabaseSync(dbFile)
    const files = cleanup.prepare('SELECT docx_file FROM iteration_specs WHERE docx_file IS NOT NULL').all()
    cleanup.close()
    const filesDir = path.join(root, 'data', 'files')
    for (const f of files) {
      try { fs.unlinkSync(path.join(filesDir, f.docx_file)) } catch { /* 忽略 */ }
    }
  } catch { /* 临时数据库可能未创建 */ }
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    try { fs.unlinkSync(f) } catch { /* 忽略 */ }
  }
}
