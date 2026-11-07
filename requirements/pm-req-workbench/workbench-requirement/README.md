# AI驱动需求管理工作台建设 · 需求工作区

> 项目编号：`PRJ-20261104-140723-b3f4` ｜ 类型：新功能 ｜ 创建：2026-11-04
> 需求来源：01-产品需求分析
> 主项目：C:\Users\keeliu\Documents\Qoder\2026-11-04\076a8ff4\requirements\pm-req-workbench
> 直接上级：C:\Users\keeliu\Documents\Qoder\2026-11-04\076a8ff4\requirements\pm-req-workbench
> 本目录保存从项目画像到 Word / HTML 交付的全链路过程产物。不要删除 `project.json`，它是一切状态与质量门的依据。

## 目录导航

| 目录 | 内容 | 主要技能 |
| --- | --- | --- |
| `interaction-log.json` | 全部弹框确认/选择与资料请求记录（POP-xxx） | 各阶段 |
| `00-profile/` | 项目画像、画像更新提案 | `prd-profile` |
| `01-discovery/` | 需求澄清单、澄清问答、需求简报 | `prd-discovery` |
| `02-context/` | 继承基线的使用记录、知识库/历史资料、来源索引 | `prd-context` |
| `03-design/` | 设计规范采用记录、补充令牌、参考截图 | `prd-design-spec` |
| `04-analysis/` | 结构化需求分析、信息架构、追踪与一致性 JSON | `prd-analysis` |
| `05-visuals/` | Mermaid/Archify 源码、图表 HTML 与截图 | `prd-visuals` |
| `06-prototypes/` | 应用-模块-功能 HTML、截图、原型索引 | `prd-prototype` |
| `07-deliverables/` | 需求分析说明书 Markdown / HTML / Word | `prd-assemble` |
| `08-quality/` | QA 报告、问题台账、复审记录 | `prd-quality` |

## 阶段顺序与质量门

```text
项目画像 → 需求澄清 → 上下文与资料 → 设计规范 → 结构化分析 → 图表 → 原型 → 组装 → 质检
```

- 项目画像必须先经用户确认，才进入需求澄清。
- **强制弹框**：需要用户确认或选择时必须调用宿主弹框工具（Qoder 为 `AskUserQuestion`），并在 `interaction-log.json` 记录问题、选项、选择与结论；正文提问不算完成。
- **资料请求**：需要用户提供资料时必须弹框，选项固定为 `直接跳过 / 现在提供 / 稍后提供`，分别登记缺口、摄入来源或延期计划。
- 产品基线与设计规范是主项目通用知识，本需求只登记采用与差异，不复制主项目文件。
- 每个 UI 功能必须有原型页面与截图，并与图表、正文共用同一组状态、交互和内容锚点。
- 系统范围与企业范围在画像、简报、分析正文与最终附录中保持一致。
- Word 与 HTML 必须由同一份最终 Markdown 构建，构建报告需达到 100% 图表/原型覆盖。

## 命名速记

- 需求项：`REQ-001`；功能：`FUN-001`；系统：`APP-001`；模块：`MOD-001`；集成：`INT-001`；实体：`ENT-001`；弹框记录：`POP-001`。
- 图表：`D01-标题.mmd/.html/.png`；Archify 源为 `D01-标题.json`。
- 原型页面：`应用名-模块名-功能名.html`，截图同名 `.png`。
- 设计规范：主项目 `设计规范/<系统标识>-design.md`；本需求 `03-design/design-decision.json` 登记采用关系。
