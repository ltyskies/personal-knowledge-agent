/**
 * 侧边栏组件
 *
 * 左侧 280px 宽的导航面板，包含三个区域（从上到下）：
 * 1. 标题栏：应用名称 + 主题切换按钮
 * 2. 对话历史：对话列表（可新建/切换/删除）+ 知识库章节树
 * 3. 底部栏：对话/阅读模式切换标签 + 设置按钮
 *
 * 删除对话使用二次确认机制（hover 后点击垃圾桶 → 确认点击 → 执行删除），防止误删。
 */
import { useState } from 'react';
import { MessageSquare, BookOpen, Settings, RefreshCw, Sun, Moon, Monitor, Plus, Trash2, ChevronDown, ChevronRight, MessageCircle } from 'lucide-react';
import type { ViewMode } from '../../types';
import type { ConversationMeta } from '../../../shared/types';
import KnowledgeTree from './KnowledgeTree';

interface SidebarProps {
  viewMode: ViewMode;
  onViewChange: (mode: ViewMode) => void;
  onSelectChapter: (id: string, heading: string) => void;
  selectedChapterId?: string;
  onOpenSettings: () => void;
  onRefreshIndex: () => void;
  refreshKey: number;
  theme: 'light' | 'dark' | 'system';
  resolvedTheme: 'light' | 'dark';
  onToggleTheme: () => void;
  conversations: ConversationMeta[];
  currentConversationId: string | null;
  conversationsOpen: boolean;
  onToggleConversations: () => void;
  onNewConversation: () => void;
  onSwitchConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
}

export default function Sidebar({
  viewMode,
  onViewChange,
  onSelectChapter,
  selectedChapterId,
  onOpenSettings,
  onRefreshIndex,
  refreshKey,
  theme,
  resolvedTheme,
  onToggleTheme,
  conversations,
  currentConversationId,
  conversationsOpen,
  onToggleConversations,
  onNewConversation,
  onSwitchConversation,
  onDeleteConversation,
}: SidebarProps) {
  return (
    <aside className="w-[280px] flex flex-col border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shrink-0">
      {/* 标题栏 + 主题切换 */}
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-200">
          知识库 Agent
        </h1>
        <button
          onClick={onToggleTheme}
          className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          title={`当前: ${theme === 'system' ? '跟随系统' : theme === 'dark' ? '暗色' : '亮色'}`}
        >
          {/* 主题图标：跟随系统 → Monitor, 暗色 → Moon, 亮色 → Sun */}
          {theme === 'system' ? <Monitor size={15} /> : resolvedTheme === 'dark' ? <Moon size={15} /> : <Sun size={15} />}
        </button>
      </div>

      {/* 对话历史 */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between px-3 py-1.5">
          <button
            onClick={onToggleConversations}
            className="flex items-center gap-1 text-[10px] text-gray-400 uppercase tracking-wide hover:text-gray-600 dark:hover:text-gray-300"
          >
            {conversationsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            对话历史
          </button>
          <button
            onClick={onNewConversation}
            className="p-0.5 text-gray-400 hover:text-blue-500 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            title="新建对话"
          >
            <Plus size={14} />
          </button>
        </div>
        {conversationsOpen && (
          <div className="max-h-[200px] overflow-y-auto px-1 pb-1">
            {conversations.length === 0 && (
              <div className="px-3 py-2 text-xs text-gray-400">暂无对话</div>
            )}
            {conversations.map((conv) => (
              <ConversationItem
                key={conv.id}
                conv={conv}
                isActive={conv.id === currentConversationId}
                onSwitch={() => onSwitchConversation(conv.id)}
                onDelete={() => onDeleteConversation(conv.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 知识库树标题 + 刷新按钮 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 dark:border-gray-800">
        <span className="text-[10px] text-gray-400 uppercase tracking-wide">知识库</span>
        <button
          onClick={onRefreshIndex}
          className="p-0.5 text-gray-400 hover:text-blue-500 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          title="刷新索引"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* 知识库章节树 */}
      <div className="flex-1 overflow-y-auto px-1 py-2">
        <KnowledgeTree
          onSelectChapter={onSelectChapter}
          selectedId={selectedChapterId}
          refreshKey={refreshKey}
        />
      </div>

      {/* 模式切换标签：对话 / 阅读 */}
      <div className="border-t border-gray-200 dark:border-gray-700 p-2 flex gap-1">
        <TabButton
          active={viewMode === 'chat'}
          onClick={() => onViewChange('chat')}
          icon={MessageSquare}
          label="对话"
        />
        <TabButton
          active={viewMode === 'read'}
          onClick={() => onViewChange('read')}
          icon={BookOpen}
          label="阅读"
        />
      </div>

      {/* 设置按钮 */}
      <div className="border-t border-gray-200 dark:border-gray-700 p-2">
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        >
          <Settings size={16} />
          设置
        </button>
      </div>
    </aside>
  );
}

/**
 * 对话历史项
 *
 * 显示对话标题、最后更新时间。hover 时显示删除按钮，
 * 删除需要二次确认（点击删除 → 再次确认 → 执行删除）。
 * 今天的对话显示时间（如 "14:30"），更早的显示日期（如 "4月15日"）。
 */
function ConversationItem({
  conv,
  isActive,
  onSwitch,
  onDelete,
}: {
  conv: ConversationMeta;
  isActive: boolean;
  onSwitch: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const date = new Date(conv.updatedAt);
  const dateStr = isToday(date)
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });

  return (
    <div
      className={
        'group flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer text-xs transition-colors ' +
        (isActive
          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700')
      }
      onClick={onSwitch}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setConfirmDelete(false); }}
    >
      <MessageCircle size={12} className="shrink-0 opacity-60" />
      <span className="flex-1 truncate">{conv.title}</span>
      <span className="text-[10px] opacity-50 shrink-0">{dateStr}</span>
      {hover && (
        confirmDelete ? (
          <>
            {/* 二次确认：确认删除 */}
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="text-red-500 hover:text-red-600 shrink-0"
              title="确认删除"
            >
              <Trash2 size={11} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
              className="text-gray-400 hover:text-gray-500 shrink-0"
              title="取消"
            >
              <ChevronRight size={11} />
            </button>
          </>
        ) : (
          /* 第一步：显示删除按钮 */
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
            className="text-gray-400 hover:text-red-500 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
            title="删除对话"
          >
            <Trash2 size={11} />
          </button>
        )
      )}
    </div>
  );
}

/** 判断日期是否为今天（用于决定显示时间还是日期） */
function isToday(date: Date): boolean {
  const now = new Date();
  return date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
}

/** 底部模式切换标签按钮 */
function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ size?: number }>;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded transition-colors ' +
        (active
          ? 'bg-blue-500 text-white'
          : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700')
      }
    >
      <Icon size={14} />
      {label}
    </button>
  );
}
