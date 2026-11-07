# OpenSpec 工作约定

本目录遵循 OpenSpec 规范组织产品与系统规格。任何改动先建变更，再写增量规格，评审通过后归档并合并到基线。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `project.md` | 项目背景、目标、技术栈、架构约束、领域术语与开发约定 |
| `specs/<capability>/spec.md` | 已生效的系统行为基线，只反映当前真实系统 |
| `changes/<change-id>/proposal.md` | 变更动机、改动清单与影响范围 |
| `changes/<change-id>/design.md` | 技术决策、架构、权衡与风险 |
| `changes/<change-id>/tasks.md` | 可勾选的实施任务与规格覆盖对照 |
| `changes/<change-id>/specs/<capability>/spec.md` | 本次变更的增量规格 |

## 变更生命周期

1. **提案**：新建 `changes/<change-id>/`，写 `proposal.md`，列出受影响能力。
2. **设计**：在 `design.md` 记录关键决策与备选方案，未决问题集中列出。
3. **增量规格**：为每个受影响能力写 `specs/<capability>/spec.md`，使用 `## ADDED / MODIFIED / REMOVED Requirements`。
4. **实施**：按 `tasks.md` 推进，任务完成后勾选；实现与规格不一致时先改规格再改代码。
5. **归档**：全部任务完成后，把增量合并进 `specs/` 基线，将变更目录移入 `changes/archive/`。

## 规格书写规则

- 每条需求以 `### Requirement: <名称>` 开头，正文用 `SHALL` 描述系统义务，一句话说清"必须做到什么"。
- 每条需求至少一个 `#### Scenario: <场景>`，场景内使用 `- **WHEN**`、`- **THEN**`、`- **AND**` 描述触发与结果。
- 场景必须可验证：给出具体输入、可观察的结果与边界条件，避免"合理处理""酌情"等表述。
- 一个能力对应一个目录，目录名用小写连字符；能力名与 `proposal.md` 的影响表保持一致。
- 增量文件只写本次变化，不复制基线全文；修改既有需求使用 `## MODIFIED Requirements` 并写出完整需求正文。

## 校验清单

- 每个 `### Requirement:` 至少 1 个 `#### Scenario:`。
- 每个场景同时包含 WHEN 与 THEN。
- 增量文件以 `## ADDED Requirements`（或其他 delta 段）开头。
- `proposal.md` 影响表中的能力与 `specs/` 下目录一一对应。
- `tasks.md` 的任务能覆盖全部能力，且无未归属任务。

## 命名与语言

- 能力、变更目录使用英文小写连字符；需求与场景标题使用中文。
- 需求编号 `REQ-<项目号>-<流水号>` 只在需求确认后分配，规格文档中引用需求时使用编号而非标题。
- 规格中不写具体企业、组织或供应商名称，相关内容由项目画像在运行时提供。
