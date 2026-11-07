# Tasks：产物技能化（流程图 + 需求说明书）

## 1. 数据层

- [x] 1.1 新增 `flowcharts` 表（requirement_id + analysis_version 唯一，含 renderer/skill 溯源/source_json/html/摘要字段）
- [x] 1.2 `specs` 表新增 skill_binding_id、skill_slug、skill_version、template_hash 可空列（历史行保持 NULL）
- [x] 1.3 迁移幂等：重启与重建均不产生重复表或重复列

## 2. 流程图技能化

- [x] 2.1 实现 `resolveVisualSkill` 解析链（显式绑定 → prd-visuals → archify → builtin 降级）
- [x] 2.2 实现 archify workflow 契约渲染器（functions.flow → 节点/边，自包含内联 SVG，可悬停交互，无脚本无外部资源）
- [x] 2.3 既有步骤清单渲染器收敛为 builtin 降级路径并标注降级原因
- [x] 2.4 分析版本提交成功后异步生成流程图并持久化；失败登记原因不回滚分析版本
- [x] 2.5 重新生成入口与接口（详情/工作台），写事件与审计；llm_calls 记录 stage=flowchart
- [x] 2.6 历史分析版本读取时惰性补登记（renderer=builtin，标注「历史补登记」）

## 3. 需求说明书技能化

- [x] 3.1 需求说明书生成接入 resolveDocumentSkill（与迭代说明书同链，默认内置 prd-assemble）
- [x] 3.2 按 prd-assemble 五章 + 附录 A–Q 实现组装器与章节-数据来源映射（见 design.md §4.2）
- [x] 3.3 HTML 外壳按技能 artifactTemplate 占位符契约渲染并通过模板安全校验（脚本/事件属性/外部引用拒绝）
- [x] 3.4 内容校验：必需章节、无未替换占位符、编号不进正文叙述与标题、字节上限
- [x] 3.5 specs 行写入技能溯源字段；llm_calls 与审计留痕（阶段「说明书」、触发「文档生成」）
- [x] 3.6 历史无技能版本按旧九段渲染器回放并标注「旧版渲染」
- [x] 3.7 Word 导出按标准章节结构生成，导出审计记录技能 slug 与版本

## 4. 知识库与详情集成

- [x] 4.1 知识库流程图分类改读 flowcharts 表（含渲染器与技能元数据展示）
- [x] 4.2 流程图与说明书预览走统一自包含 HTML 响应（inline/nosniff/禁缓存/禁 iframe）
- [x] 4.3 需求详情过程文档展示流程图渲染器/技能版本、说明书技能版本与重新生成入口
- [x] 4.4 访客可见范围规则保持不变并回归验证

## 5. 验证与归档

- [x] 5.1 补充场景测试（技能解析链、降级、章节契约、编号不进正文、历史回放、补登记）
- [x] 5.2 `npx tsc --noEmit`、`npm test`、`npm run build` 全绿
- [x] 5.3 浏览器走查：分析提交→流程图生成与预览→说明书生成（五章+附录）→知识库/详情→导出
- [x] 5.4 规格合并入 `openspec/specs/` 基线并归档本变更
