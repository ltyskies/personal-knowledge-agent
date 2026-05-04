/**
 * 对话视图组件
 *
 * 核心聊天界面，包含：
 * - 消息列表（用户消息蓝色气泡右对齐，AI 回复 Markdown 渲染左对齐）
 * - 流式输出光标闪烁动画
 * - 提取知识点按钮（对话结束后出现）
 * - 自动合并进度指示器
 * - Toast 通知（合并完成 / 错误）
 *
 * 数据由父组件 App 通过 props 传入，状态管理在 useChat hook 中完成。
 */
import { useRef, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { Message, KnowledgeItem } from '../../shared/types';
import InputArea from './InputArea';

interface ChatViewProps {
  messages: Message[];
  isStreaming: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onClearError: () => void;
  isExtracting: boolean;
  extractError: string | null;
  extractedItems: KnowledgeItem[] | null;
  onExtract: () => void;
  onClearExtraction: () => void;
  isAutoMerging: boolean;
  autoMergeProgress: { done: number; total: number } | null;
}

export default function ChatView({
  messages,
  isStreaming,
  error,
  onSend,
  onClearError,
  isExtracting,
  extractError,
  extractedItems,
  onExtract,
  onClearExtraction,
  isAutoMerging,
  autoMergeProgress,
}: ChatViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [mergeDone, setMergeDone] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // 新消息到达时自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, extractedItems, isAutoMerging, autoMergeProgress]);

  // 检测合并完成（isAutoMerging 从 true 变为 false 且有进度记录）
  const wasMergingRef = useRef(false);
  useEffect(() => {
    if (wasMergingRef.current && !isAutoMerging && autoMergeProgress === null) {
      setMergeDone(true);
      const count = extractedItems?.length ?? 0;
      setToast({ message: `已合并 ${count} 条知识点`, type: 'success' });
    }
    wasMergingRef.current = isAutoMerging;
  }, [isAutoMerging, autoMergeProgress, extractedItems]);

  // 提取结果变化时重置合并完成状态
  useEffect(() => {
    setMergeDone(false);
  }, [extractedItems]);

  // Toast 5 秒后自动消失
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const hasMessages = messages.length > 0;
  const showExtractButton = hasMessages && !isStreaming && !extractedItems && !isExtracting && !isAutoMerging;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {/* 错误提示 */}
        {error && (
          <div className="mb-3 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-600 dark:text-red-400 flex items-center justify-between">
            <span>{error}</span>
            <button
              onClick={onClearError}
              className="ml-2 text-red-400 hover:text-red-600 shrink-0"
            >
              x
            </button>
          </div>
        )}

        {/* Toast 通知 */}
        {toast && (
          <div
            className={`mb-3 px-4 py-2 rounded-md text-sm flex items-center gap-2 ${
              toast.type === 'success'
                ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400'
                : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400'
            }`}
          >
            {toast.type === 'success' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            {toast.message}
          </div>
        )}

        {/* 空状态提示 */}
        {messages.length === 0 && !isStreaming ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            开始一段对话，AI 将自动为你提取并沉淀知识
          </div>
        ) : (
          messages.map((msg, i) => (
            <div
              key={i}
              className={`mb-4 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}
            >
              <div
                className={`inline-block max-w-[80%] text-sm text-left ${
                  msg.role === 'user'
                    ? 'bg-blue-500 text-white px-4 py-2 rounded-lg'
                    : 'text-gray-800 dark:text-gray-200'
                }`}
              >
                {msg.role === 'user' ? (
                  msg.content
                ) : (
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content || (isStreaming && i === messages.length - 1 ? '...' : '')}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          ))
        )}

        {/* 流式输出光标动画 — 仅在 AI 正在回复且有内容时显示 */}
        {isStreaming && messages.length > 0 && messages[messages.length - 1].content && (
          <span className="inline-block w-2 h-4 bg-blue-500 animate-pulse ml-1" />
        )}

        {/* 提取知识点按钮 — 对话结束、未提取、未合并时显示 */}
        {showExtractButton && (
          <div className="flex justify-center mb-4">
            <button
              onClick={onExtract}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-full text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-700 transition-colors"
            >
              <Sparkles size={14} />
              提取知识点
            </button>
          </div>
        )}

        {/* 提取中加载提示 */}
        {isExtracting && (
          <div className="mb-4 px-4 py-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
            <div className="flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400">
              <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              正在从对话中提取知识点...
            </div>
          </div>
        )}

        {/* 自动合并进度 */}
        {isAutoMerging && autoMergeProgress && (
          <div className="mb-4 px-4 py-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md">
            <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
              <span className="inline-block w-3 h-3 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
              正在合并知识点到知识库...（{autoMergeProgress.done}/{autoMergeProgress.total}）
            </div>
          </div>
        )}

        {/* 提取失败错误 */}
        {extractError && (
          <div className="mb-4 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-600 dark:text-red-400 flex items-center justify-between">
            <span>提取失败：{extractError}</span>
            <button onClick={onClearExtraction} className="ml-2 text-red-400 hover:text-red-600 shrink-0">x</button>
          </div>
        )}

        {/* 提取结果摘要 */}
        {extractedItems && (
          <div className="mb-4 flex items-center justify-between px-1">
            <span className="text-xs font-medium text-gray-500">
              {mergeDone
                ? `已合并 ${extractedItems.length} 条知识点`
                : `提取到 ${extractedItems.length} 条知识点`}
            </span>
            <button
              onClick={onClearExtraction}
              className="text-gray-400 hover:text-gray-600"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* 滚动锚点 — 新内容出现时自动滚到此处 */}
        <div ref={bottomRef} />
      </div>

      <InputArea onSend={onSend} disabled={isStreaming} />
    </div>
  );
}
