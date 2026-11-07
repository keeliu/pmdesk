import { enterpriseOptions } from './requester.mjs'

const CLAUSE_SPLIT = /[。！？!?；;\n]/
const HIGH_RE = /(总经理|副总经理|副总裁|总监|高层|领导|一把手)/
const MIDDLE_RE = /(店长|经理|主管|负责人|部长|主任)/
const BASIC_RE = /(专员|店员|营业员|收银员|文员|员工)/
const TITLE_RE = /(?:^|[的由在是，。、：:\s])([一-龥]{0,4}?(?:总经理|副总经理|副总裁|总监|店长|经理|主管|负责人|部长|主任|专员|店员|营业员|收银员|文员|员工))/
const DEPT_BODY = '[^给是的目的由在并能够可下了后为与或把让被，。、：:\\s]'
const DEPT_RE = new RegExp(`(?:^|[是的目的由在，。、：:\\s])(${DEPT_BODY}{2,10}?(?:运营部|市场部|销售部|管理部|信息部|技术部|客服部|门店部|财务部|人事部|发展部|综合部|部门|中心|分公司|办事处|班组|片区|门店(?!员|长|铺|店)))`)
const COMPANY_RE = /[一-龥A-Za-z0-9（）()]{2,18}(?:公司|集团|单位|企业)/
const COMPANY_BOUNDED_RE = /(?:^|[由是的目的在给，。、：:\s])([^由是的目的在给，。、：:\s]{2,18}(?:公司|集团|单位|企业))/
const NAME_CHARS = '[^，。；、：:\\n部中心店司组馆所]'
const ROLE_LOC_RE = new RegExp(`(${DEPT_BODY}{2,12}?)(?:在|从)[^，。；\\n]{0,16}?(?:完成|负责|进行|处理|操作)`)

function clean(s) {
  return String(s || '')
    .replace(/^(?:并且|同时|以及|和|并|且|，|、|：|:|，|,|\s)+/, '')
    .replace(/[，,、；;「」“”"'\s]+$/, '')
    .replace(/[「」“”"'\s]+$/, '')
    .trim()
}

function clausesOf(text) {
  return String(text).split(CLAUSE_SPLIT)
    .flatMap(s => s.split(/(?<=，)|(?<=,)/))
    .map(clean).filter(Boolean)
}

export function extractRequester(texts, project) {
  const text = texts.join('\n')
  const noCompany = text.replace(COMPANY_RE, '')
  let enterprise = ''
  for (const name of enterpriseOptions(project)) {
    if (name && text.includes(name)) { enterprise = name; break }
  }
  if (!enterprise) {
    const cm = text.match(COMPANY_BOUNDED_RE)
    if (cm) enterprise = cm[1]
  }
  const dm = noCompany.match(DEPT_RE)
  const department = dm ? dm[1].replace(/^[从在由]/, '') : ''
  const nm = noCompany.match(new RegExp(`部(${NAME_CHARS}{2,4})(?:提出|提报|发起)`))
    || noCompany.match(new RegExp(`(${NAME_CHARS}{2,4})提出的`))
    || noCompany.match(/由([一-龥]{2,4})(?:提出|提报|发起)/)
    || noCompany.match(/提出人(?:为|是|：|:)?\s*([一-龥]{2,4})/)
    || noCompany.match(/提报人(?:为|是|：|:)?\s*([一-龥]{2,4})/)
  const name = nm ? nm[1] : ''
  const TITLE_WORDS = '总经理|副总经理|副总裁|总监|店长|经理|主管|负责人|部长|主任|专员|店员|营业员|收银员|文员|员工'
  let title = ''
  if (name) {
    const named = noCompany.match(new RegExp(`${name}是([一-龥]{0,6}(?:${TITLE_WORDS}))`))
      || noCompany.match(new RegExp(`([一-龥]{0,6}(?:${TITLE_WORDS}))${name}`))
    if (named) title = named[1]
    if (!title) {
      const at = noCompany.indexOf(name)
      const near = noCompany.slice(Math.max(0, at - 6), at + name.length + 6)
      const tm = near.match(TITLE_RE)
      title = tm ? tm[1] : ''
    }
  }
  if (!title) {
    const pm = text.match(/岗位(?:为|是|：|:)\s*([^。，；\n]{2,16})/)
    if (pm) title = clean(pm[1])
  }
  let level = ''
  if (title) {
    if (HIGH_RE.test(title)) level = 'high'
    else if (MIDDLE_RE.test(title)) level = 'middle'
    else if (BASIC_RE.test(title)) level = 'basic'
  }
  if (!level && /外部(提出|单位|人员)|提出方在外部/.test(text)) level = 'external'
  const pm = text.match(/岗位(?:为|是|：|:)\s*([^。，；\n]{2,16})/)
  const position = pm ? clean(pm[1]) : title
  if (!enterprise && !department && !name && !level && !position) return null
  const external = level === 'external' || (!enterprise && Boolean(name))
  return {
    ...(enterprise ? { enterprise } : {}),
    ...(department ? { department } : {}),
    ...(name ? { name } : {}),
    ...(level ? { level } : {}),
    ...(position ? { position } : {}),
    ...(external ? { external: true } : {})
  }
}

function stripCondition(clause) {
  return clean(clause.replace(/^在[^，,]{0,24}?(?:时候|时|期间|过程中)/, ''))
}

export function extractClarification(texts, { project, scopeAll = [] }) {
  const text = texts.join('\n')
  const clauses = clausesOf(text)
  const values = {}

  const requester = extractRequester(texts, project)
  if (requester) values.requester = requester

  const roleM = text.match(/主要(?:是|给|面向)?(?:给)?\s*([一-龥、，,和及\s]{2,30}?)\s*(?:使用|办理|操作|录入|处理)/)
    || text.match(/面向\s*([一-龥、，,和及\s]{2,30}?)\s*(?:用户|人员|群体|角色)/)
    || text.match(/使用(?:人|人员|对象|角色)?(?:为|是|：|:)\s*([^。；\n]{2,30})/)
    || text.match(ROLE_LOC_RE)
  if (roleM) values.roles = clean(roleM[1].split(/[在从]/)[0])

  const goalClauses = clauses.filter(c => /(以便|从而|为了|实现|提升|减少|降低|避免|防止|杜绝|解决)/.test(c)
    || /(能够?|可以)?把[^。，]{2,40}(记录|同步|归档|留存|汇总|统计|追溯)/.test(c))
  if (goalClauses.length) values.goal = goalClauses.slice(0, 2).map(clean).join('；')

  const scopeClauses = clauses
    .filter(c => !goalClauses.includes(c) && /(可以|能够|支持)/.test(c))
    .map(c => stripCondition(c.replace(/^.*?(?:可以|能够|支持)/, '')))
    .filter(c => c.length >= 4 && c.length <= 60)
  const scopeM = text.match(/(?:范围|涵盖内容|包含内容)(?:为|是|：|:)\s*([^。；\n]{4,80})/)
  if (scopeM) values.scope = clean(scopeM[1])
  else if (scopeClauses.length) values.scope = [...new Set(scopeClauses)].slice(0, 2).join('；')

  const boundaryClauses = clauses.filter(c => /(不包括|不涉及|不需要|不支持|无需|除外|排除|仅限|只需|只允许)/.test(c))
  const boundaryM = text.match(/(?:边界|不做|排除)(?:为|是|：|:)\s*([^。；\n]{4,80})/)
  if (boundaryM) values.boundary = clean(boundaryM[1])
  else if (boundaryClauses.length) values.boundary = boundaryClauses.slice(0, 2).join('；')

  const accM = text.match(/验收(?:口径|标准)?(?:为|是|：|:)\s*([^。；\n]{4,80})/)
  if (accM) values.acceptance = clean(accM[1])
  else {
    const accClauses = clauses.filter(c => /(必须|应当|要求|准确|完整|一致|可追溯|可查询)/.test(c) && /(数据|信息|记录|字段|结果|操作)/.test(c))
    if (accClauses.length) values.acceptance = accClauses.slice(0, 2).join('；')
  }

  const appNames = new Set()
  const GENERIC_APP = /^(涉及|相关|该|此|所有|补充|上述|以下)?应用$/
  const noCo = text.replace(COMPANY_RE, '')
  for (const name of scopeAll) if (name && text.includes(name)) appNames.add(name)
  for (const m of noCo.matchAll(/(?:^|[：:，。、\s的])([一-龥A-Za-z0-9]{2,12}(?:系统|平台|应用))/g)) {
    if (!GENERIC_APP.test(m[1]) && !appNames.has(m[1])) appNames.add(m[1])
  }
  if (appNames.size) values.involvedApps = [...appNames]

  const fields = Object.keys(values)
  return fields.length ? { values, fields } : null
}
