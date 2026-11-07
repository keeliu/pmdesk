# requirement-analysis Delta

## MODIFIED Requirements

### Requirement: 分析版本留存
系统 SHALL 为每次分析提交保存版本，记录版本号、变更摘要与提交人；包含功能流程步骤的分析版本 SHALL 同时触发流程图产物生成并持久化登记。

#### Scenario: 多次提交
- **WHEN** 产品经理在同一需求上多次提交分析
- **THEN** 系统按序生成版本号
- **AND** 保留任意历史版本的只读视图

#### Scenario: 版本回退
- **WHEN** 用户选择回退到历史版本
- **THEN** 系统以该版本内容生成新的提交版本
- **AND** 不删除中间版本记录

#### Scenario: 提交带流程步骤
- **WHEN** 分析版本的功能流程非空且提交成功
- **THEN** 系统按图表技能解析链生成流程图产物并持久化
- **AND** 产物记录渲染器、技能 slug、技能版本与生成人
- **AND** 生成失败不回滚分析版本，登记失败原因

## ADDED Requirements

### Requirement: 流程图技能化生成
系统 SHALL 按图表技能解析链生成流程图：项目绑定的 prd-visuals 与 archify 技能优先，缺失时降级为确定性渲染器并在产物与事件中明示；流程图为自包含 HTML，可在需求详情、知识库与工作台中预览。

#### Scenario: 技能可用
- **WHEN** 项目已启用 prd-visuals 与 archify 绑定
- **THEN** 系统按图表技能契约把功能流程映射为工作流图节点与边
- **AND** 生成可交互的自包含 HTML（内联 SVG、无脚本、无外部资源）
- **AND** 产物记录 renderer=archify 与技能版本

#### Scenario: 技能缺失降级
- **WHEN** 项目未绑定或停用了相关图表技能
- **THEN** 系统使用内置确定性渲染器生成步骤清单 HTML
- **AND** 产物记录 renderer=builtin 并标注降级原因

#### Scenario: 重新生成
- **WHEN** 用户对已存在流程图的分析版本触发重新生成
- **THEN** 系统按当前解析链重新渲染并更新产物
- **AND** 写审计与事件日志

#### Scenario: 空流程
- **WHEN** 分析版本没有功能流程步骤
- **THEN** 系统不生成流程图产物
- **AND** 详情与知识库显示流程空态

#### Scenario: 契约校验失败
- **WHEN** 流程数据无法映射为合法节点与边（如全部节点为空名）
- **THEN** 系统不产出损坏产物
- **AND** 登记失败原因并保留分析版本
