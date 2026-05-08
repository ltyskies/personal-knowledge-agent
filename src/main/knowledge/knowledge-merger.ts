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
    let prompt = `你是一个严格的知识库追加编辑助手。你的唯一任务是将新知识追加到已有内容的末尾。

=== [保留范围开始] 已有内容 — 必须原样保留，禁止任何修改 ===
${existingContent}
=== [保留范围结束] ===

=== 新知识点（仅提取新增信息） ===
标题：${item.title}
子领域：${item.subdomain}
内容：
${item.content}
===

核心规则（逐条遵守，违反任一条即为失败）：
1. [保留范围] 内的内容必须逐字保留，一个标点都不能改，一个段落都不能删，顺序不能调
2. 仔细对比新旧内容，找出新知识点中有但已有内容中完全没有的信息
3. 仅将纯新增的信息追加到已有内容末尾（用 "---" 分隔线隔开），不在已有内容中间插内容
4. 如果新知识点与已有内容高度重复（核心事实已存在），直接原样返回已有内容（含 [保留范围] 标记的原文，但去掉标记本身）
5. 不"优化"已有内容——即使旧内容有瑕疵，也不要修正、重排或精简
6. 保持 Markdown 格式

错误做法（绝对禁止）：
- "我把旧内容重新整理了一下" → 错！已有内容不需要整理
- "旧的内容比较乱，我帮你重构了结构" → 错！结构不能动
- "我合并了新旧内容，让它们更连贯" → 错！旧内容独立存在，新内容追加在末尾即可

正确做法：
- 已有内容完整保留 → 分隔线 "---" → 新内容的补充信息
- 如果新内容与已有高度重复 → 直接返回已有内容（不做任何改动）

最后，在合并后的内容末尾附上一行变更说明：
> 📝 本次新增：<一句话说明新增了什么>`;

    // 如果有上一轮的审查反馈，注入到 prompt 中
    if (reviewFeedback) {
      prompt += `\n\n=== 上一轮审查反馈（必须修正） ===
${reviewFeedback}

请根据以上反馈重新合并。特别注意反馈中指出的被删除或篡改的内容，必须在本次合并中恢复。`;
    }

    return prompt;
  }

  // 新建章节 — 无旧内容，不需要审查
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
      content: existingContent
        ? '你是一个严格的知识库追加编辑助手。核心原则：已有内容必须原样保留（逐字、逐段、逐行），只能在末尾追加新信息。绝不修改、删除、重排已有内容。只返回合并后的 Markdown 内容，不要加额外解释或前缀。'
        : '你是一个精确的知识库编辑助手。只返回格式化后的 Markdown 内容，不要加额外解释或前缀。',
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
      feedback += '\n\n紧急：旧版本内容大量丢失！请严格逐字保留 [保留范围] 内的全部内容，只能追加，不能删除任何已有文字。';
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
