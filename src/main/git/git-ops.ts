/**
 * Git 操作封装
 *
 * 通过 simple-git 库操作知识库所在目录的 Git 仓库。
 * 功能：初始化仓库、查询状态、自动 commit。
 *
 * commit message 由 AI 自动生成，遵循 conventional commits 规范（中文）：
 * 格式：docs({领域}): {具体变更描述}
 * 若 AI 生成失败则回退到简单模板。
 */
import simpleGit, { type SimpleGit } from 'simple-git';
import { existsSync } from 'fs';
import { loadConfig } from '../storage/config';
import type { GitStatus } from '../../shared/types';
import { chatSync } from '../ai/ai-client';
import type { Message } from '../../shared/types';

function getGit(kbPath: string): SimpleGit {
  return simpleGit(kbPath);
}

/** 初始化 Git 仓库（如果尚未初始化） */
export async function initRepo(kbPath: string): Promise<void> {
  const git = getGit(kbPath);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    await git.init();
  }
}

/**
 * 查询仓库状态
 *
 * 返回 changedFiles 包含：modified、created、deleted、not_added 四类变更文件。
 */
export async function getStatus(kbPath: string): Promise<GitStatus> {
  const git = getGit(kbPath);
  const isRepo = existsSync(kbPath) && (await git.checkIsRepo().catch(() => false));

  if (!isRepo) {
    return { isRepo: false, dirty: false, changedFiles: [] };
  }

  const status = await git.status();
  const changedFiles = [
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...(status.not_added || []),
  ];

  return {
    isRepo: true,
    dirty: status.staged.length > 0 || changedFiles.length > 0,
    changedFiles,
  };
}

/**
 * 通过 AI 生成中文 commit message
 *
 * 使用小参数模型（temperature=0.3, maxTokens=80），快速生成。
 * 若 API 不可用则回退到模板生成，保证写入流程不中断。
 */
async function generateCommitMessage(
  domain: string,
  title: string,
  isNew: boolean,
): Promise<string> {
  const config = loadConfig();

  const messages: Message[] = [
    {
      role: 'system',
      content:
        '你是一个 commit message 生成助手。根据知识库变更信息生成符合 conventional commits 规范的中文 commit message。格式：docs({领域}): {具体变更描述}。只返回 commit message（单行），不要其他内容。',
    },
    {
      role: 'user',
      content: `领域：${domain}\n知识点：${title}\n类型：${isNew ? '新增' : '更新'}`,
    },
  ];

  try {
    const msg = await chatSync(
      config.api.baseURL,
      config.api.key,
      config.api.model,
      messages,
      { temperature: 0.3, maxTokens: 80 },
    );
    return msg.trim().replace(/^"|"$/g, '');
  } catch {
    // AI 生成失败时回退到简单模板
    return isNew
      ? `docs(${domain}): 新增 ${title}`
      : `docs(${domain}): 更新 ${title}`;
  }
}

/**
 * 执行 Git commit
 *
 * 1. 确保仓库存在（不存在则自动 init）
 * 2. 通过 AI 生成 commit message
 * 3. 使用配置文件中的 author 信息执行 git add + git commit
 *
 * GIT_AUTHOR_NAME/GIT_COMMITTER_NAME 环境变量确保 commit 使用配置的身份，
 * 不暴露用户真实系统身份。
 */
export async function commit(
  kbPath: string,
  files: string[],
  domain: string,
  title: string,
  isNew: boolean,
): Promise<string> {
  const config = loadConfig();
  const git = getGit(kbPath);

  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) {
    await git.init();
  }

  const message = await generateCommitMessage(domain, title, isNew);

  // 使用配置的身份信息，避免暴露用户真实 Git 配置
  await git
    .env({
      GIT_AUTHOR_NAME: config.git.authorName,
      GIT_AUTHOR_EMAIL: config.git.authorEmail,
      GIT_COMMITTER_NAME: config.git.authorName,
      GIT_COMMITTER_EMAIL: config.git.authorEmail,
    })
    .add(files);

  const result = await git.commit(message);
  return result.commit || '';
}
