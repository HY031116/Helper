'use strict';

class ReportContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReportContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReportContractError(code, message);
}

function parseObject(content) {
  const raw = String(content || '').trim();
  if (!raw) fail('REPORT_OUTPUT_EMPTY', '模型没有返回报告');
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    const value = JSON.parse((fence ? fence[1] : raw).trim());
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('shape');
    return value;
  } catch (error) {
    fail('REPORT_OUTPUT_INVALID_JSON', '模型报告不是有效 JSON');
  }
}

function text(value, field, maxLength, required = false) {
  if (value === undefined || value === null) {
    if (required) fail('REPORT_OUTPUT_MISSING_FIELD', `模型报告缺少 ${field}`);
    return '';
  }
  if (typeof value !== 'string') fail('REPORT_OUTPUT_INVALID_FIELD', `模型报告字段 ${field} 必须是文本`);
  const normalized = value.trim().slice(0, maxLength);
  if (required && !normalized) fail('REPORT_OUTPUT_MISSING_FIELD', `模型报告缺少 ${field}`);
  return normalized;
}

function normalizeReportModelResponse(content, availableSourceIds) {
  const parsed = parseObject(content);
  const sourceIds = availableSourceIds instanceof Set ? availableSourceIds : new Set(availableSourceIds || []);
  if (!Array.isArray(parsed.sections) || !parsed.sections.length || parsed.sections.length > 8) {
    fail('REPORT_OUTPUT_INVALID_SECTIONS', '模型报告必须包含 1 到 8 个章节');
  }

  let factItems = 0;
  const referenced = new Set();
  const sections = parsed.sections.map((section, sectionIndex) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      fail('REPORT_OUTPUT_INVALID_SECTION', `模型报告第 ${sectionIndex + 1} 个章节格式错误`);
    }
    const kind = ['facts', 'analysis', 'suggestions'].includes(section.kind) ? section.kind : '';
    if (!kind) fail('REPORT_OUTPUT_INVALID_KIND', '报告章节必须区分事实、分析或建议');
    if (!Array.isArray(section.items) || !section.items.length || section.items.length > 12) {
      fail('REPORT_OUTPUT_INVALID_ITEMS', '每个报告章节必须包含 1 到 12 条内容');
    }
    const items = section.items.map((item, itemIndex) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        fail('REPORT_OUTPUT_INVALID_ITEM', `模型报告第 ${itemIndex + 1} 条内容格式错误`);
      }
      const ids = Array.isArray(item.sourceIds)
        ? [...new Set(item.sourceIds.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 12)
        : [];
      if (ids.some((id) => !sourceIds.has(id))) {
        fail('REPORT_OUTPUT_UNKNOWN_SOURCE', '模型报告引用了事实快照中不存在的来源');
      }
      if ((kind === 'facts' || kind === 'analysis') && !ids.length) {
        fail('REPORT_OUTPUT_UNSOURCED_CLAIM', '模型报告的事实和归纳内容必须标注来源');
      }
      ids.forEach((id) => referenced.add(id));
      if (kind === 'facts') factItems += 1;
      return {
        text: text(item.text, 'item.text', 600, true),
        sourceIds: ids
      };
    });
    return {
      heading: text(section.heading, 'section.heading', 80, true),
      kind,
      items
    };
  });

  if (!factItems) fail('REPORT_OUTPUT_NO_FACTS', '模型报告至少需要一个有来源的事实条目');
  return {
    title: text(parsed.title, 'title', 120, true),
    audience: text(parsed.audience, 'audience', 60),
    tone: text(parsed.tone, 'tone', 60),
    executiveSummary: text(parsed.executiveSummary, 'executiveSummary', 800),
    sections,
    referencedSourceIds: [...referenced]
  };
}

function reportToMarkdown(report) {
  const lines = [`# ${report.title}`, ''];
  if (report.executiveSummary) lines.push(report.executiveSummary, '');
  report.sections.forEach((section) => {
    lines.push(`## ${section.heading}`, '');
    section.items.forEach((item) => {
      lines.push(`- ${item.text}`);
    });
    lines.push('');
  });
  return lines.join('\n').trim();
}

module.exports = { ReportContractError, normalizeReportModelResponse, reportToMarkdown };
