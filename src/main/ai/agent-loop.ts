/**
 * Agent 循环 — Tool-call-aware 流式生成器（上下文自适应版）
 *
 * 实现 ReAct 风格的 agent 循环：
 * 1. 评估上下文压力 → 动态裁剪系统提示词 → 注入预算提示
 * 2. 流式调用模型，逐块产出文本
 * 3. 检测 tool_calls → 执行工具 → 对结果做差异化截断 → 反馈给模型
 * 4. 每轮迭代后实时监控 token 使用量，按压力等级触发压缩：
 *    - moderate (70%): 轻量级工具结果截断
 *    - high (85%):    调用 LLM 将早期消息压缩为摘要
 *    - critical (95%): 紧急截断 + 注入警告
 * 5. 自适应调整最大迭代次数，预算紧张时减少轮数
 *
 * 事件类型：
 * - text:             普通文本块
 * - done:             生成完成
 * - tool_call / tool_result: 工具调用事件
 * - context_pressure: 上下文压力警告
 */
import type { ChatOpenAI } from '@langchain/openai';
import type { StructuredTool } from '@langchain/core/tools';
import { SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ToolCallEvent, ToolResultEvent, ContextPressureEvent } from '../../shared/types';
import {
  assessPressure,
  compressInLoop,
  truncateToolResultByType,
  compressOldToolMessagesWithTracking,
  extractReferencedToolIds,
  calcMaxIterations,
  buildBudgetHint,
} from './context-compressor';

export interface AgentTextEvent {
  type: 'text';
  content: string;
}

export interface AgentDoneEvent {
  type: 'done';
}

export type AgentEvent =
  | AgentTextEvent
  | AgentDoneEvent
  | ToolCallEvent
  | ToolResultEvent
  | ContextPressureEvent;

// ===== 常量 =====

const DEFAULT_CONTEXT_WINDOW = 16000;

const TOOL_SYSTEM_PROMPT_BASE = `You are a personal knowledge management assistant. You have access to a local Markdown knowledge base with the following tools:

- **search_knowledge(query)**: Search the knowledge base for relevant chapters. Use this FIRST before answering any question that might benefit from stored knowledge.
- **read_chapter(chapterId)**: Read a chapter's full content by its unique ID. Use this after search_knowledge to get the full details.
- **list_files()**: List all knowledge base files and their titles. Use this to understand what topics are available.
- **write_chapter(...)**: Save new knowledge to the knowledge base. Always confirm with the user before writing — describe what you plan to save and ask permission.

Guidelines:
- When the user asks a question, search the knowledge base first for relevant context
- When the user shares valuable information or insights, proactively offer to save it to the knowledge base
- Never write to the knowledge base without the user's explicit consent
- When you read from the knowledge base, cite the source chapter and file
- Use conversation context to answer when the knowledge base doesn't have relevant information
- Tools can be used multiple times in a single conversation turn if needed`;

const TOOL_SYSTEM_PROMPT_LITE = `You are a knowledge management assistant. Available tools:
- search_knowledge(query): Search knowledge base
- read_chapter(chapterId): Read chapter by ID
- list_files(): List available files
- write_chapter(...): Save knowledge (confirm with user first)

Core rules: Search before answering. Ask permission before writing. Cite sources.`;

/**
 * 运行 tool-aware agent 循环（上下文自适应版）
 *
 * @param model - ChatOpenAI 实例（不绑定工具）
 * @param tools - 可用的 LangChain 工具列表
 * @param messages - 对话历史（LangChain BaseMessage 格式）
 * @param signal - 用于中止的 AbortSignal
 * @param maxIterations - 最大循环迭代次数（实际会根据上下文预算动态缩减）
 * @param contextWindow - 模型上下文窗口大小
 */
export async function* runAgentLoop(
  model: ChatOpenAI,
  tools: StructuredTool[],
  messages: BaseMessage[],
  signal?: AbortSignal,
  maxIterations: number = 10,
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): AsyncGenerator<AgentEvent> {
  // ---- 初始压力评估 ----
  const initialPressure = assessPressure(messages, contextWindow);

  // 动态选择系统提示词
  let currentPressureLevel: 'normal' | 'moderate' | 'high' | 'critical' = initialPressure.level;
  const systemPromptText = currentPressureLevel === 'high' || currentPressureLevel === 'critical'
    ? TOOL_SYSTEM_PROMPT_LITE
    : TOOL_SYSTEM_PROMPT_BASE;

  // 注入预算提示
  const budgetHint = buildBudgetHint(initialPressure.remainingTokens, initialPressure.usageRatio);
  const fullSystemPrompt = systemPromptText + budgetHint;

  const systemMsg = new SystemMessage(fullSystemPrompt);
  const hasSystemMsg = messages.some(
    (m) => m._getType() === 'system',
  );

  // 绑定工具
  const modelWithTools = model.bindTools(tools);
  if (!modelWithTools) {
    yield* fallbackStream(model, messages, signal);
    yield { type: 'done' };
    return;
  }

  // 构建初始消息列表
  const conversationMessages: BaseMessage[] = hasSystemMsg
    ? [...messages]
    : [systemMsg, ...messages];

  // 自适应最大迭代次数
  const effectiveMaxIterations = calcMaxIterations(initialPressure.usageRatio, maxIterations);

  // 跟踪被 AI 引用过的工具调用 ID（用于优先保留相关结果）
  const referencedToolIds = new Set<string>();

  // 上次发送压力事件的等级（避免重复发送）
  let lastPressureLevelSent = initialPressure.level;

  for (let iteration = 0; iteration < effectiveMaxIterations; iteration++) {
    if (signal?.aborted) break;

    let gathered: BaseMessage | null = null;

    try {
      const stream = await modelWithTools.stream(conversationMessages, {
        signal,
      });

      for await (const chunk of stream) {
        if (signal?.aborted) break;

        if (!gathered) {
          gathered = chunk;
        } else if ('concat' in gathered && typeof (gathered as any).concat === 'function') {
          gathered = (gathered as any).concat(chunk);
        }

        const content = chunk.content;
        let text = '';
        if (typeof content === 'string') {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join('');
        }

        if (text) {
          yield { type: 'text', content: text };
        }
      }

      if (signal?.aborted) break;

      if (!gathered) {
        yield { type: 'done' };
        return;
      }

      // 将该轮 assistant 回复加入对话历史
      conversationMessages.push(gathered);

      // 检测 tool_calls
      const toolCalls = extractToolCalls(gathered);

      if (toolCalls.length === 0) {
        yield { type: 'done' };
        return;
      }

      // 提取本次 assistant 文本中引用的工具结果
      const assistantText = extractMessageText(gathered.content);
      const currentToolCallIds = toolCalls.map((tc) => tc.id);
      const newlyReferenced = extractReferencedToolIds(assistantText, currentToolCallIds);
      for (const id of newlyReferenced) {
        referencedToolIds.add(id);
      }

      // 执行每个工具调用
      for (const tc of toolCalls) {
        if (signal?.aborted) break;

        const toolCallEvent: ToolCallEvent = {
          type: 'tool_call',
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.args,
        };
        yield toolCallEvent;

        const tool = tools.find((t) => t.name === tc.name);
        let result: string;
        let error: string | undefined;

        if (tool) {
          try {
            result = await tool.invoke(tc.args);
          } catch (err) {
            result = '';
            error = err instanceof Error ? err.message : String(err);
          }
        } else {
          result = '';
          error = `Unknown tool: ${tc.name}`;
        }

        // 对工具结果做差异化截断（根据当前压力等级）
        const toolResult = error
          ? `Error: ${error}`
          : truncateToolResultByType(tc.name, result, currentPressureLevel);

        const toolResultEvent: ToolResultEvent = {
          type: 'tool_result',
          toolCallId: tc.id,
          toolName: tc.name,
          result: toolResult,
          error,
        };
        yield toolResultEvent;

        const toolMsg = new ToolMessage({
          content: toolResult,
          tool_call_id: tc.id,
        });
        conversationMessages.push(toolMsg);
      }

      // ---- 循环内上下文压缩 ----
      const pressureAfterTools = assessPressure(conversationMessages, contextWindow);

      if (pressureAfterTools.level !== 'normal') {
        // 仅在压力等级变化时发送事件
        if (pressureAfterTools.level !== lastPressureLevelSent) {
          lastPressureLevelSent = pressureAfterTools.level;
          yield {
            type: 'context_pressure',
            usageRatio: pressureAfterTools.usageRatio,
            remainingTokens: pressureAfterTools.remainingTokens,
            level: pressureAfterTools.level,
          };
        }

        // 执行压缩
        const compressionResult = await compressInLoop(
          model,
          conversationMessages,
          contextWindow,
        );

        // 替换消息列表
        conversationMessages.length = 0;
        conversationMessages.push(...compressionResult.messages);

        // 更新压力等级
        currentPressureLevel = compressionResult.pressure.level;

        // 压力升级时，更新系统提示词为精简版
        if (currentPressureLevel === 'high' || currentPressureLevel === 'critical') {
          updateSystemMessage(conversationMessages, TOOL_SYSTEM_PROMPT_LITE + buildBudgetHint(
            compressionResult.pressure.remainingTokens,
            compressionResult.pressure.usageRatio,
          ));
        }

        // 预算不足时提前退出
        if (!compressionResult.budgetOk && currentPressureLevel === 'critical') {
          yield {
            type: 'context_pressure',
            usageRatio: compressionResult.pressure.usageRatio,
            remainingTokens: 0,
            level: 'critical',
          };
          yield { type: 'done' };
          return;
        }
      }

      // 旧工具消息压缩（保留被引用过的结果）
      compressOldToolMessagesWithTracking(conversationMessages, referencedToolIds);
    } catch (err) {
      if (signal?.aborted) break;
      throw err;
    }
  }

  yield { type: 'done' };
}

// ===== 辅助函数 =====

/** 更新消息列表中已有的系统消息内容 */
function updateSystemMessage(messages: BaseMessage[], newContent: string): void {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]._getType() === 'system') {
      // 只替换基础系统提示词，保留已有的摘要类系统消息（以 `[` 开头的）
      const content = extractMessageText(messages[i].content);
      if (!content.startsWith('[')) {
        messages[i] = new SystemMessage(newContent);
      }
    }
  }
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

function extractToolCalls(message: BaseMessage): { id: string; name: string; args: Record<string, unknown> }[] {
  const msg = message as any;

  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    return msg.tool_calls
      .filter((tc: any) => tc.name && tc.args)
      .map((tc: any) => ({
        id: tc.id || `call_${crypto.randomUUID()}`,
        name: tc.name,
        args: tc.args as Record<string, unknown>,
      }));
  }

  if (msg.additional_kwargs?.tool_calls && Array.isArray(msg.additional_kwargs.tool_calls)) {
    return msg.additional_kwargs.tool_calls
      .filter((tc: any) => tc.function?.name)
      .map((tc: any) => ({
        id: tc.id || `call_${crypto.randomUUID()}`,
        name: tc.function.name,
        args: typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments || {},
      }));
  }

  return [];
}

/** 回退：无工具绑定时的普通流式 */
async function* fallbackStream(
  model: ChatOpenAI,
  messages: BaseMessage[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const stream = await model.stream(messages, { signal });
  for await (const chunk of stream) {
    if (signal?.aborted) break;
    const content = chunk.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');
    }
    if (text) {
      yield { type: 'text', content: text };
    }
  }
}
