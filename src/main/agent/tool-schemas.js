'use strict';

/**
 * Agent 工具清单（OpenAI function-calling 格式）。
 * name 与 tool-registry 的 intent key 一一对应，params 由模型生成后直接交给 execute()。
 * 每个 schema 里的参数名必须与各 handler 实际读取的 params 字段保持一致。
 * 阶段 2 收缩：stats/suggest 并入 query 与 chat，start/postpone/archive/split/child 并入 update，
 * memo_pin/memo_split/memo_delete 下线（备忘录只保留捕获箱级操作），新增 record_query。
 * pri/tags/project/estimatedMinutes 等字段仅 UI 隐藏，AI 与数据层继续可用。
 */
const AGENT_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'query',
      description: '查询任务列表。支持按标签、优先级（1紧急/2普通/3低）、状态（todo/doing/done/archived）、项目、截止日筛选。回答「我有哪些任务」「完成了多少」类问题前先用它拿实时数据。',
      parameters: {
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' }, description: '标签过滤，如 ["工作"]' },
          pri: { type: 'integer', description: '优先级过滤：1=紧急 2=普通 3=低' },
          status: { type: 'string', description: '状态过滤' },
          project: { type: 'string', description: '项目名过滤' },
          text: { type: 'string', description: '用户的原始查询语句' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'record_query',
      description: '查询工作记录：今天（或指定日期/周期）做了什么，完成与推进的任务。回答「今天干了啥」「生成今日日报」「整理本周周报」类问题，只读不改数据。',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', description: 'daily=按日（默认），weekly=按周（用户说周报/本周/上周时）' },
          offset: { type: 'integer', description: '周期偏移：-1=昨天/上周，0=今天/本周，1=明天/下周' },
          date: { type: 'string', description: '可选，日期 YYYY-MM-DD，缺省为今天' },
          text: { type: 'string', description: '用户的原始语句' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'summary',
      description: '总结当前任务与工作进展概况。',
      parameters: { type: 'object', properties: { text: { type: 'string', description: '用户原始语句' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create',
      description: '创建一个新任务。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务标题（必填），如「下午3点 交周报」' },
          pri: { type: 'integer', description: '优先级：1=紧急 2=普通 3=低，默认 2' },
          due: { type: 'string', description: '截止时间，如 2026-08-28 15:00' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表' },
          estimatedMinutes: { type: 'integer', description: '预估分钟数' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'complete',
      description: '把一个任务标记为完成。需要 target（任务标题，可用模糊匹配）或 taskId。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '任务标题或关键词' },
          taskId: { type: 'string', description: '任务 ID（已知时优先用）' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update',
      description: '修改任务：状态（开始/完成）、改期（如推到明天）、优先级、标签、项目、备注、归档等。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '任务标题或关键词' },
          taskId: { type: 'string', description: '任务 ID' },
          pri: { type: 'integer', description: '新优先级' },
          due: { type: 'string', description: '新截止时间' },
          tags: { type: 'array', items: { type: 'string' }, description: '新标签' },
          project: { type: 'string', description: '新项目名' },
          note: { type: 'string', description: '新备注' },
          status: { type: 'string', description: '新状态：todo/doing/done/archived' },
          days: { type: 'integer', description: '改期用：相对顺延天数，如 1=明天' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete',
      description: '删除任务（移入回收站，可恢复）。需要用户确认后才会真正执行。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '任务标题或关键词' },
          taskId: { type: 'string', description: '任务 ID' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'batch',
      description: '批量操作任务（如按标签/优先级批量完成或删除）。删除类操作需要用户确认。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '用户对批量操作的原始描述（必填）' },
          tags: { type: 'array', items: { type: 'string' } },
          pri: { type: 'integer' },
          project: { type: 'string' },
          status: { type: 'string' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memo_create',
      description: '创建一条备忘录（用于记想法、会议要点等，不是任务）。',
      parameters: {
        type: 'object',
        properties: {
          memoTitle: { type: 'string', description: '备忘录标题（必填）' },
          memoContent: { type: 'string', description: '备忘录正文' },
          tags: { type: 'array', items: { type: 'string' } }
        },
        required: ['memoTitle']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memo_query',
      description: '查询备忘录列表或按关键词搜索。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '搜索关键词或用户原始语句' },
          memoId: { type: 'string', description: '备忘录 ID' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memo_to_task',
      description: '把一条备忘录转成任务（查询到备忘录后的跟进动作）。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '备忘录标题或关键词' },
          memoId: { type: 'string', description: '备忘录 ID' }
        }
      }
    }
  }
]);

const AGENT_TOOL_NAMES = Object.freeze(AGENT_TOOLS.map((tool) => tool.function.name));

module.exports = { AGENT_TOOLS, AGENT_TOOL_NAMES };
