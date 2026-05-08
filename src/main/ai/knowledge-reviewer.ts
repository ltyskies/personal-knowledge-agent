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

  const systemPrompt = `你是一个严格的知识库内容审计员。你的唯一职责是：检查"新版本内容"是否完整保留了"旧版本内容"的全部信息。

你不是编辑，你不修改内容。你只做判断和报告。

审查标准（严格遵守）：
1. 旧版本中的每一个段落、每一个代码块、每一行文字，都必须在合并后版本中原样出现
2. 即使旧版本中有错别字或格式问题，也不允许被"顺手修正"——必须原样保留
3. 新版本只能在末尾追加新内容，不允许在旧内容中间插入、不允许重新排序、不允许改写
4. 旧内容的段落顺序必须保持不变
5. 允许在旧内容末尾用 "---" 分隔线后追加新内容

输出 JSON 格式：
{
  "approved": true/false,
  "issues": ["问题描述1", "问题描述2"],
  "score": 0.0-1.0,
  "summary": "审查摘要（一句话）"
}

评分标准：
- score=1.0: 旧内容完全原样保留，未做任何修改
- score>=0.9: 仅有极微小的格式差异（如多余空行），approved 可以为 true
- score<0.9: 存在内容删除、改写或重排，approved 必须为 false
- score<0.5: 旧内容大部分丢失，approved 必须为 false

重要：新版本可能比旧版本长很多（因为追加了新知识），这是正常的。你只需要关注旧版本的内容是否还在，不关心新增内容的质量。
只返回 JSON，不要其他内容。`;

  const userPrompt = `请审查以下合并结果：

=== 旧版本内容（必须原样保留） ===
${oldContent || '（空 — 这是新建章节，无旧内容需要审查）'}
=== 旧版本内容结束 ===

=== 合并后新版本内容 ===
${newContent}
=== 新版本内容结束 ===

本次新增的知识点标题：「${item.title}」
所属领域：${item.domain} > ${item.subdomain}

请逐段对比，检查旧版本内容是否在新版本中完整保留。`;

  // 审查使用低温度确保判断稳定
  const response = await chatSync(
    config.api.baseURL,
    config.api.key,
    config.api.model,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
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
