/**
 * 知识库章节树组件
 *
 * 递归渲染知识库的树形结构（文件 → H2 章节 → H3 知识点）。
 * 通过 refreshKey 触发重新加载（父组件传入递增的 key 值）。
 *
 * 交互：
 * - 文件夹点击展开/折叠
 * - H2 章节点击展开/折叠
 * - H3 知识点点击切换到阅读视图（onSelectChapter）
 * - 选中的章节高亮蓝色
 */
import { useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, FileText } from 'lucide-react';
import type { FileNode, SectionNode } from '../../shared/types';

interface KnowledgeTreeProps {
  onSelectChapter: (id: string, heading: string) => void;
  selectedId?: string;
  refreshKey?: number;
}

export default function KnowledgeTree({ onSelectChapter, selectedId, refreshKey }: KnowledgeTreeProps) {
  const [files, setFiles] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // refreshKey 变化时重新加载知识库树
  useEffect(() => {
    setLoading(true);
    setError(null);
    window.knowledgeAgent.kb
      .getTree()
      .then((data) => {
        setFiles(data as FileNode[]);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err?.message ?? err));
        setLoading(false);
      });
  }, [refreshKey]);

  if (loading) {
    return (
      <div className="px-3 py-4 text-sm text-gray-400">加载中...</div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-4 text-sm text-red-500">
        加载失败: {error}
        <br />
        <span className="text-gray-400 text-xs">
          请确认知识库目录存在且包含 .md 文件
        </span>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="px-3 py-4 text-sm text-gray-400">
        知识库为空
        <br />
        <span className="text-xs">在知识库目录中创建 .md 文件即可开始</span>
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {files.map((file) => (
        <FileTreeNode
          key={file.path}
          file={file}
          selectedId={selectedId}
          onSelectChapter={onSelectChapter}
        />
      ))}
    </div>
  );
}

/** 文件节点：可展开/折叠，显示文件名和内部章节 */
function FileTreeNode({
  file,
  selectedId,
  onSelectChapter,
}: {
  file: FileNode;
  selectedId?: string;
  onSelectChapter: (id: string, heading: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 w-full px-2 py-1 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <FileText size={14} className="text-gray-400" />
        <span className="truncate">{file.title || file.name}</span>
      </button>
      {expanded && (
        <div className="ml-3">
          {file.sections.map((section) => (
            <SectionNodeRenderer
              key={section.id}
              section={section}
              selectedId={selectedId}
              onSelectChapter={onSelectChapter}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 章节节点：递归渲染 H2/H3，H3 可点击选中 */
function SectionNodeRenderer({
  section,
  selectedId,
  onSelectChapter,
}: {
  section: SectionNode;
  selectedId?: string;
  onSelectChapter: (id: string, heading: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = section.children.length > 0;
  const isSelected = selectedId === section.id;
  const isLeaf = section.level === 3;  // H3 为叶子节点（知识点层级）

  return (
    <div>
      <button
        onClick={() => {
          if (isLeaf) {
            // H3 知识点：点击切换到阅读视图
            onSelectChapter(section.id, section.heading);
          } else if (hasChildren) {
            // H2 章节：点击展开/折叠
            setExpanded(!expanded);
          }
        }}
        className={
          'flex items-center gap-1 w-full px-2 py-0.5 text-left text-xs rounded transition-colors ' +
          (isSelected
            ? 'bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-300'
            : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700')
        }
      >
        <span className="w-3 shrink-0">
          {hasChildren && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </span>
        <span className="truncate">
          {/* 去除 Markdown 标题前缀（## 或 ###） */}
          {section.heading.replace(/^#{2,3}\s*/, '')}
        </span>
      </button>
      {expanded && hasChildren && (
        <div className="ml-3">
          {section.children.map((child) => (
            <SectionNodeRenderer
              key={child.id}
              section={{ ...child, level: 3 }}
              selectedId={selectedId}
              onSelectChapter={onSelectChapter}
            />
          ))}
        </div>
      )}
    </div>
  );
}
