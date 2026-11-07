# 产品经理需求管理工作台 · 主项目工作区

> 项目编号：`PRJ-20261104-140138-1b89` ｜ 类型：从 0 到 1 的项目 ｜ 创建：2026-11-04
> 本目录保存项目画像、共享产品基线、共享设计规范、子项目与需求。主项目范围内的需求必须遵守这里的通用知识。

## 目录导航

| 目录 | 内容 |
| --- | --- |
| `项目画像/` | 项目基本信息、组织、干系人、系统模块、系统范围与企业范围 |
| `产品基线/` | 按系统维护的产品基线，含版本与变更记录 |
| `设计规范/` | 设计规范、设计令牌、设计决策与参考截图 |
| `子项目/` | 子项目容器，可继续向下挂需求 |
| `<需求>/` | 需求项目，含 00-profile 至 08-quality 九个阶段 |

## 继承规则

- 子项目与需求继承主项目的 `产品基线/` 与 `设计规范/`；不得在本地复制一份通用规范。
- 子项目可维护自己的 `项目画像/`，与主项目冲突时以子项目本期决策为准，并在变更记录中说明。
- 需求只记录对通用知识的采用关系与本期差异；差异必须登记为补充令牌或补充基线。

## 常用命令

```text
python prdctl.py status --project "C:\Users\keeliu\Documents\Qoder\2026-11-04\076a8ff4\requirements\pm-req-workbench"
python prdctl.py profile --project "C:\Users\keeliu\Documents\Qoder\2026-11-04\076a8ff4\requirements\pm-req-workbench"
python prdctl.py init-subproject <子项目名称> --container "C:\Users\keeliu\Documents\Qoder\2026-11-04\076a8ff4\requirements\pm-req-workbench" --type subproject_iteration
python prdctl.py init <需求名称> --container "C:\Users\keeliu\Documents\Qoder\2026-11-04\076a8ff4\requirements\pm-req-workbench" --source <需求文档>
```
