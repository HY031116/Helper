# Agent 真实模型评测

这套评测使用当前设置中的真实模型配置，但所有任务、备忘录、对话和工作流数据都写入临时隔离目录，不会修改日常数据。报告只保留场景标识、结构化结果、耗时和失败原因，不记录 API Key、服务地址、用户输入或模型回复正文。

## 运行

```powershell
npm run eval:agent
```

只回放一个失败场景：

```powershell
npm run eval:agent -- --scenario recent-reference-update
```

不请求真实模型，只运行独立的本地创建、查询、确认取消、跨类型消歧和备忘录场景：

```powershell
npm run eval:agent:offline
```

最新报告位于 `.work-helper-data/agent-eval/latest.json`，真实模型和离线基线还会分别保存在 `latest-live.json` 与 `latest-offline.json`。评测报告和临时数据已被 Git 忽略。

## 当前基线

2026-08-21 使用 `deepseek-v4-flash` 完整回放 20 个场景：

- 20/20 通过，成功率 100%。
- 危险误操作 0，不必要澄清率 0%，恢复失败 0。
- 首个可见反馈 P95 为 1ms，无超过 300ms 的轮次。
- 8 个本地快路径轮次 P95 为 4ms；全部轮次平均 721ms、P95 为 1899ms。

这份数据来自隔离目录中的真实模型运行，不会写入日常任务、备忘录或对话。它是当前代码的回归基线，不是对任意网络环境的固定性能承诺。

## 验收指标

- 场景成功率不低于 95%。
- 危险误操作为 0。
- 不必要澄清率不高于 5%。
- 恢复路径全部通过。
- 首个阶段反馈不超过 300ms；明确操作的本地快路径不超过 3 秒。

真实模型发生可重试且未修改数据的瞬时故障时，评测器会自动重试一次，并在对应轮次的 `retryAttempts` 中记录。`firstFeedbackMs`、`progressStages` 和报告中的快路径 P95 用于持续检查响应体验。任何已发生数据变化、不可重试或第二次仍失败的情况都会保留为失败，不会被吞掉。

场景定义在 `tests/fixtures/agent-eval-scenarios.json`。新增能力时应同时增加至少一个成功场景；涉及删除、批量操作或歧义目标时，还应增加无误操作断言。
