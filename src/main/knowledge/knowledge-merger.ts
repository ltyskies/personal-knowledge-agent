/**
 * 知识合并引擎
 *
 * 将 AI 提取的知识点与知识库已有章节进行智能合并。
 * 核心原则：已有内容必须原样保留，只能追加新信息，绝不修改或删除现有内容。
 *
 * 合并流程：
 * 1. 根据章节匹配结果，读取已有章节内容（如果存在）
 * 2. 构造合并 Prompt，让 AI 判断新增信息并追加到已有内容末尾
 * 3. 返回 MergeResult（包含新旧内容、是否为新建章节等元数据）
 */
import { chatSync } from '../ai/ai-client';
import { loadConfig } from '../storage/config';
import { resolveChapter } from './file-system';
import type { KnowledgeItem, ChapterMatch, MergeResult, Message } from '../../shared/types';

/**
 * 构造 AI 合并 Prompt
 *
 * 已有内容存在时：强调"已有内容必须逐字保留，只能追加"的原则
 * 新建章节时：要求 AI 将知识点格式化为适合长期存储的 Markdown 内容
 */
function buildMergePrompt(item: KnowledgeItem, existingContent: string | null): string {
  if (existingContent) {
    return `你是一个知识库编辑助手。你需要将新知识点追加到已有内容中，而不是重写或替换已有内容。

---已有内容（必须原样保留，不得修改或删除）---
${existingContent}
---

---新知识点（仅提取新增信息追加）---
标题：${item.title}
子领域：${item.subdomain}
内容：
${item.content}
---

规则（严格遵守）：
1. 已有内容必须逐字保留，一个标点都不能改，一个段落都不能删
2. 仔细对比新旧内容，找出新知识点中有但已有内容中完全没有的信息
3. 仅将新增的信息追加到已有内容的末尾（用分隔线 "---" 隔开），不对已有内容做任何编辑、重排或精简
4. 如果新知识点与已有内容高度重复（核心信息已存在），直接原样返回已有内容
5. 保持 Markdown 格式
6. 只返回合并后的完整内容，不要添加解释或标题前缀`;
  }

  return `你是一个知识库编辑助手。请将以下知识点格式化为适合知识库长期存储的 Markdown 内容：

知识点标题：${item.title}
所属子领域：${item.subdomain}
知识点内容：
${item.content}

规则：
- 内容丰富完整，适合作为独立章节长期查阅
- 保持 Markdown 格式，可包含代码块
- 只返回内容本身，不要添加章节标题（标题已由系统管理）`;
}

/**
 * 执行知识合并
 *
 * 返回完整的 MergeResult，包含：
 * - isNewChapter: 是否为全新章节（无已有内容匹配）
 * - isNewFile: 是否需要创建新文件
 * - filePath/chapterId/heading: 目标位置信息
 */
export async function mergeChapter(
  item: KnowledgeItem,
  match: ChapterMatch,
): Promise<MergeResult> {
  const config = loadConfig();

  let existingContent: string | null = null;
  if (match.filePath && match.id) {
    existingContent = resolveChapter(config.kbPath, match.id)?.content ?? null;
  }

  const prompt = buildMergePrompt(item, existingContent);

  const messages: Message[] = [
    {
      role: 'system',
      content: '你是一个精确的知识库编辑助手。核心原则：已有内容必须原样保留，只能追加新信息，绝不修改或删除现有内容。只返回合并后的 Markdown 内容，不要加额外解释或前缀。',
    },
    { role: 'user', content: prompt },
  ];

  // 使用低温度确保合并结果稳定可控
  const mergedContent = await chatSync(
    config.api.baseURL,
    config.api.key,
    config.api.model,
    messages,
    { temperature: 0.3 },
  );

  const oldContent = existingContent || '';
  const isNewChapter = !match.id;

  return {
    filePath: match.filePath || `${item.domain}.md`,
    chapterId: match.id || '',
    heading: match.heading || `### ${item.title}`,
    oldContent,
    newContent: mergedContent,
    isNewChapter,
    isNewFile: isNewChapter && !match.filePath,
    domain: item.domain,
    subdomain: item.subdomain,
    title: item.title,
  };
}
