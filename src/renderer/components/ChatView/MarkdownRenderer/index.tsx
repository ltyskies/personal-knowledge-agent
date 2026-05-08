/**
 * Markdown 渲染器 — 带局部错误边界和流式未闭合代码块修复
 *
 * 安全措施：
 * 1. 局部 ErrorBoundary：react-markdown 抛错时降级为原文 <pre> 显示，不拖崩整个消息区
 * 2. 未闭合代码块修复：pending/interrupted 状态下如果三反引号数量为奇数，自动补 closing fence
 * 3. 修复仅作用于渲染输入，不污染消息的真实 content
 */
import { Component, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { StreamStatus } from '../../../../shared/types';

interface MarkdownRendererProps {
  content: string;
  status?: StreamStatus;
}

/**
 * 检测并修复未闭合的三反引号代码块
 * 仅在 pending 或 interrupted 状态生效，避免多余 ``` 残留到完成后
 */
function fixUnclosedFences(text: string, status?: StreamStatus): string {
  if (!text) return text;
  if (status !== 'pending' && status !== 'interrupted') return text;

  // 统计三反引号（```）出现次数（忽略行内代码中的反引号）
  const fenceMatches = text.match(/^```/gm);
  if (!fenceMatches || fenceMatches.length % 2 === 0) return text;

  // 奇数个 → 末尾补一个 closing fence
  return text + '\n```';
}

/** 局部错误边界 — 捕获 react-markdown 子树中的渲染异常 */
class MarkdownErrorBoundary extends Component<{ children: ReactNode; content: string }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div>
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-1">
            Markdown 渲染异常，已切换为原文显示
          </p>
          <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words bg-gray-100 dark:bg-gray-800 rounded p-3 max-h-96 overflow-y-auto">
            {this.props.content}
          </pre>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function MarkdownRenderer({ content, status }: MarkdownRendererProps) {
  const displayContent = fixUnclosedFences(content, status);

  return (
    <MarkdownErrorBoundary content={content}>
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {displayContent || '...'}
        </ReactMarkdown>
      </div>
    </MarkdownErrorBoundary>
  );
}