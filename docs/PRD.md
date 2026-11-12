# 轻量个人桌面助理 PRD

陪你干活的桌宠：说句话把活记成清单，干完自动成为工作记录。主线为记、排、做、收。

## 四视图

- 今天：到期任务和今日重点，无独立工作流状态。
- 清单：任务；捕获箱小入口支持新建、搜索、标签、置顶、软删除、逐条转任务。转任务原备忘录移入回收站，可一起撤销。
- 记录：今日完成、全部待办、连续完成天数、本周完成；按天倒序事件时间线；补充一句及确认删除；日报/周报生成预览。
- 设置：外观、模型、系统行为、备份及折叠回收站；MCP 默认关闭。

## 数据契约

任务保留 id/title/desc/due/status/repeat/remind/createdAt/updatedAt。pri/tags/project/children/estimatedMinutes/workLogs 隐藏但保留，不做破坏性迁移。状态只用 todo/doing/done/archived。旧子任务不自动推进。重复与提醒继续有效。

worklog.json 为 version/days/seq，天内 items 包含 id/type/at/taskId/title/note。开始和完成任务自动写快照，同一完成操作不重复写；任务删除不删除历史。手动补充允许按日新增、确认删除；不做富文本、图片附件及独立标签。使用本地日期、原子写入，与任务事务一起回滚及撤销。

## 对话

11 个主意图：create/query/complete/delete/update/batch/memo_create/memo_query/record_query/summary/chat，另有 unknown 兜底和 memo_to_task 兼容动作。开始、改期、归档并入 update。查询不得误写；模糊匹配追问；危险操作确认；撤销链路保留。复杂与批量操作走对话。

## 下线范围

看板、日历、统计仪表盘、手动批量多选、子任务/项目/工时 UI、独立 task-agent 窗口、daily-copilot、workflow-planner、备忘录拆分批量导入。

## 不变边界

回收站、撤销、确认、提醒、重复任务、日期语义、原子写入、本地优先、contextIsolation、托盘、快捷键、自启、通知、桌宠及 MCP。src/mcp 与其测试不改。外部模型仅显式启用时调用。

## 验收

每阶段 npm test 全绿、入口语法检查及 diff 检查后提交和打 tag。自动测试、真实 Electron 交互、截图视觉检查与性能采样分别记录，不互相替代。开发评估器不随产品发布。
