/**
 * Electron Preload 脚本
 *
 * 使用 contextBridge 在渲染进程和主进程之间建立安全的通信桥梁。
 *
 * 架构原理：
 * - 渲染进程运行在沙箱环境中（nodeIntegration: false, contextIsolation: true）
 * - preload 脚本运行在有部分 Node.js 权限的上下文中
 * - 通过 contextBridge.exposeInMainWorld 将有限的 API 暴露到 window.knowledgeAgent
 * - 渲染进程只能通过这个 API 与主进程通信，无法直接访问 Node.js 或 Electron 内部
 *
 * 暴露的 API 按功能分组：
 * - config:        应用配置读写
 * - kb:            知识库文件操作（读取、写入、索引、合并）
 * - chat:          AI 对话（流式响应、知识点提取）
 * - dialog:        系统原生对话框（目录选择）
 * - git:           Git 状态查询和提交
 * - conversation:  对话历史的 CRUD
 */
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  config: {
    get: (): Promise<unknown> => ipcRenderer.invoke('config:get'),
    set: (config: unknown): Promise<void> => ipcRenderer.invoke('config:set', config),
  },
  kb: {
    getTree: (): Promise<unknown> => ipcRenderer.invoke('kb:getTree'),
    readFile: (path: string): Promise<unknown> => ipcRenderer.invoke('kb:readFile', path),
    readChapter: (id: string): Promise<unknown> => ipcRenderer.invoke('kb:readChapter', id),
    getIndex: (): Promise<unknown> => ipcRenderer.invoke('kb:getIndex'),
    matchChapters: (items: unknown[]): Promise<unknown> => ipcRenderer.invoke('kb:matchChapters', items),
    mergeChapter: (input: unknown): Promise<unknown> => ipcRenderer.invoke('kb:mergeChapter', input),
    writeChapter: (input: unknown): Promise<unknown> => ipcRenderer.invoke('kb:writeChapter', input),
    autoMerge: (input: unknown): Promise<unknown> => ipcRenderer.invoke('kb:autoMerge', input),
    refreshIndex: (): Promise<void> => ipcRenderer.invoke('kb:refreshIndex'),
    initKnowledgeBase: (kbPath: string): Promise<unknown> => ipcRenderer.invoke('kb:initKnowledgeBase', kbPath),
  },
  chat: {
    stream: (messages: unknown[]): Promise<void> => ipcRenderer.invoke('chat:stream', messages),
    onChunk: (callback: (chunk: unknown) => void) => {
      // 监听主进程推送的流式数据块（chat:stream-chunk 通道）
      ipcRenderer.on('chat:stream-chunk', (_event, chunk) => callback(chunk));
    },
    offChunk: () => {
      ipcRenderer.removeAllListeners('chat:stream-chunk');
    },
    onError: (callback: (error: string) => void) => {
      ipcRenderer.on('chat:stream-error', (_event, error) => callback(error));
    },
    offError: () => {
      ipcRenderer.removeAllListeners('chat:stream-error');
    },
    extract: (messages: unknown[]): Promise<unknown> => ipcRenderer.invoke('chat:extract', messages),
  },
  dialog: {
    selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectDirectory'),
  },
  git: {
    status: (): Promise<unknown> => ipcRenderer.invoke('git:status'),
    commit: (files: string[], domain: string, title: string, isNew: boolean): Promise<string> =>
      ipcRenderer.invoke('git:commit', files, domain, title, isNew),
  },
  conversation: {
    list: (): Promise<unknown> => ipcRenderer.invoke('conversation:list'),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('conversation:get', id),
    save: (conv: unknown): Promise<void> => ipcRenderer.invoke('conversation:save', conv),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('conversation:delete', id),
    create: (): Promise<unknown> => ipcRenderer.invoke('conversation:create'),
  },
};

// 将 API 挂载到 window.knowledgeAgent — 渲染进程的唯一外部通信入口
contextBridge.exposeInMainWorld('knowledgeAgent', api);
