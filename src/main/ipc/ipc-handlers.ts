/**
 * IPC 通信处理器
 *
 * 这是 Main↔Renderer 通信的总枢纽。所有 IPC 通道在此统一注册。
 *
 * 通道命名规范：namespace:action（如 `kb:getTree`、`chat:stream`）
 * - 请求-响应通道：使用 `ipcMain.handle` 注册，Renderer 用 `ipcRenderer.invoke` 调用
 * - 流式推送通道：Main 通过 `event.sender.send` 主动推送到 Renderer，通道名加 `-stream` 后缀
 *
 * 数据安全设计：
 * - API Key 仅在此模块（Main 进程）中使用，通过 loadConfig 读取
 * - 流式数据由 Main 主动推送到 Renderer，Renderer 不发起流式 HTTP 请求
 * - 文件写入前进行 mtime 冲突检测，防止覆盖他人在用户确认期间的外部修改
 *
 * Phase 阶段：
 *  Phase 2: 知识库树和文件读取
 *  Phase 3: AI 流式对话
 *  Phase 4: 知识点提取与章节匹配
 *  Phase 5: 知识合并 + 写入 + Git commit
 *  Phase 6: 工具类功能（刷新索引、目录选择、仓库初始化）
 */
import { ipcMain, dialog } from 'electron';
import { basename } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { loadConfig, saveConfig } from '../storage/config';
import { readMarkdownFile, resolveChapter, writeChapterContent } from '../knowledge/file-system';
import { getOrBuildIndex, buildIndex, saveIndex } from '../knowledge/index-builder';
import { streamChat, chatSync, StreamError } from '../ai/ai-client';
import { matchChapters } from '../knowledge/chapter-matcher';
import { mergeChapter } from '../knowledge/knowledge-merger';
import { getStatus, commit, initRepo } from '../git/git-ops';
import { listConversations, getConversation, saveConversation, deleteConversation, createConversation } from '../storage/conversation-store';
import type { AppConfig, FileNode, SectionNode, FileEntry, IndexData, Message, KnowledgeItem, ChapterMatch, MergeInput, MergeResult, WriteInput, GitStatus, Conversation, ConversationMeta, StreamErrorInfo } from '../../shared/types';

/** 将内部 FileEntry 转换为仅含 UI 需要字段的 FileNode 树形结构 */
function fileEntryToNode(entry: FileEntry): FileNode {
  function toSectionNode(section: SectionNode): SectionNode {
    return {
      ...section,
      children: section.children.map(toSectionNode),
    };
  }

  return {
    name: basename(entry.path, '.md'),
    path: entry.path,
    title: entry.title,
    sections: entry.sections.map(toSectionNode),
  };
}

export function registerHandlers(): void {
  // ==================== 配置管理 ====================

  ipcMain.handle('config:get', async (): Promise<AppConfig> => {
    return loadConfig();
  });

  ipcMain.handle('config:set', async (_event, config: AppConfig): Promise<void> => {
    saveConfig(config);
  });

  // ==================== 知识库读写 ====================

  ipcMain.handle('kb:getTree', async (): Promise<FileNode[]> => {
    const config = loadConfig();
    const index = getOrBuildIndex(config.kbPath);
    return Object.values(index.files).map(fileEntryToNode);
  });

  ipcMain.handle('kb:readFile', async (_event, relativePath: string): Promise<string> => {
    const config = loadConfig();
    return readMarkdownFile(config.kbPath, relativePath);
  });

  ipcMain.handle('kb:readChapter', async (_event, chapterId: string): Promise<string | null> => {
    const config = loadConfig();
    const result = resolveChapter(config.kbPath, chapterId);
    return result?.content ?? null;
  });

  ipcMain.handle('kb:getIndex', async (): Promise<IndexData> => {
    const config = loadConfig();
    return getOrBuildIndex(config.kbPath);
  });

  // ==================== AI 流式对话 ====================

  // 当前活跃的流控制器 — 用于实现用户主动停止
  let activeStreamController: AbortController | null = null;

  ipcMain.handle('chat:stream', async (event, messages: Message[]): Promise<void> => {
    const config = loadConfig();
    const sender = event.sender;

    // 每次新请求前确保上一轮流已终止
    if (activeStreamController) {
      activeStreamController.abort();
      activeStreamController = null;
    }

    const abortController = new AbortController();
    activeStreamController = abortController;

    try {
      const stream = streamChat(
        config.api.baseURL,
        config.api.key,
        config.api.model,
        messages,
        undefined,
        abortController.signal,
      );
      for await (const chunk of stream) {
        sender.send('chat:stream-chunk', chunk);
      }
    } catch (err) {
      if (err instanceof StreamError) {
        // 用户主动停止 — 不推送错误，前端已在 UI 侧自己处理状态
        if (err.type === 'user_aborted') return;

        const errorInfo: StreamErrorInfo = {
          type: err.type,
          message: err.message,
          retryable: err.retryable,
        };
        sender.send('chat:stream-error', errorInfo);
      } else {
        const errorInfo: StreamErrorInfo = {
          type: 'api_error',
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        };
        sender.send('chat:stream-error', errorInfo);
      }
    } finally {
      if (activeStreamController === abortController) {
        activeStreamController = null;
      }
    }
  });

  ipcMain.handle('chat:stop', async (): Promise<void> => {
    if (activeStreamController) {
      activeStreamController.abort();
      activeStreamController = null;
    }
  });

  // ==================== 知识提取与章节匹配 ====================

  ipcMain.handle('chat:extract', async (_event, messages: Message[]): Promise<KnowledgeItem[]> => {
    const config = loadConfig();

    const conversation = messages
      .map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
      .join('\n\n');

    const systemPrompt = `你是一个知识提取助手。基于用户与AI的对话，提取值得记录的知识点（最多3条）。

每条知识点格式：
{
  "domain": "所属领域（如 Rust、计算机网络）",
  "subdomain": "子领域（如 所有权系统、TCP协议）",
  "title": "知识点标题（如 移动语义、TIME_WAIT状态）",
  "content": "知识内容（Markdown 格式，200-500字，完整准确）",
  "relatedQuestions": ["相关问题1", "相关问题2"]
}

规则：
- 只提取有长期记录价值的知识点，忽略闲聊和个人信息
- domain/subdomain/title 使用中文
- content 使用 Markdown 格式，可包含代码块
- 如果对话没有值得记录的知识，返回空数组 []
- 只返回 JSON 数组，不要其他内容`;

    const response = await chatSync(config.api.baseURL, config.api.key, config.api.model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `从以下对话中提取知识点：\n\n${conversation}` },
    ]);

    try {
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      return JSON.parse(jsonMatch[0]) as KnowledgeItem[];
    } catch {
      return [];
    }
  });

  ipcMain.handle('kb:matchChapters', async (_event, items: KnowledgeItem[]): Promise<ChapterMatch[]> => {
    const config = loadConfig();
    const index = getOrBuildIndex(config.kbPath);
    return matchChapters(items, index);
  });

  // ==================== 知识合并（Phase 5：预览模式） ====================

  ipcMain.handle('kb:mergeChapter', async (_event, input: MergeInput): Promise<MergeResult> => {
    const config = loadConfig();
    const result = await mergeChapter(input.knowledgeItem, input.chapterMatch);

    // 合并完成后记录文件 mtime，用于后续写入时的冲突检测
    let recordedMtime = '';
    if (result.filePath && !result.isNewFile) {
      const { statSync } = await import('fs');
      const { join } = await import('path');
      const fullPath = join(config.kbPath, result.filePath);
      try {
        recordedMtime = statSync(fullPath).mtime.toISOString();
      } catch {
        // 文件尚未创建（新文件场景）
      }
    }

    return { ...result, recordedMtime };
  });

  ipcMain.handle('kb:writeChapter', async (_event, input: WriteInput): Promise<{ success: boolean; error?: string }> => {
    const config = loadConfig();
    const { join } = await import('path');
    const { statSync } = await import('fs');

    // mtime 冲突检测：若文件在读取后被外部修改，拒绝写入
    if (!input.isNewFile) {
      const fullPath = join(config.kbPath, input.filePath);
      try {
        const currentMtime = statSync(fullPath).mtime.toISOString();
        if (input.recordedMtime && currentMtime !== input.recordedMtime) {
          return {
            success: false,
            error: `文件 ${input.filePath} 在读取后被外部修改，请刷新后重试`,
          };
        }
      } catch {
        // 文件消失 — 按新文件处理
      }
    }

    try {
      writeChapterContent(
        config.kbPath,
        input.filePath,
        input.chapterId,
        input.newContent,
        input.heading,
        input.domain,
        input.subdomain,
        input.isNewFile,
        input.isNewChapter,
      );

      // 写入后重建索引，保证 index.json 与实际文件内容同步
      const index = buildIndex(config.kbPath);
      saveIndex(config.kbPath, index);

      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ==================== 一键自动合并（Phase 5 简化版） ====================

  ipcMain.handle('kb:autoMerge', async (_event, input: MergeInput): Promise<{ success: boolean; filePath?: string; domain?: string; title?: string; error?: string }> => {
    const config = loadConfig();

    const mergeResult = await mergeChapter(input.knowledgeItem, input.chapterMatch);

    try {
      writeChapterContent(
        config.kbPath,
        mergeResult.filePath,
        mergeResult.chapterId,
        mergeResult.newContent,
        mergeResult.heading,
        mergeResult.domain,
        mergeResult.subdomain,
        mergeResult.isNewFile,
        mergeResult.isNewChapter,
      );

      const index = buildIndex(config.kbPath);
      saveIndex(config.kbPath, index);

      // 写入成功后自动 commit（commit 失败不阻止写入流程）
      try {
        await commit(config.kbPath, [mergeResult.filePath, 'index.json'], mergeResult.domain, mergeResult.title, mergeResult.isNewChapter);
      } catch {
        // commit 失败但写入成功 — 非致命错误，知识已保存
      }

      return { success: true, filePath: mergeResult.filePath, domain: mergeResult.domain, title: mergeResult.title };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ==================== 工具类功能 ====================

  ipcMain.handle('kb:refreshIndex', async (): Promise<void> => {
    const config = loadConfig();
    const index = buildIndex(config.kbPath);
    saveIndex(config.kbPath, index);
  });

  ipcMain.handle('dialog:selectDirectory', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('kb:initKnowledgeBase', async (_event, kbPath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!existsSync(kbPath)) {
        mkdirSync(kbPath, { recursive: true });
      }
      await initRepo(kbPath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ==================== 对话管理 ====================

  ipcMain.handle('conversation:list', async (): Promise<ConversationMeta[]> => {
    return listConversations();
  });

  ipcMain.handle('conversation:get', async (_event, id: string): Promise<Conversation | null> => {
    return getConversation(id);
  });

  ipcMain.handle('conversation:save', async (_event, conv: Conversation): Promise<void> => {
    saveConversation(conv);
  });

  ipcMain.handle('conversation:delete', async (_event, id: string): Promise<void> => {
    deleteConversation(id);
  });

  ipcMain.handle('conversation:create', async (): Promise<Conversation> => {
    return createConversation();
  });

  // ==================== Git 状态查询 ====================

  ipcMain.handle('git:status', async (): Promise<GitStatus> => {
    const config = loadConfig();
    return getStatus(config.kbPath);
  });

  ipcMain.handle('git:commit', async (_event, files: string[], domain: string, title: string, isNew: boolean): Promise<string> => {
    const config = loadConfig();
    return commit(config.kbPath, files, domain, title, isNew);
  });
}
