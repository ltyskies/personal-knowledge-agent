/**
 * 应用根组件
 *
 * 负责顶层状态管理和布局编排：
 * - 视图模式切换（chat / read）
 * - 首次启动引导（SetupWizard）
 * - 配置加载状态（加载中 / 成功 / 失败）
 * - 对话管理（列表、切换、新建、删除、自动保存）
 * - 知识库树刷新协调
 *
 * 状态数据流：
 * App（顶层）
 * ├── Sidebar（知识库树 + 对话历史 + 模式切换）
 * ├── ChatView（对话界面 + 知识提取合并进度）
 * │   └── useChat hook（消息状态、流式处理、提取合并逻辑）
 * ├── ReaderView（章节阅读）
 * ├── ConfigModal（API 设置弹窗）
 * └── SetupWizard（首次引导）
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import ReaderView from './components/ReaderView';
import ConfigModal from './components/ConfigModal';
import SetupWizard from './components/SetupWizard';
import { useChat } from './hooks/useChat';
import { useTheme } from './hooks/useTheme';
import type { ViewMode } from './types';
import type { AppConfig, ConversationMeta, Conversation, Message } from '../shared/types';

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('chat');
  const [selectedChapterId, setSelectedChapterId] = useState<string | undefined>(undefined);
  const [selectedChapterHeading, setSelectedChapterHeading] = useState<string | undefined>(undefined);
  const [configOpen, setConfigOpen] = useState(false);

  // 首次启动引导状态
  const [showSetup, setShowSetup] = useState(false);
  const [configReady, setConfigReady] = useState(false);
  const [checkingConfig, setCheckingConfig] = useState(true);

  // 知识库树刷新触发器 — 递增 key 值强制 KnowledgeTree 重新加载
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);

  const { theme, resolvedTheme, toggle: toggleTheme } = useTheme();

  // 对话状态
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [conversationsOpen, setConversationsOpen] = useState(true);
  // 通过 ref 暂存待保存的消息，由 useEffect 去抖后异步保存
  const pendingSaveRef = useRef<Message[] | null>(null);

  const handleMessagesChange = useCallback((msgs: Message[]) => {
    pendingSaveRef.current = msgs;
  }, []);

  // 知识点合并完成后刷新知识库树
  const handleMergeComplete = useCallback(() => {
    setTreeRefreshKey((k) => k + 1);
  }, []);

  const { messages, isStreaming, error, send, retry, stop, clearError, isExtracting, extractError, extractedItems, chapterMatches, extract, clearExtraction, isAutoMerging, autoMergeProgress } = useChat({
    conversationId: currentConversationId,
    onMessagesChange: handleMessagesChange,
    onAutoMergeComplete: handleMergeComplete,
  });

  // 对话自动保存 — 消息变化时通过 pendingSaveRef 触发
  useEffect(() => {
    if (!pendingSaveRef.current || !currentConversationId) return;
    const msgs = pendingSaveRef.current;
    pendingSaveRef.current = null;

    // 取第一条用户消息的前 40 字符作为对话标题
    const title = msgs.find((m) => m.role === 'user')?.content.slice(0, 40) || '新对话';
    window.knowledgeAgent.conversation.save({
      id: currentConversationId,
      title,
      messages: msgs,
      createdAt: '',  // 已有对话的 createdAt 由 main 端保留
      updatedAt: '',
    }).then(() => {
      // 保存后刷新对话列表
      window.knowledgeAgent.conversation.list().then((data) => {
        setConversations(data as ConversationMeta[]);
      }).catch(() => {});
    }).catch(() => {});
  }, [messages, currentConversationId]);

  // 初始化：加载配置
  useEffect(() => {
    window.knowledgeAgent.config.get().then((data) => {
      const c = data as AppConfig;
      if (!c.api.key) {
        setShowSetup(true);  // 未配置 API Key，显示引导向导
      }
      setConfigReady(true);
      setCheckingConfig(false);
    }).catch(() => {
      setConfigReady(false);
      setCheckingConfig(false);
    });
  }, []);

  // 初始化：加载对话列表，若无对话则创建首个对话
  useEffect(() => {
    window.knowledgeAgent.conversation.list().then((data) => {
      const list = data as ConversationMeta[];
      setConversations(list);
      if (list.length > 0) {
        setCurrentConversationId(list[0].id);
      } else {
        window.knowledgeAgent.conversation.create().then((conv) => {
          const c = conv as Conversation;
          setCurrentConversationId(c.id);
          setConversations([{ id: c.id, title: c.title, messageCount: 0, createdAt: c.createdAt, updatedAt: c.updatedAt }]);
        }).catch(() => {});
      }
    }).catch(() => {});
  }, []);

  const handleSetupComplete = useCallback((_config: AppConfig) => {
    setShowSetup(false);
    setConfigReady(true);
  }, []);

  const handleSelectChapter = useCallback((id: string, heading: string) => {
    setViewMode('read');
    setSelectedChapterId(id);
    setSelectedChapterHeading(heading);
  }, []);

  const handleRefreshIndex = useCallback(async () => {
    try {
      await window.knowledgeAgent.kb.refreshIndex();
      setTreeRefreshKey((k) => k + 1);
    } catch {
      // 静默处理刷新失败
    }
  }, []);

  // 对话操作：新建
  const handleNewConversation = useCallback(async () => {
    clearExtraction();
    const conv = await window.knowledgeAgent.conversation.create() as Conversation;
    setCurrentConversationId(conv.id);
    setConversations((prev) => [{ id: conv.id, title: conv.title, messageCount: 0, createdAt: conv.createdAt, updatedAt: conv.updatedAt }, ...prev]);
    setViewMode('chat');
  }, [clearExtraction]);

  // 对话操作：切换
  const handleSwitchConversation = useCallback(async (id: string) => {
    if (id === currentConversationId) return;
    pendingSaveRef.current = null;  // 丢弃上一对话的待保存数据，防止写入错误文件
    clearExtraction();  // 清空上一对话的提取结果
    setCurrentConversationId(id);
    setViewMode('chat');
  }, [currentConversationId, clearExtraction]);

  // 对话操作：删除
  const handleDeleteConversation = useCallback(async (id: string) => {
    await window.knowledgeAgent.conversation.delete(id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (id === currentConversationId) {
      clearExtraction();
      // 切换到剩余最新对话，或创建新对话
      const remaining = conversations.filter((c) => c.id !== id);
      if (remaining.length > 0) {
        setCurrentConversationId(remaining[0].id);
      } else {
        const conv = await window.knowledgeAgent.conversation.create() as Conversation;
        setCurrentConversationId(conv.id);
        setConversations([{ id: conv.id, title: conv.title, messageCount: 0, createdAt: conv.createdAt, updatedAt: conv.updatedAt }]);
      }
    }
  }, [currentConversationId, conversations, clearExtraction]);

  // 配置检查中 — 显示加载状态
  if (checkingConfig) {
    return (
      <div className="h-screen flex items-center justify-center bg-white dark:bg-gray-950">
        <div className="text-sm text-gray-400">启动中...</div>
      </div>
    );
  }

  // 首次运行，未配置 API Key — 显示引导向导
  if (showSetup) {
    return <SetupWizard onComplete={handleSetupComplete} />;
  }

  // 配置加载失败 — 提示重启
  if (!configReady) {
    return (
      <div className="h-screen flex items-center justify-center bg-white dark:bg-gray-950">
        <div className="text-sm text-red-500">配置加载失败，请重启应用</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-white dark:bg-gray-900">
      <Sidebar
        viewMode={viewMode}
        onViewChange={setViewMode}
        onSelectChapter={handleSelectChapter}
        selectedChapterId={selectedChapterId}
        onOpenSettings={() => setConfigOpen(true)}
        onRefreshIndex={handleRefreshIndex}
        refreshKey={treeRefreshKey}
        theme={theme}
        resolvedTheme={resolvedTheme}
        onToggleTheme={toggleTheme}
        conversations={conversations}
        currentConversationId={currentConversationId}
        conversationsOpen={conversationsOpen}
        onToggleConversations={() => setConversationsOpen((v) => !v)}
        onNewConversation={handleNewConversation}
        onSwitchConversation={handleSwitchConversation}
        onDeleteConversation={handleDeleteConversation}
      />
      <main className="flex-1 flex flex-col min-w-0">
        {viewMode === 'chat' && (
          <ChatView
            messages={messages}
            isStreaming={isStreaming}
            error={error}
            onSend={send}
            onRetry={retry}
            onStop={stop}
            onClearError={clearError}
            isExtracting={isExtracting}
            extractError={extractError}
            extractedItems={extractedItems}
            onExtract={extract}
            onClearExtraction={clearExtraction}
            isAutoMerging={isAutoMerging}
            autoMergeProgress={autoMergeProgress}
          />
        )}
        {viewMode === 'read' && (
          <ReaderView chapterId={selectedChapterId} heading={selectedChapterHeading} />
        )}
      </main>

      <ConfigModal open={configOpen} onClose={() => setConfigOpen(false)} />
    </div>
  );
}
