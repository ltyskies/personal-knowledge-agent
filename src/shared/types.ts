/**
 * 共享类型定义
 *
 * Main 进程和 Renderer 进程均可引用此文件。
 *
 * 类型分类：
 * - 应用配置：AppConfig, APIConfig, RelevanceConfig, GitConfig
 * - 知识库结构：FileEntry, SectionEntry, FileNode, SectionNode, IndexData
 * - AI 对话：Message, Chunk
 * - 知识提取与合并：KnowledgeItem, ChapterMatch, MergeInput, MergeResult, WriteInput
 * - 对话管理：Conversation, ConversationMeta
 * - Git 操作：GitStatus
 */

// ===== 应用配置 =====

export interface APIConfig {
  baseURL: string;
  key: string;
  model: string;
}

/** 章节匹配策略参数 */
export interface RelevanceConfig {
  maxChapters: number;       // 每次匹配最多返回的候选章节数
  maxSummaryLength: number;  // 章节摘要的最大长度（字符数）
}

export interface GitConfig {
  autoCommit: boolean;       // 是否在知识写入后自动 commit
  authorName: string;        // commit 使用的作者名
  authorEmail: string;       // commit 使用的邮箱
}

/** 应用全局配置 — 存储在 ~/.knowledge-agent/config.json */
export interface AppConfig {
  kbPath: string;
  api: APIConfig;
  relevance: RelevanceConfig;
  git: GitConfig;
}

// ===== 知识库结构 =====

/** 章节摘要条目 — 用于索引和树形展示 */
export interface SectionEntry {
  id: string;                // 唯一 ID（由 buildSectionId 生成）
  heading: string;           // 原始 Markdown 标题（含 ##/### 前缀）
  level: 2 | 3;             // 标题层级
  summary: string;           // 内容摘要（前 100 字符）
  children: SectionEntry[];  // 子章节（H2 → H3 嵌套）
}

/** 文件条目 — index.json 中每个 .md 文件的索引记录 */
export interface FileEntry {
  path: string;              // 相对于知识库根目录的文件路径
  title: string;             // 文件标题（一级标题文本）
  mtime: string;             // 最后修改时间（ISO 格式）
  summary: string;           // 文件导语摘要
  sections: SectionEntry[];  // 章节树
}

/** 索引文件（index.json）的完整结构 */
export interface IndexData {
  files: Record<string, FileEntry>;  // key = 文件名
  lastUpdated: string;
}

/** 文件节点 — 传给 Renderer 的简化树形结构（不含元数据） */
export interface FileNode {
  name: string;              // 文件名（不含 .md 扩展名）
  path: string;              // 相对路径
  title: string;             // 文件标题
  sections: SectionNode[];   // 章节树
}

/** 章节节点 — 树形展示的最小单元 */
export interface SectionNode {
  id: string;
  heading: string;
  level: 2 | 3;
  summary: string;
  children: SectionNode[];   // 递归结构，支持多级嵌套
}

// ===== AI 对话 =====

/** 流式请求状态 */
export type StreamStatus = 'pending' | 'completed' | 'interrupted' | 'failed';

/** 流式错误类型 — 用于前后端统一归因 */
export type StreamErrorType =
  | 'connection_timeout'
  | 'stream_timeout'
  | 'network_error'
  | 'api_error'
  | 'unexpected_eof'
  | 'parse_error'
  | 'user_aborted'
  | 'non_stream_response';

/** 结构化流错误 — Main 通过 IPC 推送给 Renderer */
export interface StreamErrorInfo {
  type: StreamErrorType;
  message: string;
  retryable: boolean;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** 请求标识 — 同一轮 user+assistant 共享，用于精确定位和重试 */
  requestId?: string;
  /** 流式请求状态 — 仅 user/assistant 消息使用 */
  status?: StreamStatus;
  /** 失败时是否可重试 */
  retryable?: boolean;
  /** 失败时的错误描述 */
  errorMessage?: string;
}

/** 流式响应的单个数据块 — done=true 表示流结束 */
export interface Chunk {
  content: string;
  done: boolean;
}

// ===== 知识提取 =====

/** AI 从对话中提取的知识点 */
export interface KnowledgeItem {
  domain: string;                // 所属领域（如 "Rust"）
  subdomain: string;             // 子领域（如 "所有权系统"）
  title: string;                 // 知识点标题（如 "移动语义"）
  content: string;               // Markdown 格式的知识内容（200-500字）
  relatedQuestions: string[];    // 相关问题列表
}

/** 知识点与知识库章节的匹配结果 */
export interface ChapterMatch {
  id: string;        // 匹配到的章节 ID，空字符串表示无匹配（需新建）
  filePath: string;  // 匹配到的文件路径
  heading: string;   // 匹配到的章节标题
  score?: number;    // 匹配置信度（可选）
}

// ===== 知识合并 =====

export interface MergeInput {
  knowledgeItem: KnowledgeItem;
  chapterMatch: ChapterMatch;
}

/** 合并结果 — 包含合并前后的完整信息 */
export interface MergeResult {
  filePath: string;
  chapterId: string;
  heading: string;
  oldContent: string;       // 合并前的内容（已有章节内容或空字符串）
  newContent: string;       // AI 合并后的内容
  isNewChapter: boolean;    // 是否为全新章节（无已有章节匹配）
  isNewFile: boolean;       // 是否需要创建新文件
  domain: string;
  subdomain: string;
  title: string;
  recordedMtime?: string;   // 合并时记录的文件 mtime（由 ipc-handlers 补充）
}

/** 写入请求 — 用户确认后的写入参数 */
export interface WriteInput {
  filePath: string;
  chapterId: string;
  newContent: string;
  domain: string;
  subdomain: string;
  title: string;
  heading: string;
  isNewChapter: boolean;
  isNewFile: boolean;
  recordedMtime: string;   // 用于冲突检测：写入前对比当前 mtime
}

// ===== 对话管理 =====

/** 对话元数据 — 用于列表展示（不包含消息内容） */
export interface ConversationMeta {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 对话完整数据 — 包含所有消息 */
export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

// ===== Git 操作 =====

export interface GitStatus {
  isRepo: boolean;
  dirty: boolean;           // 是否有未提交的变更
  changedFiles: string[];
}
