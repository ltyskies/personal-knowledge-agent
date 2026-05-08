/**
 * 知识库工具 — LangChain StructuredTool 定义
 *
 * 将 file-system.ts 和 index-builder.ts 的核心功能封装为 AI 可调用的工具。
 * 工具在 Main 进程中执行，拥有完整的文件系统访问权限。
 */
import { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { loadConfig } from '../storage/config';
import {
  resolveChapter,
  writeChapterContent,
  listMarkdownFiles,
  readChapterContent,
  buildFileEntry,
  parseMarkdownFile,
  buildSectionId,
} from '../knowledge/file-system';
import { buildIndex, saveIndex, getOrBuildIndex } from '../knowledge/index-builder';
import { truncateSearchResults, truncateToolResult } from '../ai/context-compressor';
import { basename } from 'path';

function getKbPath(): string {
  return loadConfig().kbPath;
}

// ===== read_chapter =====

class ReadChapterTool extends StructuredTool {
  name = 'read_chapter';
  description = '通过章节唯一 ID 从知识库中读取章节的完整内容。在回答用户问题之前使用此工具检索已存储的知识。';
  schema = z.object({
    chapterId: z.string().describe('The unique ID of the chapter to read'),
  });

  async _call(input: { chapterId: string }): Promise<string> {
    const kbPath = getKbPath();
    if (!kbPath) return 'Error: Knowledge base path not configured.';

    const result = resolveChapter(kbPath, input.chapterId);
    if (!result) return `Chapter "${input.chapterId}" not found in knowledge base.`;
    const content = result.content || '(empty chapter)';
    return truncateToolResult(content);
  }
}

// ===== write_chapter =====

class WriteChapterTool extends StructuredTool {
  name = 'write_chapter';
  description = '向知识库写入或更新章节。可创建新文件或追加到已有文件。写入前务必征得用户同意。';
  schema = z.object({
    filePath: z.string().describe('Relative path for the .md file, e.g. "Rust.md"'),
    heading: z.string().describe('Markdown heading for the chapter, e.g. "### Ownership Rules"'),
    content: z.string().describe('Full Markdown content of the chapter body'),
    domain: z.string().describe('Top-level domain, e.g. "Rust"'),
    subdomain: z.string().describe('Subdomain, e.g. "Ownership System"'),
    isNewFile: z.boolean().describe('Whether this is a brand new file'),
    isNewChapter: z.boolean().describe('Whether this is a new chapter in an existing file'),
  });

  async _call(input: {
    filePath: string;
    heading: string;
    content: string;
    domain: string;
    subdomain: string;
    isNewFile: boolean;
    isNewChapter: boolean;
  }): Promise<string> {
    const kbPath = getKbPath();
    if (!kbPath) return 'Error: Knowledge base path not configured.';

    try {
      writeChapterContent(
        kbPath,
        input.filePath,
        '',
        input.content,
        input.heading,
        input.domain,
        input.subdomain,
        input.isNewFile,
        input.isNewChapter,
      );

      const index = buildIndex(kbPath);
      saveIndex(kbPath, index);

      return `Successfully wrote chapter "${input.heading}" to ${input.filePath}`;
    } catch (err) {
      return `Error writing chapter: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ===== search_knowledge =====

class SearchKnowledgeTool extends StructuredTool {
  name = 'search_knowledge';
  description = '搜索知识库中的相关章节。返回匹配章节的 ID、标题和摘要。在回答用户问题之前使用此工具查找相关的已存储知识。';
  schema = z.object({
    query: z.string().describe('Search query — keywords to match against chapter titles and summaries'),
  });

  async _call(input: { query: string }): Promise<string> {
    const kbPath = getKbPath();
    if (!kbPath) return 'Error: Knowledge base path not configured.';

    try {
      const index = getOrBuildIndex(kbPath);
      const query = input.query.toLowerCase();
      const results: { id: string; filePath: string; heading: string; title: string; summary: string }[] = [];

      for (const file of Object.values(index.files)) {
        for (const h2 of file.sections) {
          const h2Text = `${h2.heading} ${h2.summary}`.toLowerCase();
          if (h2Text.includes(query)) {
            results.push({ id: h2.id, filePath: file.path, heading: h2.heading, title: file.title, summary: h2.summary });
          }
          for (const h3 of h2.children) {
            const h3Text = `${h3.heading} ${h3.summary}`.toLowerCase();
            if (h3Text.includes(query)) {
              results.push({ id: h3.id, filePath: file.path, heading: h3.heading, title: file.title, summary: h3.summary });
            }
          }
        }
      }

      if (results.length === 0) {
        return `No knowledge base entries found matching "${input.query}".`;
      }

      const resultJson = JSON.stringify(results.slice(0, 10), null, 2);
      return truncateSearchResults(resultJson);
    } catch (err) {
      return `Error searching knowledge base: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ===== list_files =====

class ListFilesTool extends StructuredTool {
  name = 'list_files';
  description = '列出知识库中的所有 Markdown 文件及其标题。使用此工具了解有哪些领域和主题可用。';
  schema = z.object({});

  async _call(): Promise<string> {
    const kbPath = getKbPath();
    if (!kbPath) return 'Error: Knowledge base path not configured.';

    try {
      const files = listMarkdownFiles(kbPath);
      if (files.length === 0) return 'Knowledge base is empty — no Markdown files found.';

      const entries = files.map((f) => {
        const entry = buildFileEntry(kbPath, f);
        return { fileName: f, title: entry.title };
      });

      return JSON.stringify(entries, null, 2);
    } catch (err) {
      return `Error listing files: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export const readChapterTool = new ReadChapterTool();
export const writeChapterTool = new WriteChapterTool();
export const searchKnowledgeTool = new SearchKnowledgeTool();
export const listFilesTool = new ListFilesTool();

export const KNOWLEDGE_BASE_TOOLS = [readChapterTool, writeChapterTool, searchKnowledgeTool, listFilesTool];
