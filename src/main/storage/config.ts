/**
 * 应用配置管理
 *
 * 配置文件存储在 `~/.knowledge-agent/config.json`，JSON 格式。
 * 包含以下配置项：
 * - kbPath:  知识库本地目录路径
 * - api:     AI API 连接信息（baseURL、key、model）
 * - relevance:  匹配策略参数
 * - git:     Git 自动提交的用户身份
 *
 * 首次运行自动生成默认配置；配置缺失的字段自动合并默认值。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AppConfig } from '../../shared/types';

const CONFIG_DIR = join(homedir(), '.knowledge-agent');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: AppConfig = {
  kbPath: join(homedir(), 'knowledge-base'),
  api: {
    baseURL: 'https://api.deepseek.com/v1',
    key: '',
    model: 'deepseek-chat',
  },
  relevance: {
    maxChapters: 5,
    maxSummaryLength: 100,
  },
  git: {
    autoCommit: true,
    authorName: 'Knowledge Agent',
    authorEmail: 'agent@local',
  },
};

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * 加载配置，缺失字段用默认值补齐
 *
 * 策略：深度合并 — 顶层属性、api、relevance、git 各自独立合并，
 * 确保新版本添加的配置项能自动回填默认值。
 */
export function loadConfig(): AppConfig {
  ensureConfigDir();
  if (!existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(raw) as Partial<AppConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...config,
    api: { ...DEFAULT_CONFIG.api, ...config.api },
    relevance: { ...DEFAULT_CONFIG.relevance, ...config.relevance },
    git: { ...DEFAULT_CONFIG.git, ...config.git },
  };
}

export function saveConfig(config: AppConfig): void {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

