/**
 * 阅读视图组件
 *
 * 展示知识库中单个章节的 Markdown 渲染内容。
 * 从侧边栏章节树点击 H3 知识点后进入此视图。
 *
 * 状态：
 * - 未选择章节：提示从左侧选择
 * - 加载中：显示加载动画
 * - 错误：显示错误信息
 * - 内容：Markdown 渲染（react-markdown + remark-gfm）
 */
import { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ReaderViewProps {
  chapterId?: string;
  heading?: string;
}

export default function ReaderView({ chapterId, heading }: ReaderViewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // chapterId 变化时加载对应章节内容
  useEffect(() => {
    if (!chapterId) {
      setContent(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    window.knowledgeAgent.kb
      .readChapter(chapterId)
      .then((data) => {
        setContent((data as string) || '');
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err?.message ?? err));
        setLoading(false);
      });
  }, [chapterId]);

  if (!chapterId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        从左侧知识库选择一个章节即可开始阅读
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        加载中...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-500">
        加载失败: {error}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-4">
        {heading && (
          <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-200 mb-4 pb-2 border-b border-gray-200 dark:border-gray-700">
            {heading.replace(/^#{2,3}\s*/, '')}
          </h1>
        )}
        <div className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed space-y-3 markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || ''}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
