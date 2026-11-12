# 轻量化验收记录（2026-11-12）

接手时 HEAD 为 29ba8ff（阶段 2），阶段 3 留有八个未提交文件。首次 npm test：333/341 通过。保留接手改动并继续完成。

## 分阶段提交与测试

| 阶段 | 提交 | tag | 验证 |
| --- | --- | --- | --- |
| 0 契约 | 274deb7 | phase0-contract（接手后补挂原提交） | 改造前基线 391/391 |
| 1 外延下线 | 47ff058 | phase1-extensions-off | 隔离导出原 tag，357/357 |
| 2 模型与意图 | 29ba8ff | phase2-todolist-intents | 隔离导出原 tag，352/352 |
| 3 四视图 | 1f524c7 | phase3-four-views | 提交前 341/341 |
| 4 工作记录 | 4379f10 | phase4-work-records | 提交前 345/345 |
| 5 收尾 | 本文所在提交 | phase5-lightweight | 提交前 347/347 |

历史 tag 导出副本中的 app.js 带 CRLF，旧结构测试以 LF 正则取代码块，基线首次为 390/391；仅对临时副本转换 LF 后 391/391。阶段 1、2 同样在副本规范换行后复测，不改历史提交。最终工作树的 npm test 直接运行，无此预处理。

当前入口 node --check 与 git diff --check 全部通过。新增回归覆盖工作记录完成幂等、重复生成、开始事件、删除后的标题快照、事务失败及撤销、手动条目边界、备份恢复、捕获箱转任务及整体撤销、记录页实际渲染和报告交互。

## 实际 Electron 验证

scripts/lightweight-qa.js 使用独立临时 profile，不读取生产数据。创建、开始、完成任务，增加/删除手动记录，读取真实 IPC，进入四视图；浅深色各两个请求窗口宽度截图，共 16 张；CDP 模拟 prefers-reduced-motion。无捕获到的渲染 console error。对浅色清单和深色记录截图做了人工图像检查。请求 650px 会被产品 minWidth=900 限制，实际验证的是 900px 下限，未宣称支持 650px 窗口。

最终截图及 result.json 位于 %TEMP%/work-helper-lightweight-final。早期截图遇到后台动画节流，QA 脚本现禁用后台节流并等待动画完成，重新截图后正文正常显示。

## 资源测量与处置

同机、同 Electron 运行时、独立 profile，固定空闲采样窗口（加载后等待约 2 秒）。一次基线/改造后配对采样：

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| 启动测量（脚本开始至首屏加载，含固定 500ms 等待） | 878 ms | 921 ms |
| 空闲进程工作集求和 | 567.58 MiB | 557.65 MiB |
| 已创建窗口数 | 3 | 3 |

内存来自 Electron app.getAppMetrics 的进程 workingSetSize，非任务管理器人工读数；共享页面可能重复计数。样本仅一次，不能证明启动提升或稳定内存收益。旧 task-agent 按需创建，故基线空闲窗口数也是 3，不把模块删除虚报为常驻少一个窗口。

同运行时、相同 ZIP 参数、仅 src 与 package.json 的发布载荷比较由 scripts/measure-lightweight.py 生成；完整结果见旁边 lightweight-package-measurements.json。它是部署 ZIP/解压载荷测量，不是安装器实测。Electron runtime 约 281 MB，体积主要由运行时决定，功能裁剪对完整包的收益有限。

- renderAll 仅渲染活动主视图，避免后台重复构造全部视图。
- 桌宠精灵图为 1536×1872 单帧图集，原文件 2,063,498 bytes；无损重编码 2,067,750 bytes 且像素一致，收益为负，因此保留原资源。
- 发布脚本只复制 src 与 package.json；agent-eval、测试、语料和 QA 脚本留在开发侧，不随包发布。

## 数据与契约

未做破坏性任务迁移。隐藏字段继续读写。工作记录使用独立 worklog.json，任务事件和记录纳入同一事务快照及撤销检查；新增字段纳入现有备份，旧备份无字段时保留当前记录。文件继续临时写入再 rename；跨文件事务沿用现有进程内回滚机制，不宣称提供断电后的跨文件日志恢复。

仓库 docs/PRD.md 为可版本化终稿，工作区外 personal-ai-assistant-prd/personal-ai-assistant-prd.html 同步精简；外部 HTML 不在本 Git 仓库内，无法由本仓库提交收录。AGENTS.md 已移除旧子任务推进和多选规则。

11 个主意图 + unknown；memo_to_task 保留为捕获箱查询后兼容动作。src/mcp 自 baseline 未变；接手前阶段 1、2 已更新 MCP 测试以适应共享工具注册表的收缩（32→13 工具），本次未进一步修改 MCP 实现或测试。默认关闭、鉴权及调用链回归通过；不把工具数量描述为与旧版相同。

全部提交和 tag 仅在本地，未推送。临时测试数据、截图、对比 ZIP 均不纳入提交。
