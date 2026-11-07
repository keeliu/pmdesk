import { all, get, parseJson } from '../db.mjs'
import { normalizeAnalysis } from './render.mjs'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle
} from 'docx'

const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9DDE3' }
const cellBorders = { top: border, bottom: border, left: border, right: border }

function cell(text, { bold = false, fill = null, width } = {}) {
  return new TableCell({
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined,
    shading: fill ? { fill } : undefined,
    borders: cellBorders,
    children: [new Paragraph({
      children: [new TextRun({ text: String(text ?? ''), bold, size: 20, font: '微软雅黑' })],
      spacing: { before: 40, after: 40 }
    })]
  })
}

function table(headers, rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: headers.map(h => cell(h, { bold: true, fill: 'F2F4F7' })) }),
      ...rows.map(r => new TableRow({ children: r.map(v => cell(v)) }))]
  })
}

function h(text, level = HeadingLevel.HEADING_2) {
  return new Paragraph({ heading: level, spacing: { before: 240, after: 120 }, children: [new TextRun({ text, font: '微软雅黑' })] })
}
function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 100 },
    children: [new TextRun({ text: String(text ?? ''), size: 21, font: '微软雅黑', ...opts })]
  })
}

function buildDocChildren({ req, project, analysis, pages, version, reviews, changes, pageBreakBefore = false, footer = true }) {
  const a = normalizeAnalysis(analysis)
  const children = []
  if (pageBreakBefore) children.push(new Paragraph({ pageBreakBefore: true, children: [] }))
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [new TextRun({ text: `${req.title}`, bold: true, size: 36, font: '微软雅黑' })] }))
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: '需求分析说明书', size: 24, color: '6D7783', font: '微软雅黑' })] }))
  children.push(table(['项目', '内容'], [
    ['需求编号', req.code || '—'], ['所属项目', `${project.name}（${project.code}）`],
    ['说明书版本', `V${version}`], ['需求状态', req.status],
    ['生成时间', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })]
  ]))
  children.push(h('1 需求概述'))
  children.push(p(`背景：${a.description.background || '—'}`))
  children.push(p(`目标：${a.description.goal || '—'}`))
  children.push(p(`价值：${a.description.value || '—'}`))
  children.push(p(`角色：${(a.description.roles || []).join('、') || '—'}`))

  children.push(h('2 澄清结论'))
  let clar = {}
  try { clar = JSON.parse(req.clarification_json || '{}') } catch { clar = {} }
  children.push(table(['维度', '结论'], [
    ['角色与岗位', clar.answers?.roles?.value || '—'],
    ['目标与价值', clar.answers?.goal?.value || '—'],
    ['范围', clar.answers?.scope?.value || '—'],
    ['边界', clar.answers?.boundary?.value || '—'],
    ['验收口径', clar.answers?.acceptance?.value || '—'],
    ['涉及应用', (a.integration.apps || []).map(x => x.name).join('、') || '—']
  ]))

  children.push(h('3 业务流程说明'))
  children.push(p(a.process.summary || ''))
  children.push(table(['节点', '角色', '动作', '分支条件', '分支结果', '下一节点'],
    (a.process.steps || []).map(s => [s.node, s.role, s.action, s.branch || '—', s.result || '—', s.next || '—'])))

  children.push(h('4 功能设计'))
  children.push(h('4.1 功能架构', HeadingLevel.HEADING_3))
  children.push(table(['层级', '功能', '说明', '优先级'], (a.functions.architecture || []).map(n => [n.parent || '一级', n.name, n.description || '', n.priority || 'P1'])))
  children.push(h('4.2 功能说明', HeadingLevel.HEADING_3))
  children.push(table(['功能', '说明', '优先级', '验收要点'], (a.functions.list || []).map(f => [f.name, f.description || '', f.priority || 'P1', f.acceptance || ''])))
  children.push(h('4.3 功能流程', HeadingLevel.HEADING_3))
  children.push(table(['起点', '动作', '条件', '终点'], (a.functions.flow || []).map(f => [f.from || '', f.action || '', f.condition || '—', f.to || ''])))
  children.push(h('4.4 辅助支撑功能', HeadingLevel.HEADING_3))
  if ((a.functions.support || []).length) children.push(table(['功能', '说明'], a.functions.support.map(s => [s.name, s.description || ''])))
  else children.push(p('本期无需额外辅助支撑功能。'))

  children.push(h('5 集成说明'))
  children.push(h('5.1 涉及应用', HeadingLevel.HEADING_3))
  children.push(table(['应用', '类型', '说明'], (a.integration.apps || []).map(x => [x.name, x.kind === 'external' ? '外部依赖' : '内部应用', x.note || ''])))
  children.push(h('5.2 集成点', HeadingLevel.HEADING_3))
  children.push(table(['应用', '方向', '数据对象', '触发时机', '说明'], (a.integration.points || []).map(x => [x.app || '', x.direction || '', x.object || '', x.trigger || '', x.note || ''])))

  children.push(h('6 界面原型'))
  children.push(p(`原型版本 V${version}，共 ${pages.length} 个页面。可交互原型请在线查看。`))
  children.push(table(['页面', '布局', '覆盖功能'], pages.map(x => [x.name, x.layout, (x.functions || []).join('、')])))

  children.push(h('7 验收口径'))
  children.push(h('7.1 逐步完成标准', HeadingLevel.HEADING_3))
  for (const s of a.acceptance.steps || []) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: s, font: '微软雅黑', size: 21 })] }))
  children.push(h('7.2 整体完成标准', HeadingLevel.HEADING_3))
  children.push(p(a.acceptance.overall || '—'))
  children.push(h('7.3 价值验证', HeadingLevel.HEADING_3))
  if ((a.acceptance.metrics || []).length) {
    children.push(table(['指标', '目标值', '观察周期'], a.acceptance.metrics.map(m => [m.name, m.target, m.period || '上线后一个月'])))
  } else children.push(p('—'))

  if (changes?.length) {
    children.push(h('8 变更记录'))
    children.push(table(['编号', '分级', '内容', '处理方式', '状态'], changes.map(c => [`CHG-${String(c.seq).padStart(3, '0')}`, c.grade, c.content, c.handling || '—', c.status])))
  }
  if (reviews?.length) {
    children.push(h(reviews?.length && changes?.length ? '9 评审记录' : '8 评审记录'))
    children.push(table(['轮次', '评审人', '结论', '时间'], reviews.map(r => [`第 ${r.round} 轮`, parseJson(r.reviewers_json, []).join('、'), r.conclusion || '进行中', (r.decided_at || r.created_at).slice(0, 10)])))
  }
  if (footer) children.push(new Paragraph({ spacing: { before: 300 }, children: [new TextRun({ text: '本文档由需求管理工作台生成，与需求分析版本对应。', color: '8A929C', size: 18, font: '微软雅黑' })] }))
  return children
}

export async function buildRequirementDocx(args) {
  const children = buildDocChildren(args)
  const doc = new Document({
    styles: { default: { document: { run: { font: '微软雅黑', size: 21 } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } }, children }]
  })
  return Packer.toBuffer(doc)
}

export function buildIterationDocChildren({ project, iteration, row }) {
  const source = parseJson(row.source_json, {})
  const children = []
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [new TextRun({ text: `${iteration?.name || '迭代'} 迭代需求分析说明书`, bold: true, size: 36, font: '微软雅黑' })] }))
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: `V${row.version} · ${row.mode === 'formal' ? '正式版' : '草稿版'}`, size: 24, color: '6D7783', font: '微软雅黑' })] }))
  children.push(table(['项目', '内容'], [
    ['所属项目', `${project.name}（${project.code}）`],
    ['迭代', iteration?.name || '—'],
    ['迭代周期', `${iteration?.start_date || '—'} 至 ${iteration?.end_date || '—'}`],
    ['容量', `${iteration?.capacity_days || 0} 人日`],
    ['纳入需求', `${row.requirement_count || 0} 条`],
    ['生成时间', new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })]
  ]))
  children.push(h('迭代总览'))
  children.push(p(`迭代目标：${iteration?.goal || '—'}`))
  const ids = (source.requirements || []).map(r => r.id)
  const current = ids.length ? all(`SELECT * FROM requirements WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : []
  const statuses = {}
  for (const r of current) statuses[r.status] = (statuses[r.status] || 0) + 1
  children.push(table(['状态', '数量'], Object.entries(statuses)))
  children.push(table(['需求编号', '需求标题', '状态', '优先级', '分析版本', '说明书版本'],
    (source.requirements || []).map(r => [
      r.code || '未编号', r.title, current.find(c => c.id === r.id)?.status || '—',
      parseJson(current.find(c => c.id === r.id)?.priority_json, {})?.gradeLabel || '—',
      r.analysisVersion ? 'V' + r.analysisVersion : '待补',
      r.specVersion ? 'V' + r.specVersion : '待补'
    ])))
  if ((row.missing_json ? parseJson(row.missing_json, []) : []).length) {
    children.push(h('待补清单', HeadingLevel.HEADING_3))
    for (const m of parseJson(row.missing_json, [])) children.push(p(`${m.code || '未编号'} ${m.title}：${(m.items || []).join('、')}`))
  }
  let chapterCount = 0
  for (const ref of source.requirements || []) {
    const req = get('SELECT * FROM requirements WHERE id = ?', ref.id)
    if (!req) continue
    const analysisRow = ref.analysisVersion
      ? get('SELECT * FROM requirement_versions WHERE requirement_id = ? AND version = ?', req.id, ref.analysisVersion)
      : null
    const proto = ref.prototypeVersion
      ? get('SELECT * FROM prototypes WHERE requirement_id = ? AND version = ?', req.id, ref.prototypeVersion)
      : null
    const pages = proto ? parseJson(proto.pages_json, []) : []
    const reviews = all('SELECT * FROM reviews WHERE requirement_id = ? ORDER BY round', req.id)
    const changes = all('SELECT * FROM changes WHERE requirement_id = ? ORDER BY seq', req.id)
    children.push(...buildDocChildren({
      req, project, analysis: parseJson(analysisRow?.analysis_json, {}), pages,
      version: ref.specVersion || ref.analysisVersion || 1, reviews, changes,
      pageBreakBefore: true, footer: false
    }))
    chapterCount++
  }
  children.push(new Paragraph({ spacing: { before: 300 }, children: [new TextRun({ text: '本文档由需求管理工作台按迭代聚合生成。', color: '8A929C', size: 18, font: '微软雅黑' })] }))
  return { children, chapterCount }
}

export async function buildIterationDocx({ project, iteration, row }) {
  const { children, chapterCount } = buildIterationDocChildren({ project, iteration, row })
  const expected = row.requirement_count || 0
  if (chapterCount !== expected) {
    const e = new Error(`导出一致性校验失败：Word 章节 ${chapterCount}，需求条目 ${expected}`)
    e.statusCode = 500
    e.code = 'SPEC_ARTIFACT_FAILED'
    e.details = { chapterCount, expected }
    throw e
  }
  const doc = new Document({
    styles: { default: { document: { run: { font: '微软雅黑', size: 21 } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } }, children }]
  })
  return Packer.toBuffer(doc)
}
