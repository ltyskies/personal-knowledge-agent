/**
 * Diff 对比视图组件
 *
 * 知识合并确认界面，左右分栏展示：
 * - 左侧：当前内容（只读 Markdown 渲染）
 * - 右侧：合并后内容（可编辑 textarea）
 *
 * 操作流程：
 * 1. 用户审查 AI 合并结果
 * 2. 可手动编辑右侧内容
 * 3. 点击"确认并写入" → 调用 onConfirm(editedContent)
 * 4. 写入成功后显示"知识已写入并提交"，可返回对话
 *
 * 元数据显示：领域、子领域路径、新章节/新文件标签。
 */
import { useState } from 'react';
import { Check, X, Loader2, AlertTriangle, GitCommit } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MergeResult } from '../../shared/types';

interface DiffViewProps {
  mergeResult: MergeResult;
  onConfirm: (editedContent: string) => Promise<void>;
  onReject: () => void;
  onBack: () => void;
}

export default function DiffView({ mergeResult, onConfirm, onReject, onBack }: DiffViewProps) {
  const [editedContent, setEditedContent] = useState(mergeResult.newContent);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleConfirm = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onConfirm(editedContent);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // 写入成功后显示完成状态
  if (saved) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-500 text-sm gap-2">
        <Check size={32} className="text-green-500" />
        <span>知识已写入并提交</span>
        <button
          onClick={onReject}
          className="mt-2 px-4 py-1.5 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600"
        >
          返回对话
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 顶部操作栏：标题、路径信息、拒绝/确认按钮 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shrink-0">
        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={onBack}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            ← 返回
          </button>
          <span className="text-gray-400">|</span>
          <span className="font-medium text-gray-700 dark:text-gray-300">
            {mergeResult.title}
          </span>
          <span className="text-xs text-gray-400">
            {mergeResult.domain} {mergeResult.subdomain ? `/ ${mergeResult.subdomain}` : ''}
          </span>
          {mergeResult.isNewChapter && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400">
              {mergeResult.isNewFile ? '新文件' : '新章节'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            disabled={saving}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs border border-gray-300 dark:border-gray-600 rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            <X size={14} />
            拒绝
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Check size={14} />
            )}
            确认并写入
          </button>
        </div>
      </div>

      {/* 写入错误提示 */}
      {saveError && (
        <div className="mx-4 mt-3 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-600 dark:text-red-400 flex items-center gap-2 shrink-0">
          <AlertTriangle size={14} />
          {saveError}
        </div>
      )}

      {/* 左右分栏：左侧当前内容（只读）| 右侧合并后内容（可编辑） */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* 当前内容（只读 Markdown 渲染） */}
        <div className="flex-1 flex flex-col min-w-0 border-r border-gray-200 dark:border-gray-700">
          <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-800 text-xs font-medium text-gray-500 shrink-0">
            当前内容
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {mergeResult.oldContent ? (
              <div className="markdown-body text-sm text-gray-600 dark:text-gray-400">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {mergeResult.oldContent}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="text-sm text-gray-400 italic">（新章节，无现有内容）</div>
            )}
          </div>
        </div>

        {/* 合并后内容（可编辑 textarea） */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-800 text-xs font-medium text-blue-600 dark:text-blue-400 shrink-0">
            合并后内容（可编辑）
          </div>
          <textarea
            value={editedContent}
            onChange={(e) => setEditedContent(e.target.value)}
            className="flex-1 resize-none px-4 py-3 text-sm text-gray-800 dark:text-gray-200 bg-white dark:bg-gray-900 border-0 focus:outline-none focus:ring-0 font-mono"
          />
        </div>
      </div>
    </div>
  );
}
