/**
 * AI API 客户端
 *
 * 封装 OpenAI-compatible Chat Completion API 的调用，支持 DeepSeek、OpenAI、Ollama 等。
 * 提供两个核心函数：
 * - chatSync:  同步（非流式）请求，用于知识提取、章节匹配等需要完整响应的场景
 * - streamChat: 异步生成器，逐块 yield SSE 流式响应，用于实时对话显示
 *
 * 安全注意：API Key 仅在此模块中使用，绝不会传递到 Renderer 进程。
 */
import type { Message, Chunk } from '../shared/types';

// 默认超时时间 — 60 秒足够大多数模型响应
const DEFAULT_TIMEOUT = 60_000;

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

/**
 * 创建带超时的 AbortSignal
 * 避免网络请求无限挂起，超时后自动中断
 */
function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
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
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const { signal, clear } = createTimeoutSignal(timeout);
  // 去除末尾斜杠，防止双斜杠导致 404
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
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    // 区分超时错误与网络连接错误，给出中文提示
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('请求超时，请检查网络连接或 API 服务状态');
    }
    if (err instanceof TypeError && err.message.includes('fetch')) {
      throw new Error(`网络连接失败：无法连接到 ${baseURL}，请检查网络或 API 地址`);
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
): AsyncGenerator<Chunk> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const { signal, clear } = createTimeoutSignal(timeout);
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
      signal,
    });
  } catch (err) {
    clear();
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('请求超时，请检查网络连接或 API 服务状态');
    }
    if (err instanceof TypeError && err.message.includes('fetch')) {
      throw new Error(`网络连接失败：无法连接到 ${baseURL}，请检查网络或 API 地址`);
    }
    throw err;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    clear();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  // ReadableStream 读取器 — 逐字节读取 SSE 流
  const reader = response.body?.getReader();
  if (!reader) {
    clear();
    throw new Error('Response body is not readable');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // 将新数据追加到缓冲区，然后按行解析
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 最后一行可能不完整，保留到下一次循环
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        // SSE 协议：`data: [DONE]` 表示流结束
        if (data === '[DONE]') {
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
          // 跳过无法解析的 JSON 行（某些 API 可能发送注释行）
        }
      }
    }

    // 流自然结束（没有收到 [DONE] 信号）
    yield { content: '', done: true };
  } finally {
    clear();
  }
}
