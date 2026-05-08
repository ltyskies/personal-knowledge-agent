/**
 * 知识合并引擎
 *
 * 将 AI 提取的知识点与知识库已有章节进行智能合并。
 * 核心原则：已有内容必须原样保留，只能追加新信息，绝不修改或删除现有内容。
 *
 * 合并流程：
 * 1. 根据章节匹配结果，读取已有章节内容（如果存在）
 * 2. 构造合并 Prompt，让 AI 判断新增信息并追加到已有内容末尾
 * 3. Sub Agent 审查合并结果，确保旧内容未被删除或篡改
 * 4. 审查驳回时，将反馈注入主 Agent 重试（最多 5 轮）
 * 5. 返回 MergeResult（包含新旧内容、审查结果等元数据）
 */
import { chatSync } from '../ai/ai-client';
import { loadConfig } from '../storage/config';
import { resolveChapter } from './file-system';
import { reviewMerge } from '../ai/knowledge-reviewer';
import {
  MERGE_SYSTEM_PROMPT_EXISTING,
  MERGE_SYSTEM_PROMPT_NEW,
  buildMergeUserPromptExisting,
  buildMergeUserPromptNew,
  MERGE_EMERGENCY_FEEDBACK,
} from '../ai/prompts';
import type { KnowledgeItem, ChapterMatch, MergeResult, Message, ReviewResult } from '../../shared/types';

/** 审查-重试最大轮数 */
const MAX_REVIEW_ROUNDS = 5;

/**
 * 构造主 Agent 合并 Prompt（增强版）
 *
 * 相比旧版的关键改进：
 * 1. 用 [保留范围] 标记强化边界意识
 * 2. 增加反例说明，告诉模型"什么是错的"
 * 3. 要求变更说明，让模型显式确认新增了什么
 */
function buildMergePrompt(
  item: KnowledgeItem,
  existingContent: string | null,
  reviewFeedback?: string,
): string {
  if (existingContent) {
    return buildMergeUserPromptExisting(
      existingContent,
      item.title,
      item.subdomain,
      item.content,
      reviewFeedback,
    );
  }

  return buildMergeUserPromptNew(item.title, item.subdomain, item.content);
}

/**
 * 单次合并调用（主 Agent）
 */
async function mergeOnce(
  item: KnowledgeItem,
  existingContent: string | null,
  reviewFeedback?: string,
): Promise<string> {
  const config = loadConfig();
  const prompt = buildMergePrompt(item, existingContent, reviewFeedback);

  const messages: Message[] = [
    {
      role: 'system',
      content: existingContent ? MERGE_SYSTEM_PROMPT_EXISTING : MERGE_SYSTEM_PROMPT_NEW,
    },
    { role: 'user', content: prompt },
  ];

  // 有反馈时用稍高温度增加修正灵活性，正常合并用低温度确保稳定
  const temperature = reviewFeedback ? 0.4 : 0.3;
  return chatSync(config.api.baseURL, config.api.key, config.api.model, messages, { temperature });
}

/**
 * 执行知识合并（含 Sub Agent 审查循环）
 *
 * 返回完整的 MergeResult，包含：
 * - isNewChapter: 是否为全新章节（无已有内容匹配）
 * - isNewFile: 是否需要创建新文件
 * - filePath/chapterId/heading: 目标位置信息
 * - reviewResult: Sub Agent 审查结果
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

  const isNewChapter = !match.id;

  // 新建章节：直接格式化，不需要审查（无旧内容可删）
  if (!existingContent) {
    const newContent = await mergeOnce(item, null);

    return {
      filePath: match.filePath || `${item.domain}.md`,
      chapterId: match.id || '',
      heading: match.heading || `### ${item.title}`,
      oldContent: '',
      newContent,
      isNewChapter,
      isNewFile: isNewChapter && !match.filePath,
      domain: item.domain,
      subdomain: item.subdomain,
      title: item.title,
    };
  }

  // === 已有内容的合并：进入审查循环 ===
  let mergedContent = '';
  let reviewResult: ReviewResult | undefined;
  let feedback: string | undefined;

  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
    // 主 Agent 执行合并
    mergedContent = await mergeOnce(item, existingContent, feedback);

    // Sub Agent 审查
    reviewResult = await reviewMerge(existingContent, mergedContent, item);

    if (reviewResult.approved) {
      break;
    }

    // 审查驳回：将问题列表注入下一轮
    feedback = reviewResult.issues
      .map((issue, i) => `${i + 1}. ${issue}`)
      .join('\n');

    // 如果评分极低（<0.3），说明内容大量丢失，补充更严格的指令
    if (reviewResult.score < 0.3) {
      feedback += '\n\n' + MERGE_EMERGENCY_FEEDBACK;
    }
  }

  return {
    filePath: match.filePath || `${item.domain}.md`,
    chapterId: match.id || '',
    heading: match.heading || `### ${item.title}`,
    oldContent: existingContent,
    newContent: mergedContent,
    isNewChapter,
    isNewFile: false,
    domain: item.domain,
    subdomain: item.subdomain,
    title: item.title,
    reviewResult,
  };
}
