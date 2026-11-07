# 设计：产物技能化（流程图 + 需求说明书）

## 1. 背景与约束

- 工作台不执行技能包内任何脚本（ai-orchestration 既有约束），只登记技能元数据、契约与模板；prd-visuals / archify / prd-assemble 的产物契约由工作台内置渲染器**按其契约原生实现**，产物结构、校验口径与技能约定一致。
- 技能、模板、种子数据不得出现真实公司/组织/项目/供应商名称；需求编号不得进入正文叙述与标题，只允许出现在追踪表「编号」列、机器契约、标记与附录索引。
- 设计令牌零改动继承（原型与图表配色沿用既有 CSS 变量口径）。
- 预览 HTML 自包含：禁止脚本执行与外部资源（迭代说明书预览既有安全口径扩展到流程图与需求说明书）。
- AI 以发起用户身份工作，不额外获得权限；生成类动作服务端校验权限，敏感写入与导出必须审计。

## 2. 数据模型

### 2.1 新增 `flowcharts` 表

```sql
CREATE TABLE IF NOT EXISTS flowcharts (
  id TEXT PRIMARY KEY,
  requirement_id TEXT NOT NULL,
  analysis_version INTEGER NOT NULL,   -- 对应 requirement_versions.version
  renderer TEXT NOT NULL,              -- archify | builtin
  skill_binding_id TEXT,
  skill_slug TEXT,
  skill_version TEXT,
  source_json TEXT,                    -- 图表技能契约候选 JSON（functions.flow 映射结果）
  html TEXT NOT NULL,
  html_size INTEGER,
  html_sha256 TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (requirement_id, analysis_version)
);
```

- 一个分析版本至多一条流程图记录；分析内容修订后重新提交同一版本不覆盖——重新生成只更新 html/source/updated_at 并写审计，版本归属不变。
- `renderer='builtin'` 表示降级渲染（含历史数据补登记），元数据区分技能生成与降级生成。

### 2.2 `specs` 表扩展（可空，历史行保持 NULL）

```sql
ALTER TABLE specs ADD COLUMN skill_binding_id TEXT;
ALTER TABLE specs ADD COLUMN skill_slug TEXT;
ALTER TABLE specs ADD COLUMN skill_version TEXT;
ALTER TABLE specs ADD COLUMN template_hash TEXT;
```

- 历史行 `skill_slug IS NULL`：预览与导出按旧九段确定性渲染器回放，条目标注「旧版渲染」；不回写历史记录。

## 3. 流程图技能化

### 3.1 触发时机

- 分析版本提交成功（`requirement_versions` 落库）且 `analysis.functions.flow` 非空时，事务外异步生成；生成失败不回滚分析版本，产物登记为「生成失败」原因可查（事件日志），详情/知识库对该分析版本显示流程图不可用原因。
- 提供「重新生成」入口（需求详情过程文档、工作台分析视图），复用同一解析链。

### 3.2 图表技能解析链

复用文档技能解析的两段式思想，实现 `resolveVisualSkill({ projectId, bindingId })`：

1. 显式绑定：项目绑定、已启用、环节含「分析」或「图表」；
2. 项目内已启用的 `prd-visuals` 内置包绑定；
3. 项目内已启用的 `archify` 绑定决定渲染器形态；
4. 全部缺失 → `renderer='builtin'` 降级，响应与事件中明示降级原因。

渲染器选择：`archify` 可用 → `renderer='archify'`（按 archify workflow 契约生成可交互自包含 HTML：内联 SVG、节点/边可悬停、缩放适配）；否则 `builtin`（既有步骤清单 HTML 口径）。

### 3.3 契约映射（prd-visuals → 工作台数据）

- 候选 JSON 来源：`functions.flow` 逐条 `{from, to, action, condition}` 映射为 archify workflow 的节点/边：`from`/`to` 为节点，节点类型默认 `process`，`condition` 非空时边标注条件分支。
- 图注约定「图 标题」不带编号；标题为「功能流程图 · 分析版本 V{n}」。
- 校验：空 flow 不生成；节点名去重归一；文本全量转义；HTML 不得含 `<script>`、事件属性、`http(s)://` 或 `//` 外部引用。

### 3.4 留痕

- `llm_calls` 记录一条：stage=`flowchart`、trigger=`document`、provider=`skill-runtime`、model=`v{skill_version}`、tokens/cost=0。
- 事件日志 + 审计：操作人、需求、分析版本、渲染器、技能 slug@version、html 大小与摘要。

## 4. 需求说明书技能化

### 4.1 解析链

复用迭代说明书的 `resolveDocumentSkill`（显式绑定 → 上一版本技能 → 内置 `prd-assemble` → 项目内唯一文档技能 → 拒绝并返回候选），默认落内置 `prd-assemble`。

### 4.2 章节契约（prd-assemble 五章 + 附录 A–Q）

正文五章及工作台数据来源映射：

| 章节 | 内容 | 工作台来源 |
| --- | --- | --- |
| 1 项目概述 | 1.1 项目背景 / 1.2 项目目标 / 1.3 项目范围 | 项目档案 background/goals/system_scope + enterprise_scope |
| 2 项目需求说明 | 需求背景、目标与验收口径 | 澄清结论快照 |
| 3 功能说明 | 3.1 应用系统影响分析；3.2+ 按应用组织「应用整体功能流程说明」（内嵌对应流程图产物）与各功能名小节 | 分析四段、involved_apps、flowcharts 产物 |
| 4 应用集成说明 | 集成点方向、数据对象、触发时机 | 分析集成说明段 |
| 5 审批意见 | 评审结论与签核记录 | 评审记录 |

附录 A–Q 映射：A 需求追踪（追踪表，编号仅出现于此类表格与附录索引）、B 应用/模块影响、C 非功能需求、D 风险与待确认、E 来源索引、F 设计规范、G 图表索引（流程图版本清单 + 技能元数据）、H 原型索引、I 台账补遗（可选）、J 过程资产索引、K 需求澄清单、L 产品基线与应用架构、M 设计规范来源与确认、N 项目画像与范围、O 一致性核对、P 补充资产（可选）、Q 交互确认记录（提案与确认留痕）。无内容的可选附录整章省略，不做空壳章节。

### 4.3 模板与校验

- HTML 外壳使用技能 `artifactTemplate`，占位符仅允许 `{{docTitle}}`、`{{docSubtitle}}`、`{{toc}}`、`{{content}}`、`{{footer}}`；缺 `{{content}}` 或出现未知占位符拒绝生成。
- 模板安全校验沿用迭代说明书口径（脚本/事件属性/外部引用拒绝，技能不可关闭）。
- 内容校验：必需章节（overview、appendix-a）存在；正文无未替换占位符；编号不出现在正文叙述与标题；字节上限沿用技能声明。
- Word 导出按系统标准章节结构生成（模板只影响 HTML 的既有口径不变），导出审计记录技能 slug 与版本。

### 4.4 兼容

- 旧行（无技能字段）预览/导出走旧渲染器并标注；评审、版本发布、迭代引用关系不变。

## 5. 注册、预览与界面

- 知识库「流程图」分类改读 `flowcharts` 表（不再即时推导）；登记规则更新为「每个生成成功的流程图产物登记一条」，空 flow 的分析版本不登记。
- 需求详情过程文档：流程图条目展示分析版本、渲染器（archify 交互图 / 降级清单）、技能版本与生成时间；说明书条目展示技能版本，旧版行标注「旧版渲染」。
- 预览统一走自包含 HTML 响应（`Content-Disposition: inline`、`nosniff`、禁缓存、禁 iframe 嵌套），archify 渲染的流程图含内联 SVG 交互但无脚本执行。
- 访客可见范围规则不变（流程图随需求可见性，不单独设发布态）。

## 6. 风险与待确认

- D-001：archify 交互图的完整交互（缩放、高亮）在无脚本前提下以纯 CSS/SVG 实现，交互深度弱于技能包脚本版；口径为「可预览、可交互悬停」，不追求脚本版全量交互。
- D-002：历史流程图无持久化记录，采用惰性补登记（首次读取时按 builtin 渲染器生成并标注来源为「历史补登记」）。
