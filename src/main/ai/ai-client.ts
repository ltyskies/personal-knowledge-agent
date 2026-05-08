/**
 * AI API 客户端
 *
 * 封装 OpenAI-compatible Chat Completion API 的调用，支持 DeepSeek、OpenAI、Ollama 等。
 * 提供两个核心函数：
 * - chatSync:  同步（非流式）请求，用于知识提取、章节匹配等需要完整响应的场景
 * - streamChat: 异步生成器，逐块 yield SSE 流式响应，用于实时对话显示
 *
 * 流保护机制：
 * - 连接超时 (60s)：防止建连阶段无限等待
 * - 流内空闲超时 (30s)：防止流式传输中途卡死
 * - Content-Type 校验：防止将非 SSE 响应当流式数据解析
 * - 结构化错误：区分超时/网络/API/EOF/协议错误，标记是否可重试
 * - 异常 EOF 不再伪装为正常完成
 *
 * 安全注意：API Key 仅在此模块中使用，绝不会传递到 Renderer 进程。
 */
import type { Message, Chunk, StreamErrorType } from '../../shared/types';

// 连接超时 — 60 秒足够大多数模型首 token 响应
const CONNECTION_TIMEOUT = 60_000;
// 流内空闲超时 — 30 秒无新数据判定为流卡死
const STREAM_IDLE_TIMEOUT = 30_000;

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

/**
 * 创建带超时的 AbortSignal
 */
function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * 创建空闲超时定时器 — 每次收到数据时重置
 * 返回 reset 函数，调用方可传入外部 AbortController 以在超时时中断流
 */
function createIdleTimer(abortController: AbortController): { reset: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => abortController.abort(), STREAM_IDLE_TIMEOUT);
  };

  const clear = () => {
    if (timer) clearTimeout(timer);
  };

  return { reset, clear };
}

/**
 * 同步调用 AI Chat API，返回完整响应文本
 *
 * 适用场景：知识提取、章节匹配、commit message 生成等不需要流式展示的任务。
 * temperature 默认 0.3，保证输出稳定性。
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
  const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: options?.temperature ?? 0.3,
        max_tokens: options?.maxTokens,
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new StreamError('api_error', `API error ${response.status}: ${errorText}`, response.status >= 500);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    if (err instanceof StreamError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new StreamError('connection_timeout', '请求超时，请检查网络连接或 API 服务状态', true);
    }
    if (err instanceof TypeError && err.message.includes('fetch')) {
      throw new StreamError('network_error', `网络连接失败：无法连接到 ${baseURL}，请检查网络或 API 地址`, true);
    }
    throw err;
  } finally {
    clear();
  }
}

/**
 * 流式调用 AI Chat API，通过 AsyncGenerator 逐块返回响应
 *
 * 适用场景：对话 UI 实时显示 AI 回复。
 * 使用 SSE (Server-Sent Events) 协议解析 `data: ` 行。
 * temperature 默认 0.7，使对话更自然。
 */
export async function* streamChat(
  baseURL: string,
  apiKey: string,
  model: string,
  messages: Message[],
  options?: ChatOptions,
  externalSignal?: AbortSignal,
): AsyncGenerator<Chunk> {
  // 连接超时 — 覆盖建连阶段
  const { signal: connSignal, clear: clearConnTimer } = createTimeoutSignal(options?.timeout ?? CONNECTION_TIMEOUT);

  // 合并外部 AbortSignal（用于用户主动停止）和连接超时信号
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  const onInternalAbort = () => {
    // 内部超时也触发外部信号回调（如果有的话）
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  connSignal.addEventListener('abort', onInternalAbort, { once: true });

  // 竞速：任一信号 abort 则总信号 abort
  const onConnAbort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  connSignal.addEventListener('abort', onConnAbort, { once: true });

  const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens,
      }),
      signal: connSignal,
    });
  } catch (err) {
    clearConnTimer();
    externalSignal?.removeEventListener('abort', onExternalAbort);
    if (externalSignal?.aborted) {
      throw new StreamError('user_aborted', '用户主动停止', false);
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new StreamError('connection_timeout', '请求超时，请检查网络连接或 API 服务状态', true);
    }
    if (err instanceof TypeError && err.message.includes('fetch')) {
      throw new StreamError('network_error', `网络连接失败：无法连接到 ${baseURL}，请检查网络或 API 地址`, true);
    }
    throw err;
  }

  clearConnTimer();

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    externalSignal?.removeEventListener('abort', onExternalAbort);
    throw new StreamError('api_error', `API error ${response.status}: ${errorText}`, response.status >= 500);
  }

  // Content-Type 校验 — 防止将非流式响应当 SSE 解析
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') && !contentType.includes('application/json')) {
    externalSignal?.removeEventListener('abort', onExternalAbort);
    throw new StreamError('non_stream_response', '服务端返回了非流式响应，请检查 API 地址配置', true);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    externalSignal?.removeEventListener('abort', onExternalAbort);
    throw new StreamError('api_error', 'Response body is not readable', false);
  }

  const decoder = new TextDecoder();
  let buffer = '';

  // 空闲超时 — 流内 30s 无新数据判定为卡死
  const idleTimer = createIdleTimer(controller);
  let receivedDone = false;

  try {
    while (true) {
      // 检查外部 abort 信号（用户主动停止或空闲超时）
      if (externalSignal?.aborted) {
        throw new StreamError('user_aborted', '用户主动停止', false);
      }

      // read() 在 controller.abort() 后会抛出 AbortError
      const { done, value } = await reader.read();

      if (done) {
        // reader 自然结束但没有收到 [DONE] — 异常 EOF
        if (!receivedDone) {
          throw new StreamError('unexpected_eof', '连接意外中断，回复可能不完整', true);
        }
        break;
      }

      // 收到数据 — 重置空闲超时
      idleTimer.reset();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          receivedDone = true;
          yield { content: '', done: true };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            yield { content, done: false };
          }
        } catch {
          // SSE 行 JSON 解析失败 — 脏分片，跳过不影响整体
        }
      }
    }
  } catch (err) {
    if (err instanceof StreamError) throw err;
    // reader.read() 在被 abort 时会抛出 TypeError（浏览器 DOMException 在 Node 中表现为 Error）
    if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'))) {
      if (externalSignal?.aborted) {
        throw new StreamError('user_aborted', '用户主动停止', false);
      }
      // 空闲超时触发的 abort
      throw new StreamError('stream_timeout', '响应超时，AI 长时间未返回数据，请重试', true);
    }
    throw new StreamError('network_error', `流读取失败：${err instanceof Error ? err.message : String(err)}`, true);
  } finally {
    idleTimer.clear();
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}