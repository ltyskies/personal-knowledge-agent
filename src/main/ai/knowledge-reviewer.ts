/**
 * 知识审查 Agent（Sub Agent）
 *
 * 职责：独立审查主 Agent 的合并产出，确保已有内容未被删除或篡改。
 * 这是一个独立的 AI 调用，角色定位为"严格的内容审计员"，不是编辑。
 *
 * 审查流程：
 * 1. 接收旧内容 + 主 Agent 合并产出 + 新增知识点
 * 2. 逐段对比旧内容是否在新内容中完整保留
 * 3. 返回 { approved, issues, score, summary }
 *
 * 审查维度：
 * - 完整性：旧内容每个段落是否在新内容中出现
 * - 准确性：旧内容的措辞、代码块、格式是否被修改
 * - 纯增量性：是否有不应出现的删除、重排、精简
 */
import { chatSync } from './ai-client';
import { loadConfig } from '../storage/config';
import { REVIEW_SYSTEM_PROMPT, buildReviewUserPrompt } from './prompts';
import type { KnowledgeItem, ReviewResult } from '../../shared/types';

/**
 * 审查合并结果 — Sub Agent 入口
 *
 * @param oldContent - 合并前的已有章节内容（可能为空）
 * @param newContent - 主 Agent 合并后产出的内容
 * @param item - 本次新增的知识点（用于理解变更意图）
 * @returns ReviewResult — approved 为 true 才能写入
 */
export async function reviewMerge(
  oldContent: string,
  newContent: string,
  item: KnowledgeItem,
): Promise<ReviewResult> {
  const config = loadConfig();

  // 审查使用低温度确保判断稳定
  const response = await chatSync(
    config.api.baseURL,
    config.api.key,
    config.api.model,
    [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: buildReviewUserPrompt(oldContent, newContent, item.title, item.domain, item.subdomain) },
    ],
    { temperature: 0.1 },
  );

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        approved: false,
        issues: ['审查 Agent 返回格式异常，无法解析'],
        score: 0,
        summary: '审查失败：JSON 解析错误',
      };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      approved: Boolean(parsed.approved),
      issues: Array.isArray(parsed.issues) ? parsed.issues : [String(parsed.issues || '未知问题')],
      score: typeof parsed.score === 'number' ? parsed.score : 0,
      summary: String(parsed.summary || ''),
    };
  } catch {
    return {
      approved: false,
      issues: ['审查 Agent 响应解析失败'],
      score: 0,
      summary: '审查失败：响应解析异常',
    };
  }
}
