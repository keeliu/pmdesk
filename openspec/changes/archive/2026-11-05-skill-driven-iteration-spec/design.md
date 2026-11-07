# 设计说明

## 1. 技能环节与内置技能

### 1.1 新增「说明书」环节

技能适用环节在既有 `clarify / analysis / prototype / review / change` 基础上新增 `spec`，界面名称为「说明书」。该环节不进入需求状态映射，也不出现在工作台会话的技能候选里；它只用于标记「可以参与文档组装」的技能。

| 项 | 现状 | 调整后 |
| --- | --- | --- |
| 环节取值 | 五个需求环节 | 六个：增加 `spec`（说明书） |
| 技能管理页 | 五组复选框 | 六组复选框，新增「说明书」 |
| 会话技能候选 | 按当前需求环节过滤 | 不含 `spec`，文档技能不会被会话自动调用 |
| 手动执行接口 | 可执行任意环节技能 | `spec` 技能只能由迭代说明书生成接口调用 |

技能未配置任何环节时仍表示「由大模型识别」，但这只对会话环节有效；文档组装只接受明确配置了 `spec` 环节的技能。

### 1.2 内置说明书组装技能

| 字段 | 值 |
| --- | --- |
| `slug` | `spec-assemble` |
| `name` | 说明书组装 |
| `version` | `1.0.0` |
| `stages` | `["spec"]` |
| `description` | 按 prd-assemble 契约把迭代内需求分析内容组装为单文件自包含 HTML 与 Word |
| `artifact_template` | 默认单文件 HTML 外壳，含 `{{docTitle}}`、`{{docSubtitle}}`、`{{toc}}`、`{{content}}`、`{{footer}}` 五个占位符 |
| `validation` | 必需章节、逐需求章节与锚点、禁止外部资源、禁止脚本 |

初始化规则：

- 服务启动时幂等检查内置技能定义，缺失则插入；不覆盖同 slug 的既有技能包，避免覆盖用户修改。
- 内置技能插入后复用现有 `ensureBuiltinBindings()`，为所有存量项目补齐绑定；新建项目沿用现有创建时绑定逻辑。
- 内置绑定可以在技能管理中停用或调整环节，但不能移除；停用后说明书生成被阻断并提示启用。

## 2. 生成流程

### 2.1 技能解析

生成请求提交 `mode` 与可选 `skillBindingId`。解析顺序固定：

1. 请求显式提交 `skillBindingId`：校验绑定属于当前项目、绑定启用、技能包启用、来源可用、环节包含 `spec`；任一不满足直接拒绝。
2. 未提交但存在上一版本且其技能仍可用：使用上一版本技能，保证重新生成口径一致。
3. 未提交且无可用上一版本技能：若内置 `spec-assemble` 可用则使用内置技能。
4. 仍无法确定：若项目内仅有一个可用文档技能则使用它；否则返回需要选择的错误，并附候选列表。

生成弹窗始终提交 `skillBindingId`，上述 2–4 仅用于兼容直接调用接口的客户端。

### 2.2 组装与校验

文档组装是**确定性整合**，不调用大模型：分析、原型、评审与变更内容已经由上游技能产出，组装阶段只负责聚合、排版与校验，符合 prd-assemble「只做机械整合」的约束。因此：

- 令牌与成本为 0，但仍写入执行记录：`provider=skill-runtime`、`stage=spec`、`trigger_type=document`，与其它技能调用的可观测口径一致。
- 生成事件与审计记录技能绑定、技能 slug、版本、模板摘要和产物信息。

渲染步骤：

1. 收集纳入需求：沿用现有规则，迭代内状态不为「待澄清」「已丢弃」的需求。
2. 生成标准内容：迭代总览、逐需求章节、附录 A–D，以及目录和页脚。
3. 读取技能模板：`artifact_template` 非空时作为 HTML 外壳；为空时使用内置默认外壳。模板必须是完整 HTML 文档。
4. 占位符替换：只替换约定占位符，未知 `{{...}}` 一律拒绝；`{{content}}` 必须存在，其余四个可省略。
5. 校验：章节数、`data-req-id` 锚点数与纳入需求数一致；技能声明的必需章节 id 全部存在；HTML 不含 `<script>`、事件属性（`on*=`）、`http(s)://` 与协议相对 `//` 外部引用；HTML 体积不超过 10 MB。
6. 生成 Word：按系统标准章节结构由同一份源数据构建，不解析 HTML；章节数与需求条目数再次校验。
7. 固化产物：计算 HTML 与 Word 的 SHA-256；Word 写入 `data/files`；在同一事务中插入版本记录。文件写入失败或入库失败均清理已写文件，不留下半成品版本。

### 2.3 模板契约

```json
{
  "slug": "spec-assemble",
  "name": "说明书组装",
  "version": "1.0.0",
  "stages": ["spec"],
  "artifactTemplate": "<!doctype html>...{{toc}}...{{content}}...",
  "validation": {
    "requiredSections": ["overview", "appendix-a", "appendix-b", "appendix-c", "appendix-d"],
    "requireChapterPerRequirement": true
  }
}
```

| 占位符 | 注入内容 |
| --- | --- |
| `{{docTitle}}` | `<迭代名称> 迭代需求分析说明书`，已转义 |
| `{{docSubtitle}}` | 项目、迭代周期、版本、模式、生成日期，已转义 |
| `{{toc}}` | 左侧目录链接 |
| `{{content}}` | 迭代总览 + 全部需求章节 + 附录 A–D |
| `{{footer}}` | 标准页脚（生成技能与版本） |

安全边界由服务端强制，不因技能声明而放宽：

- 始终禁止脚本、事件属性与外部资源；`validation` 只能追加必需章节，不能关闭这些检查。
- 模板只做字符串占位符替换，不执行模板表达式，不读取模板以外的文件。
- 自定义模板只影响 HTML 外观；Word 始终按系统标准结构生成，避免无法从任意 HTML 反推 Word 结构。

## 3. 数据模型

`iteration_specs` 增加可空列，历史行保持 `NULL`：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `skill_binding_id` | TEXT | 项目技能绑定 id |
| `skill_slug` | TEXT | 生成时技能 slug |
| `skill_version` | TEXT | 生成时技能版本 |
| `template_hash` | TEXT | 技能模板（无模板时为空串）的 SHA-256 |
| `docx_file` | TEXT | 固化 Word 在 `data/files` 下的文件名 |
| `docx_size` | INTEGER | Word 字节数 |
| `docx_sha256` | TEXT | Word SHA-256 |

迁移为增量加列，幂等执行；不回填历史行。

## 4. 接口契约

### 4.1 生成

`POST /api/projects/:projectId/iterations/:iterationId/specs/generate`

```json
{ "mode": "draft", "skillBindingId": "PSK-..." }
```

成功 `201`：

```json
{
  "id": "ITSPEC-...",
  "version": 2,
  "mode": "draft",
  "status": "draft",
  "requirementCount": 1,
  "missing": [],
  "skill": { "bindingId": "PSK-...", "slug": "spec-assemble", "name": "说明书组装", "version": "1.0.0" },
  "artifacts": {
    "html": { "size": 48213, "sha256": "..." },
    "word": { "fileName": "F-...docx", "size": 8120, "sha256": "..." }
  }
}
```

错误：

| 场景 | 状态码 | 错误码 |
| --- | --- | --- |
| 项目没有可用文档技能 | 400 | `SPEC_SKILL_REQUIRED` |
| 技能停用或来源不可用 | 403 | `SPEC_SKILL_UNAVAILABLE` |
| 技能未配置说明书环节 | 400 | `SPEC_SKILL_STAGE_MISMATCH` |
| 模板缺少 `{{content}}` 或含未知占位符 | 400 | `SPEC_TEMPLATE_INVALID` |
| 模板含脚本或外部资源 | 400 | `SPEC_TEMPLATE_UNSAFE` |
| 章节/锚点与需求数不一致 | 500 | `SPEC_RENDER_INCONSISTENT` |
| Word 生成或文件写入失败 | 500 | `SPEC_ARTIFACT_FAILED` |

正式版缺项、迭代为空等既有错误保持不变。

### 4.2 版本列表

`GET /api/projects/:projectId/iterations/:iterationId/specs` 增加返回 `skill_slug`、`skill_version`、`docx_size`，用于列表展示与下载可用性判断；不返回 Word 文件内容。

### 4.3 预览 HTML

`GET /api/iteration-specs/:id/preview`

- `Content-Type: text/html; charset=utf-8`
- `Content-Disposition: inline; filename*=UTF-8''<迭代名称>-需求分析说明书-V<版本>.html`
- `Cache-Control: no-store`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'`

前端以普通链接在新标签页打开该地址，不再嵌 iframe。访客仅可打开已发布版本，沿用现有权限校验。

### 4.4 Word 下载

`GET /api/iteration-specs/:id/docx`

- 新版本：直接返回生成时固化的 Word 文件，响应前核对文件存在与大小，缺失时返回 `SPEC_ARTIFACT_FAILED` 而不是静默重建。
- 历史版本：`docx_file` 为空时按内置技能模板与标准结构即时生成，返回但不回写记录，并在导出审计中标注 `fallback=true`。
- 导出记录与审计沿用现有字段，补充 `skillSlug`、`skillVersion`、`docxSha256`。

### 4.5 PDF 与 Markdown

保持不变：PDF 继续由存储的 HTML 打印，Markdown 继续返回存储内容；两者均属于次要导出，不作为本次技能驱动的验收产物。

## 5. 界面行为

### 5.1 生成弹窗

- 读取项目技能列表，筛选「启用且环节包含说明书」的绑定作为候选。
- 候选以单选列表展示：名称、版本、来源（内置/导入/引用）、来源项目；默认选中上一版本技能，其次内置技能，再次第一个候选。
- 无候选时阻断生成，提示「请先在设置 > 技能管理中添加或启用配置了『说明书』环节的技能」，并提供跳转。
- 生成按钮文案与草稿/正式版门禁不变；提交时携带 `skillBindingId`。
- 成功提示包含技能名称与版本，例如「已使用『说明书组装 v1.0.0』生成草稿版 V2（HTML + Word）」。

### 5.2 版本列表

- 「预览」改为链接按钮，`target="_blank" rel="noopener noreferrer"`，直接打开 HTML。
- Word 按钮保留；PDF、Markdown 保持现有入口。
- 生成时间下方补充技能标识，例如 `说明书组装 v1.0.0`，历史版本显示 `未记录技能`。
- 移除预览弹窗及其 iframe。

### 5.3 重新生成

「生成新版本」复用同一弹窗与同一解析逻辑，默认选中上一版本技能；若该技能已停用或来源不可用，候选列表不包含它，必须在剩余候选中重新选择，不静默切换。

## 6. 兼容与迁移

- 历史 `iteration_specs` 行不需要回填；预览直接读存量 HTML，列表显示「未记录技能」，Word 走即时生成回退。
- 生成接口在不传 `skillBindingId` 时保持可调用，按第 2.1 节解析，避免破坏既有脚本与场景测试。
- 既有 `GET /api/iteration-specs/:id/preview` 路径不变，只调整响应头与前端打开方式。
- 新增内置技能后，存量项目首次启动时自动获得绑定；若项目已导入同 slug 技能，保留用户技能，不覆盖、不重复绑定。
- 不改变 `markIterationSpecsStale`、版本号递增与正式版发布状态规则。

## 7. 关键决策

| 决策 | 结论 | 备选与原因 |
| --- | --- | --- |
| 文档是否由大模型生成 | 否，确定性组装 | 大模型整篇生成不可校验、成本高、与已确认分析易冲突；prd-assemble 本身只做机械整合 |
| 技能如何参与 | 环节标记 + HTML 模板 + 校验规则 | 只按 slug 硬编码无法支持导入技能；让技能完全控制内容会破坏一致性 |
| Word 生成时机 | 生成时固化 | 下载时临时拼装会受后续数据变化影响，历史版本不可重现 |
| 预览方式 | 新标签页直接打开 HTML | iframe 受限、无法保存/转发；直接打开最符合「预览 HTML 文件」的预期 |
| 多技能如何选择 | 显式选择，默认沿用上一版本 | 自动挑第一个会导致重新生成口径漂移；显式选择可追溯 |
| 单需求说明书是否一起改 | 本期不改 | 控制影响面；迭代级验证后再复用同一套文档技能与预览方式 |

## 8. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 自定义模板破坏结构 | HTML 缺章节或锚点 | 强制 `{{content}}`、必需章节与锚点校验，失败不生成版本 |
| Word 与 HTML 结构不一致 | 交付物不一致 | Word 由同一份源数据构建并做章节数校验；自定义模板仅影响 HTML 外观并在文档中说明 |
| 内置技能被停用 | 无法生成 | 生成前明确阻断并提示启用；候选列表只展示可用技能 |
| Word 文件丢失 | 下载失败 | 下载前校验存在与大小；历史版本支持即时回退生成；新版本明确报错 |
| 存量数据无技能记录 | 列表信息缺失 | 显示「未记录技能」，不影响预览与下载 |
| 预览 HTML 安全 | XSS 或外部请求 | 服务端转义、模板脚本与外部资源校验、CSP、`nosniff` 与 `DENY` 多重约束 |

## 9. 测试计划

- 生成：使用内置技能生成草稿版，断言版本记录技能 slug/版本、HTML 含技能页脚、Word 文件存在且大小与 SHA-256 匹配。
- 重新生成：不传技能时沿用上一版本；停用上一版本技能后拒绝或要求重选；显式选择自定义技能后模板生效。
- 模板校验：缺少 `{{content}}`、未知占位符、含 `<script>`、含 `https://` 外部资源的模板均被拒绝且不产生版本。
- 一致性：章节数或锚点数与需求数不一致时拒绝生成；Word 章节数校验失败时不落库。
- 预览：响应头包含 `inline`、`no-store`、CSP、`X-Frame-Options: DENY`；未登录/访客访问草稿被拒绝；新标签页可打开并渲染。
- 下载：新版本返回固化文件；历史版本走回退生成并记录 `fallback=true`；导出审计包含技能信息。
- 兼容：既有场景测试中的生成调用不传技能仍可通过；历史版本仍可预览与导出。
- 前端：类型检查、构建、浏览器走查生成弹窗技能选择、成功提示、版本列表技能标识与新标签页预览。
