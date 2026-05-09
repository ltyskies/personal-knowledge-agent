/**
 * 对话状态管理 Hook
 *
 * 管理对话的完整生命周期：
 * 1. 消息列表维护（发送新消息、接收流式响应、按 requestId 精确定位）
 * 2. 流式数据处理（监听 chat:stream-chunk 事件，累积文本并更新 requestId 对应的 assistant 消息）
 * 3. 知识点提取（调用 chat:extract → kb:matchChapters）
 * 4. 自动合并（遍历提取结果，依次调用 kb:autoMerge 写入知识库）
 * 5. 异常恢复与重试（用户停止、网络中断、超时、API 错误的状态归因与一键重试）
 *
 * 数据流（流式响应）：
 *   Renderer send(userMsg) → IPC chat:stream → Main 调用 AI API
 *   → Main 逐块推送 chat:stream-chunk → Renderer 累积显示
 *
 * 数据流（知识提取合并）：
 *   Renderer extract() → chat:extract → Main AI 调用 → 返回 KnowledgeItem[]
 *   → kb:matchChapters → Main AI 调用 → 返回 ChapterMatch[]
 *   → 遍历 items → kb:autoMerge → Main 合并+写入+commit
 *
 * 请求粒度的消息模型：
 * - 每轮 user+assistant 共享同一个 requestId
 * - 流式更新按 requestId 定位消息，不依赖列表尾部假设
 * - 重试复用原 requestId 和原 user 消息，在原位置替换 assistant
 * - 历史恢复时检测未完成轮次，补本地占位 assistant 并给出重试入口
 *
 * 重要细节：
 * - streamingContentRef 持有当前流式累积文本，避免闭包陷阱
 * - messagesRef 持有最新消息列表，供 send 时间点快照使用
 * - loadedIdRef 跟踪已加载的对话 ID，避免重复加载
 * - 流式结束时通过 onMessagesChange 回调通知父组件触发自动保存
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import type { Message, Chunk, KnowledgeItem, ChapterMatch, StreamErrorInfo, StreamStatus } from '../../shared/types';

interface UseChatOptions {
  conversationId: string | null;
  onMessagesChange?: (messages: Message[]) => void;
  onAutoMergeComplete?: () => void;
}

interface UseChatReturn {
  messages: Message[];
  isStreaming: boolean;
  error: string | null;
  send: (text: string) => void;
  retry: (requestId: string) => void;
  stop: () => void;
  clearError: () => void;
  isExtracting: boolean;
  extractError: string | null;
  extractedItems: KnowledgeItem[] | null;
  chapterMatches: ChapterMatch[] | null;
  extract: () => Promise<void>;
  clearExtraction: () => void;
  isAutoMerging: boolean;
  autoMergeProgress: { done: number; total: number } | null;
}

/** 生成简短的唯一请求标识 */
function generateRequestId(): string {
  return crypto.randomUUID();
}

/** 根据错误类型推导 StreamStatus */
function errorTypeToStatus(type: string): { status: StreamStatus; retryable: boolean } {
  switch (type) {
    case 'user_aborted':
      return { status: 'interrupted', retryable: true };
    case 'stream_timeout':
    case 'unexpected_eof':
      return { status: 'interrupted', retryable: true };
    case 'connection_timeout':
    case 'network_error':
    case 'non_stream_response':
      return { status: 'failed', retryable: true };
    case 'api_error':
      return { status: 'failed', retryable: true };
    default:
      return { status: 'failed', retryable: true };
  }
}

export function useChat({ conversationId, onMessagesChange, onAutoMergeComplete }: UseChatOptions): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractedItems, setExtractedItems] = useState<KnowledgeItem[] | null>(null);
  const [chapterMatches, setChapterMatches] = useState<ChapterMatch[] | null>(null);
  const [isAutoMerging, setIsAutoMerging] = useState(false);
  const [autoMergeProgress, setAutoMergeProgress] = useState<{ done: number; total: number } | null>(null);

  // 使用 ref 避免闭包陷阱：流式累积过程中 state 可能不是最新值
  const streamingContentRef = useRef('');
  const streamingRequestIdRef = useRef<string | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const loadedIdRef = useRef<string | null>(null);
  const prevStreamingRef = useRef(false);
  // 标记流式是否正常完成（done chunk 到达），区分于强制停止/切换对话
  const streamingCompletedNormallyRef = useRef(false);

  // 对话切换时：清空当前状态，加载新对话的消息
  useEffect(() => {
    if (!conversationId || conversationId === loadedIdRef.current) return;

    // 如果正在流式输出，先停止
    if (isStreaming) {
      window.knowledgeAgent.chat.stop();
    }

    setIsStreaming(false);
    streamingContentRef.current = '';
    streamingRequestIdRef.current = null;
    streamingCompletedNormallyRef.current = false;
    // 立即清空消息，防止旧对话消息残留导致自动保存写错文件
    setMessages([]);

    window.knowledgeAgent.conversation.get(conversationId).then((data) => {
      const conv = data as { messages: Message[] } | null;
      if (conv) {
        const recovered = recoverIncompleteRounds(conv.messages);
        setMessages(recovered);
        clearExtraction();
      }
    }).catch(() => {
      setMessages([]);
    });

    loadedIdRef.current = conversationId;
  }, [conversationId]);

  // 同步 messagesRef 与 state，确保 send 中使用最新消息列表
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // 流式输出正常完成时通知父组件（触发自动保存）
  // 仅在 done chunk 到达导致 isStreaming → false 时触发，排除主动停止/切换对话
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && messages.length > 0 && streamingCompletedNormallyRef.current) {
      onMessagesChange?.(messages);
      streamingCompletedNormallyRef.current = false;
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, messages, onMessagesChange]);

  /**
   * 历史恢复：检测未完成的请求轮次，补本地 assistant 占位消息
   *
   * 策略：
   * - 旧消息无 status 字段 → 视为 completed，不做修改
   * - user 消息 status !== 'completed' 且没有对应的 completed assistant → 补占位
   * - 不在持久化的半截 assistant 文本上做恢复，只标记"未完成可重试"
   */
  function recoverIncompleteRounds(msgs: Message[]): Message[] {
    const result = [...msgs];
    let insertedCount = 0;

    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      if (msg.role !== 'user') continue;
      // 旧消息无 status 或 status 为 completed → 跳过
      if (!msg.status || msg.status === 'completed') continue;

      // 检查下一跳是否是同 requestId 且 completed 的 assistant
      const nextMsg = msgs[i + 1];
      const hasCompletedAssistant =
        nextMsg &&
        nextMsg.role === 'assistant' &&
        nextMsg.requestId === msg.requestId &&
        nextMsg.status === 'completed';

      if (!hasCompletedAssistant) {
        const placeholder: Message = {
          role: 'assistant',
          content: '',
          requestId: msg.requestId,
          status: msg.status,
          retryable: msg.retryable !== false,
          errorMessage: msg.errorMessage || '该回复未完成，可重试',
        };
        // 插入到 user 消息之后
        result.splice(i + 1 + insertedCount, 0, placeholder);
        insertedCount++;
      }
    }

    return result;
  }

  // 注册流式数据监听器（组件挂载时注册，卸载时清理）
  useEffect(() => {
    const handleChunk = (chunk: unknown) => {
      const c = chunk as Chunk;
      const requestId = streamingRequestIdRef.current;
      if (!requestId) return;

      if (c.done) {
        // 流正常结束：将累积内容写入并标记 completed
        const finalContent = streamingContentRef.current;
        streamingCompletedNormallyRef.current = true;
        setMessages((prev) =>
          prev.map((m) =>
            m.requestId === requestId && m.role === 'assistant'
              ? { ...m, content: finalContent, status: 'completed' as StreamStatus, errorMessage: undefined, reasoning_content: c.reasoning_content }
              : m,
          ),
        );
        streamingContentRef.current = '';
        streamingRequestIdRef.current = null;
        setIsStreaming(false);
      } else {
        // 流进行中：累积内容并实时更新 UI
        streamingContentRef.current += c.content;
        const accumulated = streamingContentRef.current;
        setMessages((prev) =>
          prev.map((m) =>
            m.requestId === requestId && m.role === 'assistant'
              ? { ...m, content: accumulated }
              : m,
          ),
        );
      }
    };

    const handleStreamError = (err: unknown) => {
      const errorInfo = err as StreamErrorInfo;
      const requestId = streamingRequestIdRef.current;

      // 用户主动停止 — 已在 stop() 中预先设置了状态，这里只收尾
      if (errorInfo.type === 'user_aborted') {
        streamingContentRef.current = '';
        streamingRequestIdRef.current = null;
        setIsStreaming(false);
        return;
      }

      const { status, retryable } = errorTypeToStatus(errorInfo.type);

      // 按 requestId 精确定位并更新 assistant 消息状态
      if (requestId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.requestId === requestId && m.role === 'assistant'
              ? {
                  ...m,
                  status,
                  retryable,
                  errorMessage: errorInfo.message,
                  // interrupted 时保留 partial 内容，failed 时也保留（让用户看到已生成内容）
                }
              : m,
          ),
        );
        // 同时标记对应的 user 消息状态
        setMessages((prev) =>
          prev.map((m) =>
            m.requestId === requestId && m.role === 'user'
              ? { ...m, status, retryable, errorMessage: errorInfo.message }
              : m,
          ),
        );
      }

      streamingContentRef.current = '';
      streamingRequestIdRef.current = null;
      setIsStreaming(false);
      // 全局错误条也显示（兼容现有 UI）
      setError(errorInfo.message);
    };

    window.knowledgeAgent.chat.onChunk(handleChunk);
    window.knowledgeAgent.chat.onError(handleStreamError);
    return () => {
      window.knowledgeAgent.chat.offChunk();
      window.knowledgeAgent.chat.offError();
    };
  }, []);

  /**
   * 构建发送给 AI 的消息历史
   * 排除未完成的 assistant 消息（失败/中断轮次的无效内容不应污染上下文）
   */
  function buildContextMessages(msgs: Message[]): Message[] {
    return msgs
      .filter((m) => {
        if (m.role === 'system') return true;
        if (m.role === 'user') return true;
        // assistant: 只包含 completed 的消息
        if (m.role === 'assistant') {
          return m.status === 'completed' || !m.status;
        }
        return true;
      })
      .map((m) => {
        const msg: Message = { role: m.role, content: m.content };
        if (m.reasoning_content) msg.reasoning_content = m.reasoning_content;
        return msg;
      });
  }

  const send = useCallback(
    (text: string) => {
      if (isStreaming) return;

      const requestId = generateRequestId();
      const userMsg: Message = { role: 'user', content: text, requestId, status: 'completed' };
      const assistantMsg: Message = { role: 'assistant', content: '', requestId, status: 'pending' };

      const allMessages = [...messagesRef.current, userMsg];

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);
      setError(null);
      streamingContentRef.current = '';
      streamingRequestIdRef.current = requestId;
      streamingCompletedNormallyRef.current = false;

      const ctxMessages = buildContextMessages(allMessages);
      window.knowledgeAgent.chat.stream(ctxMessages).catch((err: unknown) => {
        // 如果错误已在 handleStreamError 中处理（IPC 推送），这里的 catch 作为兜底
        const msg = err instanceof Error ? err.message : String(err);
        if (streamingRequestIdRef.current === requestId) {
          setError(msg);
          setIsStreaming(false);
          setMessages((prev) =>
            prev.map((m) =>
              m.requestId === requestId && m.role === 'assistant'
                ? { ...m, status: 'failed' as StreamStatus, retryable: true, errorMessage: msg }
                : m,
            ),
          );
          streamingContentRef.current = '';
          streamingRequestIdRef.current = null;
        }
      });
    },
    [isStreaming],
  );

  /** 主动停止当前流式输出 */
  const stop = useCallback(() => {
    if (!isStreaming) return;

    streamingCompletedNormallyRef.current = false;
    const requestId = streamingRequestIdRef.current;
    if (requestId) {
      // 先标记 assistant 为 interrupted（保留已生成内容）
      setMessages((prev) =>
        prev.map((m) =>
          m.requestId === requestId && m.role === 'assistant'
            ? { ...m, status: 'interrupted' as StreamStatus, retryable: true, errorMessage: '用户主动停止' }
            : m,
        ),
      );
      // 同时标记 user
      setMessages((prev) =>
        prev.map((m) =>
          m.requestId === requestId && m.role === 'user'
            ? { ...m, status: 'interrupted' as StreamStatus }
            : m,
        ),
      );
    }

    window.knowledgeAgent.chat.stop();
    streamingContentRef.current = '';
    streamingRequestIdRef.current = null;
    setIsStreaming(false);
  }, [isStreaming]);

  /**
   * 重试未完成的请求轮次
   *
   * 复用原 requestId 和原 user 消息，在原位置重置 assistant 并重新流式请求。
   * 不会新增一组 user/assistant 历史消息。
   */
  const retry = useCallback(
    (requestId: string) => {
      if (isStreaming) return;

      const msgs = messagesRef.current;
      const userIndex = msgs.findIndex((m) => m.requestId === requestId && m.role === 'user');
      if (userIndex === -1) return;

      // 构建消息历史：取到该 user 消息为止（包含它），排除后面的失败 assistant
      const historyUpToUser = msgs.slice(0, userIndex + 1);

      // 重置 assistant 消息为 pending
      setMessages((prev) =>
        prev.map((m) =>
          m.requestId === requestId && m.role === 'assistant'
            ? { ...m, content: '', status: 'pending' as StreamStatus, retryable: undefined, errorMessage: undefined }
            : m,
        ),
      );
      // 重置 user 消息状态
      setMessages((prev) =>
        prev.map((m) =>
          m.requestId === requestId && m.role === 'user'
            ? { ...m, status: 'completed' as StreamStatus, retryable: undefined, errorMessage: undefined }
            : m,
        ),
      );

      setIsStreaming(true);
      setError(null);
      streamingContentRef.current = '';
      streamingRequestIdRef.current = requestId;
      streamingCompletedNormallyRef.current = false;

      const ctxMessages = buildContextMessages(historyUpToUser);
      window.knowledgeAgent.chat.stream(ctxMessages).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (streamingRequestIdRef.current === requestId) {
          setError(msg);
          setIsStreaming(false);
          setMessages((prev) =>
            prev.map((m) =>
              m.requestId === requestId && m.role === 'assistant'
                ? { ...m, status: 'failed' as StreamStatus, retryable: true, errorMessage: msg }
                : m,
            ),
          );
          streamingContentRef.current = '';
          streamingRequestIdRef.current = null;
        }
      });
    },
    [isStreaming],
  );

  const clearError = useCallback(() => setError(null), []);

  /**
   * 知识点提取 + 自动合并流程
   *
   * 1. 调用 chat:extract 从对话中提取知识点
   * 2. 调用 kb:matchChapters 匹配到知识库已有章节
   * 3. 遍历每个知识点，调用 kb:autoMerge 自动合并写入
   *
   * 合并过程中显示进度（autoMergeProgress），
   * 单个知识点的合并失败不中断整体流程。
   */
  const extract = useCallback(async () => {
    if (messagesRef.current.length === 0 || isExtracting) return;

    setIsExtracting(true);
    setExtractError(null);
    setExtractedItems(null);
    setChapterMatches(null);

    let items: KnowledgeItem[] = [];
    let matches: ChapterMatch[] = [];

    try {
      items = await window.knowledgeAgent.chat.extract(messagesRef.current);
      setExtractedItems(items);

      if (items.length > 0) {
        matches = await window.knowledgeAgent.kb.matchChapters(items);
        setChapterMatches(matches);
      }
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : String(err));
      setIsExtracting(false);
      return;
    } finally {
      setIsExtracting(false);
    }

    // 自动合并每个提取到的知识点
    if (items.length > 0) {
      setIsAutoMerging(true);
      setAutoMergeProgress({ done: 0, total: items.length });

      for (let i = 0; i < items.length; i++) {
        const match = matches[i] ?? { id: '', filePath: '', heading: '' };
        try {
          await window.knowledgeAgent.kb.autoMerge({
            knowledgeItem: items[i],
            chapterMatch: match,
          });
        } catch {
          // 单个合并失败不中断，继续处理剩余知识点
        }
        setAutoMergeProgress({ done: i + 1, total: items.length });
      }

      setIsAutoMerging(false);
      setAutoMergeProgress(null);
      onAutoMergeComplete?.();
    }
  }, [isExtracting, onAutoMergeComplete]);

  const clearExtraction = useCallback(() => {
    setExtractedItems(null);
    setChapterMatches(null);
    setExtractError(null);
    setIsAutoMerging(false);
    setAutoMergeProgress(null);
  }, []);

  return {
    messages,
    isStreaming,
    error,
    send,
    retry,
    stop,
    clearError,
    isExtracting,
    extractError,
    extractedItems,
    chapterMatches,
    extract,
    clearExtraction,
    isAutoMerging,
    autoMergeProgress,
  };
}