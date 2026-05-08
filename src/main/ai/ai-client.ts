/**
 * AI API 客户端 — LangChain 封装
 *
 * 使用 @langchain/openai 的 ChatOpenAI 替代原始 fetch() 调用，
 * 兼容 DeepSeek、OpenAI、Ollama 等所有 OpenAI-compatible API。
 *
 * 提供两个核心函数：
 * - chatSync:  同步（非流式）请求，用于知识提取、章节匹配等需要完整响应的场景
 * - streamChat: 异步生成器，逐块 yield 流式响应，用于实时对话显示
 *
 * 额外导出 createChatModel 工厂函数，供 agent-loop 使用。
 */
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { Message, Chunk, StreamErrorType } from '../../shared/types';

const CONNECTION_TIMEOUT = 60_000;

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

/** 流式错误 — 携带类型标记方便上游归因处理 */
export class StreamError extends Error {
  type: StreamErrorType;
  retryable: boolean;

  constructor(type: StreamErrorType, message: string, retryable: boolean) {
    super(message);
    this.name = 'StreamError';
    this.type = type;
    this.retryable = retryable;
  }
}

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** 将应用内 Message 转换为 LangChain BaseMessage */
export function toLangChainMessages(messages: Message[]): BaseMessage[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'user':
        return new HumanMessage(m.content);
      case 'assistant':
        return new AIMessage(m.content);
      case 'system':
        return new SystemMessage(m.content);
      default:
        return new HumanMessage(m.content);
    }
  });
}

/** 创建 ChatOpenAI 模型实例 — agent-loop 和内部函数共用 */
export function createChatModel(
  baseURL: string,
  apiKey: string,
  model: string,
  options?: ChatOptions,
): ChatOpenAI {
  return new ChatOpenAI({
    model,
    configuration: {
      baseURL: baseURL.replace(/\/$/, ''),
      apiKey,
    },
    temperature: options?.temperature ?? 0.7,
    maxTokens: options?.maxTokens,
  });
}

/**
 * 同步调用 AI Chat API，返回完整响应文本
 */
export async function chatSync(
  baseURL: string,
  apiKey: string,
  model: string,
  messages: Message[],
  options?: ChatOptions,
): Promise<string> {
  const timeout = options?.timeout ?? CONNECTION_TIMEOUT;
  const { signal, clear } = createTimeoutSignal(timeout);

  try {
    const chatModel = createChatModel(baseURL, apiKey, model, {
      temperature: options?.temperature ?? 0.3,
      maxTokens: options?.maxTokens,
    });
    const lcMessages = toLangChainMessages(messages);
    const response = await chatModel.invoke(lcMessages, { signal });

    const content = response.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');
    }
    return '';
  } catch (err) {
    if (err instanceof StreamError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new StreamError('connection_timeout', '请求超时，请检查网络连接或 API 服务状态', true);
    }
    if (err instanceof TypeError && err.message.includes('fetch')) {
      throw new StreamError('network_error', `网络连接失败：无法连接到 ${baseURL}，请检查网络或 API 地址`, true);
    }
    throw new StreamError('api_error', err instanceof Error ? err.message : String(err), true);
  } finally {
    clear();
  }
}

/**
 * 流式调用 AI Chat API，通过 AsyncGenerator 逐块返回响应
 */
export async function* streamChat(
  baseURL: string,
  apiKey: string,
  model: string,
  messages: Message[],
  options?: ChatOptions,
  externalSignal?: AbortSignal,
): AsyncGenerator<Chunk> {
  const { signal: connSignal, clear: clearConnTimer } = createTimeoutSignal(options?.timeout ?? CONNECTION_TIMEOUT);

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  connSignal.addEventListener(
    'abort',
    () => {
      if (!controller.signal.aborted) controller.abort();
    },
    { once: true },
  );

  try {
    const chatModel = createChatModel(baseURL, apiKey, model, options);
    const lcMessages = toLangChainMessages(messages);
    const stream = await chatModel.stream(lcMessages, { signal: connSignal });

    let receivedAny = false;
    for await (const chunk of stream) {
      if (externalSignal?.aborted) {
        throw new StreamError('user_aborted', '用户主动停止', false);
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
        receivedAny = true;
        yield { content: text, done: false };
      }
    }

    yield { content: '', done: true };
  } catch (err) {
    clearConnTimer();
    externalSignal?.removeEventListener('abort', onExternalAbort);

    if (err instanceof StreamError) throw err;
    if (externalSignal?.aborted) {
      throw new StreamError('user_aborted', '用户主动停止', false);
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new StreamError('connection_timeout', '请求超时，请检查网络连接或 API 服务状态', true);
    }
    if (err instanceof TypeError && err.message.includes('fetch')) {
      throw new StreamError('network_error', `网络连接失败：无法连接到 ${baseURL}，请检查网络或 API 地址`, true);
    }
    throw new StreamError('api_error', err instanceof Error ? err.message : String(err), true);
  } finally {
    clearConnTimer();
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
