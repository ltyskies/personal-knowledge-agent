/**
 * 上下文压缩器
 *
 * 解决 AI 对话和知识提取过程中上下文过长导致精度丢失的问题。
 *
 * 核心策略：渐进式摘要 + 滑动窗口
 * - 最近 N 轮对话完整保留（活跃窗口）
 * - 窗口外的旧消息压缩为结构化摘要
 * - 摘要增量更新，避免重复计算
 *
 * Token 估算使用字符数 / 2.5 的启发式算法（混合中英文场景），
 * 不依赖外部 tokenizer 库。
 */
import { SystemMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatOpenAI } from '@langchain/openai';

// ===== 配置常量 =====

/** 模型默认上下文窗口（tokens） */
const DEFAULT_CONTEXT_WINDOW = 16000;

/** 响应预留比例 */
const RESPONSE_RESERVE_RATIO = 0.2;

/** 活跃窗口占比 */
const ACTIVE_WINDOW_RATIO = 0.5;

/** 摘要最大 tokens */
const SUMMARY_MAX_RATIO = 0.35;

/** 单条工具结果最大字符数 */
const DEFAULT_MAX_TOOL_RESULT_CHARS = 3000;

/** 搜索结果最大条数 */
const MAX_SEARCH_RESULTS = 5;

/** 压缩输入中每条消息的最大字符数 */
const COMPRESSION_MSG_MAX_CHARS = 500;

// ===== Token 估算 =====

/**
 * 估算文本的 token 数量
 *
 * 使用字符数 / 2.5 的启发式算法，适用于混合中英文内容。
 * 精度在 ±30% 以内，足够用于阈值判断。
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 2.5);
}

/** 估算多条消息的总 token 数 */
export function estimateMessagesTokenCount(messages: BaseMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokenCount(extractMessageText(msg.content));
    total += 4; // 每条消息的角色标记、格式化等开销
  }
  return total;
}

/** 从 MessageContent 中提取文本 */
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

// ===== 工具结果截断 =====

/** 截断过长的工具返回结果 */
export function truncateToolResult(result: string, maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS): string {
  if (result.length <= maxChars) return result;
  const remaining = result.length - maxChars;
  const remainingK = Math.ceil(remaining / 1000);
  return result.slice(0, maxChars) +
    `\n\n[内容已截断，剩余约 ${remainingK}k 字符。如需完整内容，请缩小查询范围。]`;
}

/** 截断搜索结果：限制条数 + 截断每条摘要 */
export function truncateSearchResults(
  resultsJson: string,
  maxResults: number = MAX_SEARCH_RESULTS,
): string {
  try {
    const results = JSON.parse(resultsJson);
    if (!Array.isArray(results)) return resultsJson;

    if (results.length <= maxResults) return resultsJson;

    const truncated = results.slice(0, maxResults);
    return JSON.stringify(truncated, null, 2) +
      `\n\n[还有 ${results.length - maxResults} 条结果未显示，请缩小搜索范围]`;
  } catch {
    // 非 JSON 格式，做简单字符截断
    return truncateToolResult(resultsJson, DEFAULT_MAX_TOOL_RESULT_CHARS);
  }
}

// ===== 压缩缓存 =====

interface CacheEntry {
  summary: string;
  /** 摘要覆盖的消息数量（从开头算起） */
  coveredCount: number;
  /** 摘要覆盖消息的内容指纹 */
  fingerprint: string;
}

const compressionCache = new Map<string, CacheEntry>();

/** 清除压缩缓存（对话切换时调用） */
export function clearCompressionCache(): void {
  compressionCache.clear();
}

// ===== 摘要生成 =====

const COMPRESSION_SYSTEM_PROMPT = `你是一个对话压缩助手。将对话历史压缩为结构化摘要，保留关键信息。

输出格式：
### 讨论主题
- 主题简述
### 关键信息
- 重要事实或知识点
### 用户偏好
- 用户表达过的偏好或决策
### 已提取知识点
- 已记录的知识点

规则：
- 只输出摘要，不输出其他内容
- 忽略闲聊和情感表达，只保留事实性信息
- 每个条目一行，简洁明确`;

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
  // 使用消息数量和首尾内容作为简单指纹
  const first = messages.length > 0
    ? extractMessageText(messages[0].content).slice(0, 100)
    : '';
  const last = messages.length > 0
    ? extractMessageText(messages[messages.length - 1].content).slice(0, 100)
    : '';
  return `${messages.length}|${first}|${last}`;
}

// ===== 核心压缩函数 =====

/**
 * 压缩对话消息列表
 *
 * 如果消息总 token 数在预算内，直接返回原列表。
 * 超出预算时：保留最近的消息（活跃窗口），将早期消息压缩为摘要。
 *
 * @param model - ChatOpenAI 实例（用于生成摘要）
 * @param messages - 完整消息列表
 * @param contextWindow - 模型上下文窗口大小，默认 16000
 * @returns 压缩后的消息列表（可能包含摘要 SystemMessage）
 */
export async function compressConversationMessages(
  model: ChatOpenAI,
  messages: BaseMessage[],
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): Promise<BaseMessage[]> {
  const effectiveBudget = Math.floor(contextWindow * (1 - RESPONSE_RESERVE_RATIO));
  const activeWindowBudget = Math.floor(effectiveBudget * ACTIVE_WINDOW_RATIO);
  const summaryBudget = Math.floor(effectiveBudget * SUMMARY_MAX_RATIO);

  const totalTokens = estimateMessagesTokenCount(messages);

  // 在预算内 → 无需压缩
  if (totalTokens <= effectiveBudget) {
    return messages;
  }

  // 从后向前累积，找到活跃窗口的起止点
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

  // 没有旧消息需要压缩 → 返回原列表
  if (splitIndex <= 0) {
    return messages;
  }

  const oldMessages = messages.slice(0, splitIndex);
  const recentMessages = messages.slice(splitIndex);
  const fingerprint = computeFingerprint(oldMessages);

  // 检查缓存
  const cacheKey = fingerprint;
  const cached = compressionCache.get(cacheKey);

  let summary: string;

  if (cached && cached.coveredCount === oldMessages.length) {
    summary = cached.summary;
  } else {
    // 生成或更新摘要
    const prompt = buildCompressionPrompt(oldMessages, cached?.summary);

    try {
      const response = await model.invoke(
        [new SystemMessage(COMPRESSION_SYSTEM_PROMPT), new HumanMessage(prompt)],
        { maxTokens: summaryBudget } as any,
      );
      summary = typeof response.content === 'string' ? response.content : '';
    } catch {
      // 摘要生成失败时降级：直接截断旧消息
      summary = `[早期对话摘要生成失败，共 ${oldMessages.length} 条消息被截断]`;
    }

    // 更新缓存
    compressionCache.set(cacheKey, {
      summary,
      coveredCount: oldMessages.length,
      fingerprint,
    });
  }

  // 构建压缩后的消息列表：摘要 + 分隔 + 最近消息
  const summaryMsg = new SystemMessage(
    `[以下是更早对话的结构化摘要，共 ${oldMessages.length} 条历史消息]\n\n${summary}`,
  );

  return [summaryMsg, ...recentMessages];
}

/**
 * 计算当前 token 使用率
 *
 * 返回 0-1 之间的值，超过 0.8 建议触发压缩。
 */
export function getTokenUsageRatio(
  messages: BaseMessage[],
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): number {
  const total = estimateMessagesTokenCount(messages);
  return total / contextWindow;
}
