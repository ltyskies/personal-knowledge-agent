/**
 * 上下文压缩器 — 分层压缩 + 循环内 LLM 摘要 + 工具差异化截断
 *
 * 四层上下文管理：
 *   Layer 0 - 系统层：动态裁剪系统提示词以适应剩余预算
 *   Layer 1 - 活跃窗口：最近 N 轮 user+assistant，完整保留
 *   Layer 2 - 工具结果缓冲区：保留最近 K 条完整 + 旧结果按类型差异化截断
 *   Layer 3 - 历史摘要：LLM 生成的早期对话结构化摘要
 *
 * Token 估算使用字符数 / 2.5 的启发式算法（混合中英文场景）。
 */
import { SystemMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatOpenAI } from '@langchain/openai';
import {
  TOOL_SYSTEM_PROMPT_FULL,
  TOOL_SYSTEM_PROMPT_LITE,
  INLOOP_SUMMARY_PROMPT,
  COMPRESSION_SYSTEM_PROMPT,
  generateInLoopSummaryPrefix,
  generateEmergencyTruncationWarning,
  generateConversationSummaryPrefix,
  BUDGET_HINT_TIGHT,
  BUDGET_HINT_ELEVATED,
} from './prompts';

// ===== 配置常量 =====

const DEFAULT_CONTEXT_WINDOW = 16000;
const RESPONSE_RESERVE_RATIO = 0.2;
const ACTIVE_WINDOW_RATIO = 0.5;
const SUMMARY_MAX_RATIO = 0.35;

/** 循环内压缩触发阈值 */
const PRESSURE_MODERATE = 0.70;   // 70% — 触发轻量级压缩
const PRESSURE_HIGH = 0.85;       // 85% — 触发 LLM 摘要
const PRESSURE_CRITICAL = 0.95;   // 95% — 紧急截断

/** 循环内 LLM 摘要时保留的最近迭代轮数 */
const KEEP_RECENT_ITERATIONS = 2;

/** 循环内摘要最大 tokens */
const INLOOP_SUMMARY_MAX_TOKENS = 800;

/** 单条工具结果默认最大字符数 */
const DEFAULT_MAX_TOOL_RESULT_CHARS = 3000;

/** 搜索结果最大条数 */
const MAX_SEARCH_RESULTS = 5;

/** 压缩输入中每条消息的最大字符数 */
const COMPRESSION_MSG_MAX_CHARS = 500;

// ===== Token 估算 =====

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 2.5);
}

export function estimateMessagesTokenCount(messages: BaseMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokenCount(extractMessageText(msg.content));
    total += 4;
  }
  return total;
}

function extractMessageText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
  }
  return '';
}

// ===== 内容哈希 =====

function computeContentHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ===== 工具结果差异化截断 =====

/** 通用工具结果截断 */
export function truncateToolResult(result: string, maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS): string {
  if (result.length <= maxChars) return result;
  const remaining = result.length - maxChars;
  const remainingK = Math.ceil(remaining / 1000);
  return result.slice(0, maxChars) +
    `\n\n[内容已截断，剩余约 ${remainingK}k 字符。如需完整内容，请缩小查询范围。]`;
}

/** 按工具类型差异化截断 */
export function truncateToolResultByType(toolName: string, result: string, pressureLevel: 'normal' | 'moderate' | 'high' | 'critical' = 'normal'): string {
  switch (toolName) {
    case 'search_knowledge':
      return truncateSearchResults(result, pressureLevel === 'high' ? 3 : MAX_SEARCH_RESULTS);
    case 'read_chapter':
      return truncateChapterResult(result, pressureLevel);
    case 'list_files':
      return truncateListFilesResult(result, pressureLevel);
    case 'write_chapter':
      return truncateWriteResult(result);
    default:
      return truncateToolResult(result);
  }
}

export function truncateSearchResults(resultsJson: string, maxResults: number = MAX_SEARCH_RESULTS): string {
  try {
    const results = JSON.parse(resultsJson);
    if (!Array.isArray(results)) return resultsJson;
    if (results.length <= maxResults) return resultsJson;

    const truncated = results.slice(0, maxResults);
    return JSON.stringify(truncated, null, 2) +
      `\n\n[还有 ${results.length - maxResults} 条结果未显示，请缩小搜索范围]`;
  } catch {
    return truncateToolResult(resultsJson, DEFAULT_MAX_TOOL_RESULT_CHARS);
  }
}

function truncateChapterResult(result: string, pressureLevel: 'normal' | 'moderate' | 'high' | 'critical'): string {
  if (result.length <= 800) return result;

  const isHeavy = pressureLevel === 'high' || pressureLevel === 'critical';
  const headSize = isHeavy ? 300 : 500;
  const tailSize = isHeavy ? 100 : 200;
  const head = result.slice(0, headSize);
  const tail = result.slice(-tailSize);

  return `${head}\n\n...[中间 ${result.length - headSize - tailSize} 字符已省略]...\n\n${tail}`;
}

function truncateListFilesResult(result: string, pressureLevel: 'normal' | 'moderate' | 'high' | 'critical'): string {
  try {
    const files = JSON.parse(result);
    if (!Array.isArray(files)) return result;

    if ((pressureLevel === 'high' || pressureLevel === 'critical') && files.length > 15) {
      const names = files.map((f: any) => f.fileName || f.title || '');
      return `知识库文件列表 (${files.length} 个文件):\n${names.join(', ')}`;
    }

    return result;
  } catch {
    return result;
  }
}

function truncateWriteResult(result: string): string {
  const lines = result.split('\n');
  if (lines.length <= 2) return result;
  return lines[0];
}

// ===== 系统提示词动态裁剪 =====

/**
 * 根据上下文压力等级裁剪系统提示词
 *
 * normal: 完整提示词（~720 tokens）
 * moderate: 完整提示词（保留完整指引，压缩其他方面来控制预算）
 * high: 精简提示词（~160 tokens）
 */
export function trimSystemPrompt(pressureLevel: 'normal' | 'moderate' | 'high'): string {
  switch (pressureLevel) {
    case 'high':
      return TOOL_SYSTEM_PROMPT_LITE;
    case 'moderate':
    case 'normal':
    default:
      return TOOL_SYSTEM_PROMPT_FULL;
  }
}

/** 获取系统提示词的估算 token 数 */
export function getSystemPromptTokens(pressureLevel: 'normal' | 'moderate' | 'high'): number {
  return estimateTokenCount(trimSystemPrompt(pressureLevel));
}

// ===== 上下文压力评估 =====

export interface PressureAssessment {
  /** 当前总 token 估算 */
  totalTokens: number;
  /** 使用率 0-1 */
  usageRatio: number;
  /** 压力等级 */
  level: 'normal' | 'moderate' | 'high' | 'critical';
  /** 剩余 token 预算 */
  remainingTokens: number;
  /** 活跃窗口中最近 N 条消息的起始索引 */
  activeWindowStartIndex: number;
}

/**
 * 评估当前上下文压力
 */
export function assessPressure(
  messages: BaseMessage[],
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
  keptRecentCount: number = 0,
): PressureAssessment {
  const totalTokens = estimateMessagesTokenCount(messages);
  const effectiveBudget = Math.floor(contextWindow * (1 - RESPONSE_RESERVE_RATIO));
  const usageRatio = effectiveBudget > 0 ? totalTokens / effectiveBudget : 1;

  let level: PressureAssessment['level'] = 'normal';
  if (usageRatio >= PRESSURE_CRITICAL) level = 'critical';
  else if (usageRatio >= PRESSURE_HIGH) level = 'high';
  else if (usageRatio >= PRESSURE_MODERATE) level = 'moderate';

  // 找出活跃窗口起始索引：从后向前找到最近 keptRecentCount 条非系统消息
  let activeWindowStartIndex = 0;
  if (keptRecentCount > 0) {
    let count = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const type = getMessageType(messages[i]);
      if (type !== 'system') {
        count++;
        if (count >= keptRecentCount) {
          activeWindowStartIndex = i;
          break;
        }
      }
    }
  }

  return {
    totalTokens,
    usageRatio,
    level,
    remainingTokens: Math.max(0, effectiveBudget - totalTokens),
    activeWindowStartIndex,
  };
}

function getMessageType(msg: BaseMessage): string {
  return (msg as any)._getType?.() ?? msg.constructor?.name ?? 'unknown';
}

// ===== 压缩缓存 =====

interface CacheEntry {
  summary: string;
  contentHash: string;
}

const compressionCache = new Map<string, CacheEntry>();

export function clearCompressionCache(): void {
  compressionCache.clear();
}

// ===== 循环内 LLM 工具结果摘要 =====

function buildInLoopSummaryInput(messages: BaseMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    const type = getMessageType(msg);
    const content = extractMessageText(msg.content);
    if (!content) continue;

    let label: string;
    switch (type) {
      case 'tool': label = '工具结果'; break;
      case 'ai': label = 'AI'; break;
      case 'human': label = '用户'; break;
      case 'system': continue; // 跳过系统消息
      default: label = type;
    }

    const truncated = content.length > COMPRESSION_MSG_MAX_CHARS
      ? content.slice(0, COMPRESSION_MSG_MAX_CHARS) + '...'
      : content;
    parts.push(`[${label}]: ${truncated}`);
  }
  return parts.join('\n\n');
}

/**
 * 循环内 LLM 摘要：将旧消息压缩为结构化摘要
 *
 * 在 agent 循环中上下文压力达到 HIGH 时调用。
 * 保留最近 K 轮迭代，将更早的消息发送给 LLM 做摘要。
 *
 * @returns 摘要 SystemMessage，插入到消息列表中以替代被压缩的消息
 */
export async function summarizeInLoop(
  model: ChatOpenAI,
  messagesToSummarize: BaseMessage[],
): Promise<string> {
  const contentHash = computeContentHash(
    messagesToSummarize.map((m) => extractMessageText(m.content)).join('|'),
  );

  const cached = compressionCache.get(contentHash);
  if (cached) return cached.summary;

  const input = buildInLoopSummaryInput(messagesToSummarize);

  try {
    const response = await model.invoke(
      [new SystemMessage(INLOOP_SUMMARY_PROMPT), new HumanMessage(input)],
      { maxTokens: INLOOP_SUMMARY_MAX_TOKENS } as any,
    );
    const summary = typeof response.content === 'string'
      ? response.content
      : extractMessageText(response.content);

    compressionCache.set(contentHash, { summary, contentHash });
    return summary || '[摘要生成失败]';
  } catch {
    // 降级：简单截断
    const truncated = messagesToSummarize
      .map((m) => {
        const content = extractMessageText(m.content);
        return content.length > 200 ? content.slice(0, 200) + '...' : content;
      })
      .join('\n');
    return `[早期对话截断摘要，共 ${messagesToSummarize.length} 条消息]\n${truncated.slice(0, 500)}`;
  }
}

// ===== 循环内消息列表压缩 =====

/**
 * 循环内上下文压缩的返回结果
 */
export interface InLoopCompressionResult {
  /** 压缩后的完整消息列表 */
  messages: BaseMessage[];
  /** 压缩后是否还有充足的预算 */
  budgetOk: boolean;
  /** 用于通知前端的压力信息 */
  pressure: PressureAssessment;
}

/**
 * 在 agent 循环内执行上下文压缩
 *
 * 根据压力等级执行不同策略：
 * - moderate: 对旧工具结果做差异化截断（轻量级，不调用 LLM）
 * - high: 将旧消息发送给 LLM 生成摘要，替换原消息
 * - critical: 紧急截断 + 注入警告
 *
 * @param model - ChatOpenAI 实例（high 压力时用于 LLM 摘要）
 * @param messages - 当前消息列表
 * @param contextWindow - 模型上下文窗口
 * @param iteration - 当前迭代轮数（用于判断保留多少最近消息）
 */
export async function compressInLoop(
  model: ChatOpenAI,
  messages: BaseMessage[],
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): Promise<InLoopCompressionResult> {
  const pressure = assessPressure(messages, contextWindow);

  // 压力正常，无需压缩
  if (pressure.level === 'normal') {
    return { messages, budgetOk: true, pressure };
  }

  // moderate — 轻量级：对旧工具结果做差异化截断
  if (pressure.level === 'moderate') {
    const compressed = applyLightweightCompression(messages);
    const newPressure = assessPressure(compressed, contextWindow);
    return { messages: compressed, budgetOk: newPressure.level !== 'critical', pressure: newPressure };
  }

  // high — 调用 LLM 生成摘要
  if (pressure.level === 'high') {
    const result = await applyHeavyCompression(model, messages);
    const newPressure = assessPressure(result, contextWindow);
    return { messages: result, budgetOk: newPressure.level !== 'critical', pressure: newPressure };
  }

  // critical — 紧急截断
  const compressed = applyEmergencyTruncation(messages);
  const newPressure = assessPressure(compressed, contextWindow);
  return { messages: compressed, budgetOk: false, pressure: newPressure };
}

/** 轻量级压缩：对旧工具结果按类型差异化截断，不调用 LLM */
function applyLightweightCompression(messages: BaseMessage[]): BaseMessage[] {
  const result = [...messages];
  // 从旧到新，对前 2/3 的工具消息做差异化截断
  const cutoffIndex = Math.floor(messages.length * 0.6);

  for (let i = 0; i < cutoffIndex; i++) {
    const msg = result[i] as any;
    const msgType = msg._getType?.() ?? msg.constructor?.name;
    if (msgType === 'tool' || msgType === 'ToolMessage') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content) {
        // 使用通用策略：保留前 800 字符
        if (content.length > 800) {
          msg.content = content.slice(0, 800) + '\n...[早期工具结果已压缩]';
        }
      }
    }
  }

  return result;
}

/** 重度压缩：LLM 摘要替代早期消息 */
async function applyHeavyCompression(
  model: ChatOpenAI,
  messages: BaseMessage[],
): Promise<BaseMessage[]> {
  // 估计每轮迭代的消息数：通常 1 assistant + N tool results（平均 3 个）
  const msgsPerIteration = 4;
  const keepCount = KEEP_RECENT_ITERATIONS * msgsPerIteration;

  // 保护系统消息和最近的消息
  const systemMessages: BaseMessage[] = [];
  const keepMessages: BaseMessage[] = [];
  const summarizeMessages: BaseMessage[] = [];

  let nonSystemCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgType = getMessageType(messages[i]);
    if (msgType === 'system') {
      systemMessages.push(messages[i]);
    } else {
      nonSystemCount++;
      if (nonSystemCount <= keepCount) {
        keepMessages.unshift(messages[i]);
      } else {
        summarizeMessages.unshift(messages[i]);
      }
    }
  }

  // 没有需要摘要的消息
  if (summarizeMessages.length === 0) {
    return messages;
  }

  const summaryText = await summarizeInLoop(model, summarizeMessages);

  const summaryMsg = new SystemMessage(
    `${generateInLoopSummaryPrefix(summarizeMessages.length)}\n\n${summaryText}`,
  );

  // 同时精简原有的系统提示词
  const trimmedSystemMessages = systemMessages.map((m) => {
    const content = extractMessageText(m.content);
    if (content.length > 500) {
      return new SystemMessage(trimSystemPrompt('high'));
    }
    return m;
  });

  return [...trimmedSystemMessages, summaryMsg, ...keepMessages];
}

/** 紧急截断：只保留系统消息 + 最近少量消息 + 注入警告 */
function applyEmergencyTruncation(messages: BaseMessage[]): BaseMessage[] {
  const result: BaseMessage[] = [];

  // 保留系统消息
  for (const msg of messages) {
    if (getMessageType(msg) === 'system') {
      result.push(msg);
    }
  }

  // 保留最近 6 条非系统消息，其余截断
  const nonSystem = messages.filter((m) => getMessageType(m) !== 'system');
  const recent = nonSystem.slice(-6);

  if (nonSystem.length > 6) {
    result.push(new SystemMessage(
      generateEmergencyTruncationWarning(nonSystem.length - 6),
    ));
  }

  result.push(...recent);
  return result;
}

// ===== 对外压缩（对话开始时调用） =====

function buildCompressionPrompt(
  messages: BaseMessage[],
  existingSummary?: string,
): string {
  const conversation = messages
    .map((m) => {
      const role = m._getType();
      const content = extractMessageText(m.content);
      const truncated = content.length > COMPRESSION_MSG_MAX_CHARS
        ? content.slice(0, COMPRESSION_MSG_MAX_CHARS) + '...'
        : content;
      return `[${role}]: ${truncated}`;
    })
    .join('\n\n');

  if (existingSummary) {
    return `已有摘要：\n${existingSummary}\n\n--- 新增对话 ---\n${conversation}\n\n请将新增内容合并到已有摘要中，输出更新后的完整摘要。`;
  }

  return `对话内容：\n${conversation}\n\n请生成摘要。`;
}

function computeFingerprint(messages: BaseMessage[]): string {
  const first = messages.length > 0
    ? extractMessageText(messages[0].content).slice(0, 100)
    : '';
  const last = messages.length > 0
    ? extractMessageText(messages[messages.length - 1].content).slice(0, 100)
    : '';
  return computeContentHash(`${messages.length}|${first}|${last}`);
}

export async function compressConversationMessages(
  model: ChatOpenAI,
  messages: BaseMessage[],
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): Promise<BaseMessage[]> {
  const effectiveBudget = Math.floor(contextWindow * (1 - RESPONSE_RESERVE_RATIO));
  const activeWindowBudget = Math.floor(effectiveBudget * ACTIVE_WINDOW_RATIO);
  const summaryBudget = Math.floor(effectiveBudget * SUMMARY_MAX_RATIO);

  const totalTokens = estimateMessagesTokenCount(messages);

  if (totalTokens <= effectiveBudget) {
    return messages;
  }

  let activeTokens = 0;
  let splitIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const content = extractMessageText(messages[i].content);
    const msgTokens = estimateTokenCount(content) + 4;

    if (activeTokens + msgTokens > activeWindowBudget) {
      splitIndex = i + 1;
      break;
    }
    activeTokens += msgTokens;
  }

  if (splitIndex <= 0) {
    return messages;
  }

  const oldMessages = messages.slice(0, splitIndex);
  const recentMessages = messages.slice(splitIndex);
  const fingerprint = computeFingerprint(oldMessages);
  const cacheKey = fingerprint;

  const cached = compressionCache.get(cacheKey);

  let summary: string;

  if (cached) {
    summary = cached.summary;
  } else {
    const prompt = buildCompressionPrompt(oldMessages);

    try {
      const response = await model.invoke(
        [new SystemMessage(COMPRESSION_SYSTEM_PROMPT), new HumanMessage(prompt)],
        { maxTokens: summaryBudget } as any,
      );
      summary = typeof response.content === 'string' ? response.content : '';
    } catch {
      summary = `[早期对话摘要生成失败，共 ${oldMessages.length} 条消息被截断]`;
    }

    compressionCache.set(cacheKey, {
      summary,
      contentHash: computeContentHash(summary),
    });
  }

  const summaryMsg = new SystemMessage(
    `${generateConversationSummaryPrefix(oldMessages.length)}\n\n${summary}`,
  );

  return [summaryMsg, ...recentMessages];
}

// ===== Token 使用率 =====

export function getTokenUsageRatio(
  messages: BaseMessage[],
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): number {
  const total = estimateMessagesTokenCount(messages);
  return total / contextWindow;
}

// ===== 工具结果引用跟踪 =====

/**
 * 记录哪些工具调用 ID 被 AI 后续响应所引用
 *
 * 在 agent 循环中，检测 assistant 消息是否引用了之前的工具结果，
 * 被引用过的工具结果优先保留完整内容。
 */
export function extractReferencedToolIds(
  assistantContent: string,
  toolCallIds: string[],
): Set<string> {
  const referenced = new Set<string>();

  for (const id of toolCallIds) {
    // 工具结果中的 chapterId 片段可能被引用
    const shortId = id.slice(-8);
    if (assistantContent.includes(shortId) || assistantContent.includes(id)) {
      referenced.add(id);
    }
  }

  return referenced;
}

/** 循环内旧工具消息压缩 — 被引用过的结果保留更长内容 */
export function compressOldToolMessagesWithTracking(
  messages: BaseMessage[],
  referencedIds: Set<string>,
  keepRecentCount: number = 6,
): void {
  let toolCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg._getType?.() === 'tool' || msg.constructor?.name === 'ToolMessage') {
      toolCount++;
      const toolCallId = msg.tool_call_id || '';

      if (toolCount > keepRecentCount) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content.length > 300) {
          if (referencedIds.has(toolCallId)) {
            // 被引用过的结果保留更多内容
            if (content.length > 600) {
              msg.content = content.slice(0, 600) + '\n...[早期工具结果已截断]';
            }
          } else {
            msg.content = content.slice(0, 300) + '\n...[早期工具结果已截断]';
          }
        }
      }
    }
  }
}

// ===== 自适应迭代次数 =====

/**
 * 根据上下文剩余预算计算最大迭代次数
 */
export function calcMaxIterations(
  usageRatio: number,
  baseMax: number = 10,
): number {
  if (usageRatio >= 0.85) return Math.max(2, Math.floor(baseMax * 0.2));
  if (usageRatio >= 0.70) return Math.max(3, Math.floor(baseMax * 0.5));
  if (usageRatio >= 0.50) return Math.max(5, Math.floor(baseMax * 0.7));
  return baseMax;
}

// ===== 构建上下文预算提示 =====

/**
 * 在系统提示词末尾追加 token 预算信息
 */
export function buildBudgetHint(remainingTokens: number, usageRatio: number): string {
  if (usageRatio < 0.5) return '';

  if (usageRatio >= 0.85) {
    return BUDGET_HINT_TIGHT(remainingTokens);
  }
  if (usageRatio >= 0.70) {
    return BUDGET_HINT_ELEVATED(remainingTokens);
  }
  return '';
}
