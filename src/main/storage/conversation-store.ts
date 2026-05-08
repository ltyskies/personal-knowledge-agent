/**
 * 对话持久化存储
 *
 * 将对话历史以 JSON 文件形式存储在 `~/.knowledge-agent/conversations/` 目录下。
 * 每个对话一个文件，索引文件 `index.json` 记录所有对话的元数据。
 *
 * 对话 ID 生成：使用时间戳 + 随机数的 36 进制字符串，保证唯一性且无需依赖外部库。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Conversation, ConversationMeta } from '../../shared/types';

const CONV_DIR = join(homedir(), '.knowledge-agent', 'conversations');
const INDEX_PATH = join(CONV_DIR, 'index.json');

function ensureDir(): void {
  if (!existsSync(CONV_DIR)) {
    mkdirSync(CONV_DIR, { recursive: true });
  }
}

function readIndex(): ConversationMeta[] {
  ensureDir();
  if (!existsSync(INDEX_PATH)) return [];
  const raw = readFileSync(INDEX_PATH, 'utf-8');
  return JSON.parse(raw) as ConversationMeta[];
}

function writeIndex(meta: ConversationMeta[]): void {
  ensureDir();
  writeFileSync(INDEX_PATH, JSON.stringify(meta, null, 2), 'utf-8');
}

function convPath(id: string): string {
  return join(CONV_DIR, `${id}.json`);
}

/** 生成唯一 ID — Date.now().toString(36) + 随机后缀，碰撞概率极低 */
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 列出所有对话，按更新时间倒序 */
export function listConversations(): ConversationMeta[] {
  const meta = readIndex();
  meta.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return meta;
}

export function getConversation(id: string): Conversation | null {
  const p = convPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8')) as Conversation;
}

/**
 * 保存对话（新增或更新）
 *
 * 同时更新对话文件本身和 index.json 中的索引记录。
 * updatedAt 自动更新时间戳用于排序。
 */
export function saveConversation(conv: Conversation): void {
  ensureDir();
  conv.updatedAt = new Date().toISOString();
  writeFileSync(convPath(conv.id), JSON.stringify(conv, null, 2), 'utf-8');

  const metaList = readIndex();
  const idx = metaList.findIndex((m) => m.id === conv.id);
  const entry: ConversationMeta = {
    id: conv.id,
    title: conv.title,
    messageCount: conv.messages.length,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  };
  if (idx >= 0) {
    metaList[idx] = entry;
  } else {
    metaList.push(entry);
  }
  writeIndex(metaList);
}

/** 删除对话：移除对话文件 + 从索引中移除 */
export function deleteConversation(id: string): void {
  const p = convPath(id);
  if (existsSync(p)) unlinkSync(p);
  const metaList = readIndex().filter((m) => m.id !== id);
  writeIndex(metaList);
}

/** 创建新对话，自动生成 ID 和时间戳 */
export function createConversation(): Conversation {
  const now = new Date().toISOString();
  const conv: Conversation = {
    id: generateId(),
    title: '新对话',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  saveConversation(conv);
  return conv;
}
