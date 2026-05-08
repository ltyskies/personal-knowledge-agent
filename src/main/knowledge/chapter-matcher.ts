/**
 * 知识库章节匹配器
 *
 * 给定 AI 提取的知识点列表，使用 AI 将其匹配到知识库中最合适的已有章节。
 * 匹配策略：
 * 1. 将知识库章节列表展平为一级（h2 + h3）
 * 2. 构造 Prompt，让 AI 逐一匹配每个知识点到已有章节
 * 3. 解析 AI 返回的 JSON 匹配结果
 *
 * 如果知识库为空（无章节），返回空匹配列表，后续合并流程将创建新文件。
 */
import type { IndexData, KnowledgeItem, ChapterMatch, Message } from '../shared/types';
import { chatSync } from './ai-client';
import { loadConfig } from './config';

/**
 * 将嵌套的章节索引展平为一维数组
 *
 * 每个章节包含：
 * - id: 唯一标识符（由 file-system.ts 的 buildSectionId 生成）
 * - path: 可读的层级路径（如 "Rust > 所有权系统 > 移动语义"）
 * - summary: 章节内容摘要（用于 AI 匹配）
 */
function flattenChapters(index: IndexData): { id: string; heading: string; filePath: string; path: string; summary: string }[] {
  const chapters: { id: string; heading: string; filePath: string; path: string; summary: string }[] = [];

  for (const file of Object.values(index.files)) {
    for (const h2 of file.sections) {
      chapters.push({
        id: h2.id,
        heading: h2.heading,
        filePath: file.path,
        path: `${file.title} > ${h2.heading.replace(/^##\s*/, '')}`,
        summary: h2.summary,
      });
      for (const h3 of h2.children) {
        chapters.push({
          id: h3.id,
          heading: h3.heading,
          filePath: file.path,
          path: `${file.title} > ${h2.heading.replace(/^##\s*/, '')} > ${h3.heading.replace(/^###\s*/, '')}`,
          summary: h3.summary,
        });
      }
    }
  }

  return chapters;
}

/**
 * 构造 AI 匹配 Prompt
 *
 * 包含：
 * - 知识点的简要信息（domain、subdomain、title、content 前 200 字）
 * - 所有候选章节的 id、标题、路径、概述
 *
 * 让 AI 决定每个知识点适合放入哪个已有章节，或返回空 chapterId 表示新建。
 */
function buildMatchPrompt(
  knowledgeItems: KnowledgeItem[],
  chapters: ReturnType<typeof flattenChapters>,
): string {
  const itemsJson = JSON.stringify(
    knowledgeItems.map((item, i) => ({
      index: i,
      domain: item.domain,
      subdomain: item.subdomain,
      title: item.title,
      content: item.content.slice(0, 200), // 只取前 200 字用于匹配，减少 token 消耗
    })),
    null,
    2,
  );

  const chaptersList = chapters
    .map((c) => `- id: ${c.id}\n  标题：${c.heading}\n  路径：${c.path}\n  概述：${c.summary}`)
    .join('\n');

  return `你是一个知识库检索助手。以下是从对话中提取的知识点：

${itemsJson}

以下是知识库中所有可用的章节：

${chaptersList}

对于每个知识点，从上述章节中找到最匹配的已有章节。
- 如果知识点与某章节高度相关，返回该章节的 id
- 如果找不到合适匹配，chapterId 设为空字符串 ""

请以 JSON 格式返回，只返回 JSON 数组，不要其他内容：
[{"knowledgeIndex": 0, "chapterId": "xxx"}, ...]`;
}

/**
 * 将知识点列表匹配到知识库已有章节
 *
 * 使用低温度（temperature=0.1）确保匹配结果稳定可复现。
 * 每个知识点的 chapterId 为 '' 时，后续合并流程将创建新章节。
 */
export async function matchChapters(knowledgeItems: KnowledgeItem[], index: IndexData): Promise<ChapterMatch[]> {
  const config = loadConfig();
  const chapters = flattenChapters(index);

  // 知识库无章节时，所有匹配结果为空
  if (chapters.length === 0) {
    return knowledgeItems.map(() => ({
      id: '',
      filePath: '',
      heading: '',
    }));
  }

  const prompt = buildMatchPrompt(knowledgeItems, chapters);

  const messages: Message[] = [
    {
      role: 'system',
      content: '你是一个精确的知识库匹配助手。只返回 JSON 数组，不要解释。',
    },
    { role: 'user', content: prompt },
  ];

  const response = await chatSync(config.api.baseURL, config.api.key, config.api.model, messages, {
    temperature: 0.1,
    maxTokens: 500,
  });

  try {
    // AI 响应可能包含额外文本，用正则提取 JSON 数组部分
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const matches = JSON.parse(jsonMatch[0]) as { knowledgeIndex: number; chapterId: string }[];

    return knowledgeItems.map((_item, i) => {
      const match = matches.find((m) => m.knowledgeIndex === i);
      if (!match || !match.chapterId) {
        return { id: '', filePath: '', heading: '' };
      }
      const chapter = chapters.find((c) => c.id === match.chapterId);
      return {
        id: chapter?.id || '',
        filePath: chapter?.filePath || '',
        heading: chapter?.heading || '',
      };
    });
  } catch {
    // JSON 解析失败时返回全空，后续流程将为每个知识点创建新章节
    return knowledgeItems.map(() => ({ id: '', filePath: '', heading: '' }));
  }
}
