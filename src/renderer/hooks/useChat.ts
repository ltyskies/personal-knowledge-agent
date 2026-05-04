/**
 * 对话状态管理 Hook
 *
 * 管理对话的完整生命周期：
 * 1. 消息列表维护（发送新消息、接收流式响应）
 * 2. 流式数据处理（监听 chat:stream-chunk 事件，累积文本并更新最后一条 assistant 消息）
 * 3. 知识点提取（调用 chat:extract → kb:matchChapters）
 * 4. 自动合并（遍历提取结果，依次调用 kb:autoMerge 写入知识库）
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
 * 重要细节：
 * - streamingContentRef 持有当前流式累积文本，避免闭包陷阱
 * - messagesRef 持有最新消息列表，供 send 时间点快照使用
 * - loadedIdRef 跟踪已加载的对话 ID，避免重复加载
 * - 流式结束时通过 onMessagesChange 回调通知父组件触发自动保存
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import type { Message, Chunk, KnowledgeItem, ChapterMatch } from '../../shared/types';

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
  const messagesRef = useRef<Message[]>([]);
  const loadedIdRef = useRef<string | null>(null);
  const prevStreamingRef = useRef(false);

  // 对话切换时：清空当前状态，加载新对话的消息
  useEffect(() => {
    if (!conversationId || conversationId === loadedIdRef.current) return;

    // 重置流式状态
    setIsStreaming(false);
    streamingContentRef.current = '';

    window.knowledgeAgent.conversation.get(conversationId).then((data) => {
      const conv = data as { messages: Message[] } | null;
      if (conv) {
        setMessages(conv.messages);
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

  // 流式输出完成时通知父组件（触发自动保存）
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && messages.length > 0) {
      onMessagesChange?.(messages);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, messages, onMessagesChange]);

  // 注册流式数据监听器（组件挂载时注册，卸载时清理）
  useEffect(() => {
    const handleChunk = (chunk: unknown) => {
      const c = chunk as Chunk;
      if (c.done) {
        // 流结束：将累积的完整内容写入最后一条 assistant 消息
        const finalContent = streamingContentRef.current;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: finalContent };
          }
          return updated;
        });
        streamingContentRef.current = '';
        setIsStreaming(false);
      } else {
        // 流进行中：累积内容并实时更新 UI
        streamingContentRef.current += c.content;
        const accumulated = streamingContentRef.current;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: accumulated };
          }
          return updated;
        });
      }
    };

    const handleStreamError = (msg: string) => {
      setError(msg);
      setIsStreaming(false);
    };

    window.knowledgeAgent.chat.onChunk(handleChunk);
    window.knowledgeAgent.chat.onError(handleStreamError);
    return () => {
      window.knowledgeAgent.chat.offChunk();
      window.knowledgeAgent.chat.offError();
    };
  }, []);

  const send = useCallback(
    (text: string) => {
      if (isStreaming) return;

      const userMsg: Message = { role: 'user', content: text };
      const assistantMsg: Message = { role: 'assistant', content: '' };
      // 使用 ref 快照确保消息列表包含当前用户消息
      const allMessages = [...messagesRef.current, userMsg];

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);
      setError(null);

      window.knowledgeAgent.chat.stream(allMessages).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setIsStreaming(false);
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
