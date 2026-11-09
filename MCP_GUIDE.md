# MCP 服务使用说明

工作台助手可以把任务、备忘录、日计划与报告开放为 MCP（Model Context Protocol）工具，让本机的其他 AI agent —— 例如 Claude Desktop、Cursor、Qoder 等 —— 直接帮你查任务、记任务、改任务。所有数据仍然只存放在本机，应用不把任何内容发往外部服务。

## 这是什么

开启 MCP 服务后，工作台助手会在本机回环地址（只监听 `127.0.0.1`）启动一个 MCP 端点，对外暴露 32 个工具。AI agent 通过 MCP 协议连接它，就像连接其他 MCP 服务器一样。典型用法：

- 在 Cursor 里问「我今天还有什么没做完？」，它会调用本应用的查询工具拿真实数据回答。
- 在 Claude Desktop 里说「把这份会议要点记成任务」，它会直接在工作台里创建任务。
- 对话中的删除、清空等破坏性操作，仍然会先停下来向你确认，不会直接执行。

## 快速开始（stdio，推荐）

stdio 方式适配所有支持 MCP 的客户端，直接使用工作台助手自带的运行时，不需要另外安装 Node.js。

1. 启动工作台助手，进入 **设置 → 助手 → MCP 服务**。
2. 打开「MCP 服务」开关，确认连接状态显示「运行中」。
3. 点击「复制 stdio」，把配置粘贴进你的 MCP 客户端配置文件（例如 Claude Desktop 的 `claude_desktop_config.json`、Cursor 的 `mcp.json`），保存后重启/刷新客户端即可。

复制出来的配置长这样（命令和路径以应用实际运行位置为准，复制按钮会自动填好）：

```json
{
  "mcpServers": {
    "work-helper": {
      "command": "C:\\…\\WorkHelper.exe",
      "args": ["C:\\…\\src\\mcp\\stdio-proxy.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1", "WORK_HELPER_DATA_DIR": "C:\\…\\work-helper\\data" }
    }
  }
}
```

客户端会以 stdio 方式拉起一个轻量代理进程，代理负责把 MCP 请求转发给运行中的应用。应用没开时，代理会返回明确的错误提示，不会静默失败。

## 备选：streamable HTTP

如果你的客户端只支持 streamable HTTP，点击「复制 HTTP」拿到 URL 与 token 配置：

```json
{
  "mcpServers": {
    "work-helper": {
      "url": "http://127.0.0.1:4571/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

注意：HTTP 配置里直接包含 token，请当作密码对待，不要分享或提交到仓库。服务重启后 URL 与 token 仍然有效；只有「轮换 token」会让旧配置立即失效。

## 开放的能力（32 个工具）

工具名统一带 `workhelper_` 前缀，agent 在 `tools/list` 里能看到完整清单与参数说明：

| 分类 | 工具 | 说明 |
| --- | --- | --- |
| 查询 | `query` `stats` `suggest` `summary` `memo_query` `report` | 查任务、统计、下一步建议、今日小结、查备忘录、生成日报/周报 |
| 任务写操作 | `create` `complete` `start` `update` `child` `postpone` `archive` `split` `delete` | 创建、完成、开始、修改、加子任务、顺延、归档、拆分、删除（进回收站） |
| 备忘录 | `memo_create` `memo_pin` `memo_to_task` `memo_split` `memo_delete` | 新建、置顶、转任务、拆分、删除 |
| 组合与撤销 | `plan` `batch` `restore` `undo` | 2–5 步安全操作原子执行、批量操作、从回收站恢复、撤销上一步 |
| 日计划与专注 | `daily_plan` `daily_replan` `daily_review` `focus_start` `focus_pause` `focus_resume` `focus_interrupt` `focus_finish` | 生成/重排今日计划、每日复盘、专注时段管理 |

## 安全边界

- **默认关闭**：不开启开关就不会监听任何端口；关闭开关立即停止服务并清理发现文件。
- **只监听本机回环**：绑定 `127.0.0.1`，同时校验 `Host` 与 `Origin`，防 DNS 重绑定；外部机器无法连入。
- **Bearer token**：每个请求都要携带 token，校验使用常数时间比较；token 保存在数据目录的 `mcp-secret.json`（权限收紧到当前用户）。怀疑泄露时在设置页点「轮换 token」。
- **破坏性操作必须二次确认**：删除、清空、批量等操作第一次调用只返回 `confirmation_required`，数据不会变化，并附带 `nextCall`。agent 必须先向你复述将要发生什么、取得明确同意后才能按 `nextCall` 再调一次。配置里明确要求 agent「严禁自行确认或反复重试」。
- **删除进回收站**：删除默认进入应用回收站，可恢复；`undo` 可撤销上一步操作，若数据在撤销前又被改动会被拒绝，不会强行覆盖。
- **歧义必须追问**：只给标题且匹配多项时，工具返回候选列表，要求用户选择，不会默认操作第一项。
- **不污染应用内会话**：外部调用走独立入口，不会写入应用内 AI 助手的「待确认」状态，也不会借用「最近提到」来隐式选目标。
- **内容会经对方 agent 离开本机**：连接的 AI agent 如何处理工具结果取决于它自己的隐私策略，请只连接你信任的客户端。

## 日常管理

设置 → 助手 → MCP 服务里可以：

- **刷新**：重新读取运行状态（地址、工具数、客户端会话数）。
- **轮换 token**：旧 token 与已复制的 HTTP 配置立即失效，需要重新复制。
- **关闭开关**：停止监听并移除发现文件，已连接的客户端会收到明确的失败提示。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 代理报「未找到 MCP 端点文件」 | 应用未运行或开关未打开。先启动应用并在设置里开启 MCP 服务。 |
| 客户端报 401 / 代理报 token 可能已轮换 | token 失效。回到设置页重新复制配置。 |
| 代理报「无法连接工作台助手 MCP 服务」 | 应用没在运行，或开关被关闭。启动/开启后无需重启客户端，代理每个请求都会重新发现端点。 |
| 「MCP 会话已过期且无法自动恢复」 | 应用重启导致会话失效，代理通常会自动重新初始化；若仍失败，重启对话或重载客户端里的 MCP 服务。 |
| 端口冲突 | 首选端口 `4571` 被占用时服务会自动改用系统分配端口，端点文件与设置页会同步更新，无需处理。 |
| 怀疑 token 泄露 | 立即在设置页「轮换 token」，并检查客户端配置是否被分享过。 |

## 相关文件

- `src/mcp/protocol.js`：协议核心与 32 个工具的映射（零运行时依赖）。
- `src/mcp/http-transport.js`：应用内 HTTP 传输（鉴权、会话、SSE）。
- `src/mcp/stdio-proxy.js`：stdio ↔ HTTP 零依赖代理。
- `src/mcp/endpoint.js`：端点发现文件 `mcp-endpoint.json` 的读写。
- `src/mcp/client-config.js`：设置页展示的两种客户端配置片段。
- `tests/mcp-server.test.js`：上述全部行为的回归测试。

数据目录下的 `mcp-endpoint.json`（发现文件）与 `mcp-secret.json`（token）由应用自动维护，请勿手动编辑或提交到版本库。
