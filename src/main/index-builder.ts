/**
 * 知识库索引构建器
 *
 * 扫描知识库目录中所有 .md 文件，解析 Markdown 结构（标题、章节），
 * 生成 index.json 供快速检索和章节匹配使用。
 *
 * index.json 结构：{ files: Record<文件名, FileEntry>, lastUpdated: ISO时间 }
 * - 系统自动维护，不手动编辑
 * - 每次知识写入后自动重建
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { IndexData, FileEntry } from '../shared/types';
import { listMarkdownFiles, buildFileEntry } from './file-system';

const INDEX_FILENAME = 'index.json';

export function loadIndex(kbPath: string): IndexData | null {
  const indexPath = join(kbPath, INDEX_FILENAME);
  if (!existsSync(indexPath)) return null;
  const raw = readFileSync(indexPath, 'utf-8');
  return JSON.parse(raw) as IndexData;
}

export function saveIndex(kbPath: string, index: IndexData): void {
  const indexPath = join(kbPath, INDEX_FILENAME);
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
}

/**
 * 全量重建索引
 *
 * 遍历知识库所有 Markdown 文件，解析每个文件的标题、章节结构，
 * 提取各章节前 100 字作为摘要，写入 index.json。
 */
export function buildIndex(kbPath: string): IndexData {
  const mdFiles = listMarkdownFiles(kbPath);
  const files: Record<string, FileEntry> = {};

  for (const fileName of mdFiles) {
    try {
      files[fileName] = buildFileEntry(kbPath, fileName);
    } catch {
      // 解析失败的文件跳过，不影响其他文件的索引
    }
  }

  return {
    files,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * 获取索引（优先使用缓存）
 *
 * 如果 index.json 已存在则直接返回，否则构建新索引。
 * 这避免了每次请求都重新扫描所有文件。
 */
export function getOrBuildIndex(kbPath: string): IndexData {
  const cached = loadIndex(kbPath);
  if (cached) return cached;
  const index = buildIndex(kbPath);
  saveIndex(kbPath, index);
  return index;
}
