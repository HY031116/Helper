'use strict';

/**
 * Agent 工具清单（OpenAI function-calling 格式）。
 * name 与 tool-registry 的 intent key 一一对应，params 由模型生成后直接交给 execute()。
 * 每个 schema 里的参数名必须与各 handler 实际读取的 params 字段保持一致。
 */
const AGENT_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'query',
      description: '查询任务列表。支持按标签、优先级（1紧急/2普通/3低）、状态（todo/doing/done/archived）、项目、截止日筛选。回答「我有哪些任务」类问题前先用它拿实时数据。',
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
      name: 'stats',
      description: '统计任务数量与完成率。回答「今天完成了多少」「还剩几条」类问题。',
      parameters: { type: 'object', properties: { text: { type: 'string', description: '用户原始语句' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'suggest',
      description: '基于当前任务列表给出下一步优先级建议。回答「我该先做什么」类问题。',
      parameters: { type: 'object', properties: { text: { type: 'string', description: '用户原始语句' } } }
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
      name: 'start',
      description: '把一个任务标记为进行中。需要 target（任务标题）或 taskId。',
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
      name: 'update',
      description: '修改任务字段：优先级、截止时间、标签、项目、备注等。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '任务标题或关键词' },
          taskId: { type: 'string', description: '任务 ID' },
          pri: { type: 'integer', description: '新优先级' },
          due: { type: 'string', description: '新截止时间' },
          tags: { type: 'array', items: { type: 'string' }, description: '新标签' },
          project: { type: 'string', description: '新项目名' },
          note: { type: 'string', description: '新备注' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'child',
      description: '给一个已有任务添加子任务。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '父任务标题或关键词' },
          taskId: { type: 'string', description: '父任务 ID' },
          childTitle: { type: 'string', description: '子任务标题（必填）' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'postpone',
      description: '把任务截止时间顺延（默认明天）。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '任务标题或关键词' },
          taskId: { type: 'string', description: '任务 ID' },
          days: { type: 'integer', description: '顺延天数，默认 1' }
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
      name: 'archive',
      description: '归档一个任务（不删除）。',
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
      name: 'split',
      description: '把一个大任务拆成多个子任务。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '任务标题或关键词' },
          taskId: { type: 'string', description: '任务 ID' },
          steps: { type: 'array', items: { type: 'string' }, description: '拆分出的子步骤标题' }
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
      name: 'memo_pin',
      description: '置顶或取消置顶一条备忘录。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '备忘录标题或关键词' },
          memoId: { type: 'string', description: '备忘录 ID' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memo_to_task',
      description: '把一条备忘录转成任务。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '备忘录标题或关键词' },
          memoId: { type: 'string', description: '备忘录 ID' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memo_split',
      description: '把一条备忘录按要点拆成多条任务。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '备忘录标题或关键词' },
          memoId: { type: 'string', description: '备忘录 ID' },
          steps: { type: 'array', items: { type: 'string' }, description: '拆分出的任务标题' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memo_delete',
      description: '删除一条备忘录（可从回收站恢复）。需要用户确认后才会真正执行。',
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
