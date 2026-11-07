# ai-orchestration Delta

## ADDED Requirements

### Requirement: 图表技能解析与降级
系统 SHALL 在生成流程图时按图表技能解析链确定渲染方式：显式绑定 → 项目内已启用的 prd-visuals → archify 决定渲染器形态 → 内置确定性渲染器降级；降级与技能缺失必须在产物、事件与执行记录中明示，不得静默切换。

#### Scenario: 技能绑定可用
- **WHEN** 项目已启用 prd-visuals 与 archify 绑定
- **THEN** 系统按图表技能契约渲染 workflow 类型工作流图
- **AND** 产物记录 renderer=archify、技能 slug 与技能版本

#### Scenario: 显式绑定校验
- **WHEN** 生成请求携带技能绑定标识
- **THEN** 系统校验绑定属于当前项目、已启用且适用环节含「分析」或「图表」
- **AND** 校验失败时拒绝该绑定并按解析链继续解析

#### Scenario: 技能缺失降级
- **WHEN** 未绑定或停用了图表技能
- **THEN** 系统使用 renderer=builtin 确定性渲染
- **AND** 在响应、事件与执行记录中标注降级原因

#### Scenario: 执行留痕
- **WHEN** 流程图生成成功或降级生成
- **THEN** 系统写入技能执行记录（阶段「流程图」、触发方式「文档生成」、令牌与成本为 0）
- **AND** 审计记录操作人、需求、分析版本、渲染器与技能信息
