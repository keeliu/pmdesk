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

export const STATUS_NAMES = [...STAGES.map(s => s.name), ...EXCEPTION_STATES]

export const STATUS_INDEX: Record<string, number> = Object.fromEntries(STAGES.map(s => [s.name, s.index]))

export const STATUS_TONE: Record<string, string> = {
  '需求调研中': 'gray', '待需求分析': 'blue', '需求分析中': 'indigo',
  '需求评审中': 'amber', '待开发': 'violet', '开发中': 'teal',
  '待测试验证': 'cyan', '测试验证中': 'cyan', '待UAT': 'orange',
  'UAT中': 'orange', '待试点': 'brown', '试点中': 'brown',
  '待上线发版': 'orange', '全国推广中': 'green',
  '已关闭': 'slate', '挂起': 'brown', '已丢弃': 'red'
}

export const STATUS_STAGE: Record<string, string> = Object.fromEntries(STAGES.map(s => [s.name, s.stage]))

export function statusLabel(status: string) {
  const index = STATUS_INDEX[status]
  return index === undefined ? status : `${index}-${status}`
}

export function stageOf(status: string) {
  return STATUS_STAGE[status] || 'change'
}

export const TRANSITIONS: Record<string, string[]> = {
  '需求调研中': ['待需求分析', '已丢弃', '挂起'],
  '待需求分析': ['需求分析中', '挂起'],
  '需求分析中': ['需求评审中', '挂起'],
  '需求评审中': ['待开发', '需求分析中', '挂起'],
  '待开发': ['开发中', '需求评审中', '挂起'],
  '开发中': ['待测试验证', '需求评审中', '挂起'],
  '待测试验证': ['测试验证中', '开发中', '挂起'],
  '测试验证中': ['待UAT', '开发中', '挂起'],
  '待UAT': ['UAT中', '测试验证中', '挂起'],
  'UAT中': ['待试点', '开发中', '挂起'],
  '待试点': ['试点中', 'UAT中', '挂起'],
  '试点中': ['待上线发版', '开发中', '挂起'],
  '待上线发版': ['全国推广中', '试点中', '挂起'],
  '全国推广中': ['已关闭', '挂起'],
  '挂起': ['恢复'],
  '已关闭': [],
  '已丢弃': []
}

export function nextStatuses(status: string) {
  return TRANSITIONS[status] || []
}

export const PRIORITY_TONE: Record<string, string> = { P0: 'red', P1: 'orange', P2: 'blue', P3: 'gray' }
