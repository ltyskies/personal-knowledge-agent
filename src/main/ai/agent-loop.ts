/**
 * Agent 循环 — Tool-call-aware 流式生成器
 *
 * 实现 ReAct 风格的 agent 循环：
 * 1. 将系统提示词和工具绑定到 ChatOpenAI 模型
 * 2. 流式调用模型，逐块产出文本
 * 3. 检测 tool_calls → 执行工具 → 将结果反馈给模型 → 继续生成
 * 4. 循环直到模型不再调用工具或达到最大迭代次数
 *
 * 事件类型：
 * - text:  普通文本块（发给 renderer 显示）
 * - done:  生成完成
 * - tool_call / tool_result: 工具调用事件（发给 renderer 展示状态）
 */
import type { ChatOpenAI } from '@langchain/openai';
import type { StructuredTool } from '@langchain/core/tools';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ToolCallEvent, ToolResultEvent } from '../../shared/types';
import { truncateToolResult, estimateMessagesTokenCount } from './context-compressor';

export interface AgentTextEvent {
  type: 'text';
  content: string;
}

export interface AgentDoneEvent {
  type: 'done';
}

export type AgentEvent = AgentTextEvent | AgentDoneEvent | ToolCallEvent | ToolResultEvent;

const TOOL_SYSTEM_PROMPT = `You are a personal knowledge management assistant. You have access to a local Markdown knowledge base with the following tools:

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

/**
 * 运行 tool-aware agent 循环
 *
 * @param model - ChatOpenAI 实例（不绑定工具）
 * @param tools - 可用的 LangChain 工具列表
 * @param messages - 对话历史（LangChain BaseMessage 格式）
 * @param signal - 用于中止的 AbortSignal
 * @param maxIterations - 最大循环迭代次数，防止无限循环
 */
export async function* runAgentLoop(
  model: ChatOpenAI,
  tools: StructuredTool[],
  messages: BaseMessage[],
  signal?: AbortSignal,
  maxIterations: number = 10,
): AsyncGenerator<AgentEvent> {
  // 注入系统提示词（如果尚未存在）
  const systemMsg = new SystemMessage(TOOL_SYSTEM_PROMPT);
  const hasSystemMsg = messages.some(
    (m) => m._getType() === 'system',
  );

  // 绑定工具
  const modelWithTools = model.bindTools(tools);
  if (!modelWithTools) {
    // bindTools 返回 undefined 时回退到普通流式
    yield* fallbackStream(model, messages, signal);
    yield { type: 'done' };
    return;
  }

  // 构建初始消息列表，包含系统提示词
  const conversationMessages: BaseMessage[] = hasSystemMsg
    ? [...messages]
    : [systemMsg, ...messages];

  const gatheredToolCalls: Map<string, { name: string; args: Record<string, unknown> }> = new Map();

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) break;

    let gathered: BaseMessage | null = null;

    try {
      const stream = await modelWithTools.stream(conversationMessages, {
        signal,
      });

      for await (const chunk of stream) {
        if (signal?.aborted) break;

        // 累积完整的 chunk（包含 tool_call 信息）
        if (!gathered) {
          gathered = chunk;
        } else if ('concat' in gathered && typeof (gathered as any).concat === 'function') {
          gathered = (gathered as any).concat(chunk);
        }

        // 提取文本内容并发送
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

      // 没有累积到任何回复 → 结束
      if (!gathered) {
        yield { type: 'done' };
        return;
      }

      // 将 assistant 回复加入对话历史
      conversationMessages.push(gathered);

      // 检测 tool_calls
      const toolCalls = extractToolCalls(gathered);

      if (toolCalls.length === 0) {
        // 无工具调用，正常结束
        yield { type: 'done' };
        return;
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

        const toolResultEvent: ToolResultEvent = {
          type: 'tool_result',
          toolCallId: tc.id,
          toolName: tc.name,
          result,
          error,
        };
        yield toolResultEvent;

        // 将工具结果反馈给模型（截断过长结果）
        const truncatedResult = error
          ? `Error: ${error}`
          : truncateToolResult(result);
        const toolMsg = new ToolMessage({
          content: truncatedResult,
          tool_call_id: tc.id,
        });
        conversationMessages.push(toolMsg);
      }

      // 截断过旧的工具消息，控制 agent 循环内上下文膨胀
      compressOldToolMessages(conversationMessages);
    } catch (err) {
      if (signal?.aborted) break;
      // 流式错误 — 作为最后的错误事件输出并结束
      throw err;
    }
  }

  yield { type: 'done' };
}

/** 截断过旧的工具消息，防止 agent 循环内上下文膨胀 */
function compressOldToolMessages(messages: BaseMessage[], keepRecent: number = 6): void {
  let toolCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg._getType?.() === 'tool' || msg.constructor?.name === 'ToolMessage') {
      toolCount++;
      if (toolCount > keepRecent) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content.length > 300) {
          msg.content = content.slice(0, 300) + '\n...[早期工具结果已截断]';
        }
      }
    }
  }
}

/** 从 LangChain BaseMessage 中提取 tool_calls */
function extractToolCalls(message: BaseMessage): { id: string; name: string; args: Record<string, unknown> }[] {
  const msg = message as any;

  // LangChain AIMessage 的 tool_calls 字段
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    return msg.tool_calls
      .filter((tc: any) => tc.name && tc.args)
      .map((tc: any) => ({
        id: tc.id || `call_${crypto.randomUUID()}`,
        name: tc.name,
        args: tc.args as Record<string, unknown>,
      }));
  }

  // 兼容 additional_kwargs 中的 tool_calls（某些模型返回格式）
  if (msg.additional_kwargs?.tool_calls && Array.isArray(msg.additional_kwargs.tool_calls)) {
    return msg.additional_kwargs.tool_calls
      .filter((tc: any) => tc.function?.name)
      .map((tc: any) => ({
        id: tc.id || `call_${crypto.randomUUID()}`,
        name: tc.function.name,
        args: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments || {},
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
