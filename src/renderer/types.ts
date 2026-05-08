/**
 * 渲染进程全局类型声明
 *
 * 扩展 Window 接口，声明 window.knowledgeAgent 的完整类型。
 * 该对象由 preload 脚本通过 contextBridge 注入，是渲染进程与主进程通信的唯一入口。
 *
 * 所有 IPC 调用的返回值类型在此声明，保证渲染进程的 TypeScript 类型安全。
 * 注意：preload 脚本使用 `unknown` 类型传递，实际类型由这些声明确定。
 *
 * ViewMode 定义应用的两种视图模式：
 * - 'chat': 对话模式（与 AI 聊天 + 知识提取和合并）
 * - 'read': 阅读模式（浏览知识库中已存储的章节内容）
 */
import type { Chunk, KnowledgeItem, ChapterMatch, ConversationMeta, Conversation, StreamErrorInfo, ToolStreamEvent } from '../shared/types';

export type ViewMode = 'chat' | 'read';

declare global {
  interface Window {
    knowledgeAgent: {
      config: {
        get: () => Promise<unknown>;
        set: (config: unknown) => Promise<void>;
      };
      kb: {
        getTree: () => Promise<unknown>;
        readFile: (path: string) => Promise<unknown>;
        readChapter: (id: string) => Promise<unknown>;
        getIndex: () => Promise<unknown>;
        matchChapters: (items: KnowledgeItem[]) => Promise<ChapterMatch[]>;
        mergeChapter: (input: { knowledgeItem: KnowledgeItem; chapterMatch: ChapterMatch }) => Promise<import('../shared/types').MergeResult>;
        writeChapter: (input: import('../shared/types').WriteInput) => Promise<{ success: boolean; error?: string }>;
        autoMerge: (input: { knowledgeItem: KnowledgeItem; chapterMatch: ChapterMatch }) => Promise<{ success: boolean; filePath?: string; domain?: string; title?: string; error?: string }>;
        refreshIndex: () => Promise<void>;
        initKnowledgeBase: (kbPath: string) => Promise<{ success: boolean; error?: string }>;
      };
      chat: {
        stream: (messages: unknown[]) => Promise<void>;
        onChunk: (callback: (chunk: Chunk) => void) => void;
        offChunk: () => void;
        onError: (callback: (error: StreamErrorInfo) => void) => void;
        offError: () => void;
        stop: () => Promise<void>;
        extract: (messages: unknown[]) => Promise<KnowledgeItem[]>;
        onToolEvent: (callback: (event: ToolStreamEvent) => void) => void;
        offToolEvent: () => void;
      };
      dialog: {
        selectDirectory: () => Promise<string | null>;
      };
      git: {
        status: () => Promise<import('../shared/types').GitStatus>;
        commit: (files: string[], domain: string, title: string, isNew: boolean) => Promise<string>;
      };
      conversation: {
        list: () => Promise<ConversationMeta[]>;
        get: (id: string) => Promise<Conversation | null>;
        save: (conv: Conversation) => Promise<void>;
        delete: (id: string) => Promise<void>;
        create: () => Promise<Conversation>;
      };
    };
  }
}

// 确保此文件被视为模块（使 declare global 生效）
export {};
