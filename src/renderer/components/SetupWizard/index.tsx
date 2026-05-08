/**
 * 首次启动引导向导
 *
 * 四步骤引导流程：
 * 1. API 配置：设置 AI 服务的 Base URL、API Key、Model
 * 2. 知识库路径：选择或输入本地 Markdown 知识库的存储目录
 * 3. Git 配置：设置 commit 时使用的作者名和邮箱
 * 4. 完成：确认配置，初始化知识库（创建目录 + git init）
 *
 * 步骤指示器显示当前进度，已完成步骤显示对勾图标。
 * 配置通过 IPC 保存到 ~/.knowledge-agent/config.json。
 */
import { useState, useEffect, useCallback } from 'react';
import { Check, ArrowRight, FolderOpen, RefreshCw, Globe, BookOpen, GitBranch } from 'lucide-react';
import type { AppConfig } from '../../shared/types';

interface SetupWizardProps {
  onComplete: (config: AppConfig) => void;
}

type Step = 'api' | 'kbPath' | 'git' | 'done';

const STEPS: { key: Step; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { key: 'api', label: 'API 配置', icon: Globe },
  { key: 'kbPath', label: '知识库路径', icon: BookOpen },
  { key: 'git', label: 'Git 初始化', icon: GitBranch },
  { key: 'done', label: '完成', icon: Check },
];

export default function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<Step>('api');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [baseURL, setBaseURL] = useState('https://api.deepseek.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('deepseek-chat');
  const [kbPath, setKbPath] = useState('');
  const [authorName, setAuthorName] = useState('Knowledge Agent');
  const [authorEmail, setAuthorEmail] = useState('agent@local');
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);

  // 加载已有配置（若存在则预填）
  useEffect(() => {
    window.knowledgeAgent.config.get().then((data) => {
      const c = data as AppConfig;
      setConfig(c);
      setBaseURL(c.api.baseURL);
      setApiKey(c.api.key);
      setModel(c.api.model);
      setKbPath(c.kbPath);
      setAuthorName(c.git.authorName);
      setAuthorEmail(c.git.authorEmail);
    });
  }, []);

  const handleBrowseKbPath = useCallback(async () => {
    if (!window.knowledgeAgent.dialog?.selectDirectory) return;
    const dir = await window.knowledgeAgent.dialog.selectDirectory() as string | null;
    if (dir) setKbPath(dir);
  }, []);

  /** 最后一步：保存配置 + 初始化知识库（创建目录 + git init） */
  const handleInitKb = useCallback(async () => {
    if (!config) return;
    setInitializing(true);
    setError(null);

    const updated: AppConfig = {
      ...config,
      kbPath,
      api: { baseURL, key: apiKey, model },
      git: { ...config.git, authorName, authorEmail },
    };

    try {
      await window.knowledgeAgent.config.set(updated);
      const result = await window.knowledgeAgent.kb.initKnowledgeBase(kbPath) as { success: boolean; error?: string };
      if (!result.success) {
        setError(result.error || '初始化失败');
        return;
      }
      setConfig(updated);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInitializing(false);
    }
  }, [config, kbPath, baseURL, apiKey, model, authorName, authorEmail]);

  /** 下一步：保存当前页配置后前进 */
  const handleNext = useCallback(async () => {
    if (!config) return;
    setError(null);

    if (step === 'api') {
      const updated: AppConfig = {
        ...config,
        api: { baseURL, key: apiKey, model },
      };
      await window.knowledgeAgent.config.set(updated);
      setConfig(updated);
      setStep('kbPath');
    } else if (step === 'kbPath') {
      setStep('git');
    }
  }, [step, config, baseURL, apiKey, model]);

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-100 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* 步骤指示器 */}
        <div className="flex items-center px-6 py-4 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center">
              {i > 0 && (
                <div className={`w-8 h-0.5 mx-1 ${i <= stepIndex ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
              )}
              <div className="flex flex-col items-center">
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium ${
                    i < stepIndex
                      ? 'bg-blue-500 text-white'
                      : i === stepIndex
                        ? 'bg-blue-500 text-white ring-4 ring-blue-100 dark:ring-blue-900'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-400'
                  }`}
                >
                  {i < stepIndex ? <Check size={14} /> : <s.icon size={14} />}
                </div>
                <span className={`text-[10px] mt-1 ${i <= stepIndex ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-400'}`}>
                  {s.label}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* 内容区 — 根据当前步骤渲染对应表单 */}
        <div className="px-6 py-6 min-h-[260px]">
          {step === 'api' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-1">配置 AI 服务</h2>
                <p className="text-xs text-gray-500 mb-4">
                  支持所有 OpenAI 兼容 API（DeepSeek、OpenAI、Ollama 等）
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">API Base URL</label>
                <input
                  type="text"
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
                  placeholder="https://api.deepseek.com/v1"
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Model</label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="deepseek-chat"
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          )}

          {step === 'kbPath' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-1">选择知识库目录</h2>
                <p className="text-xs text-gray-500 mb-4">
                  知识库将以 Markdown 文件存储在此目录中
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">知识库路径</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={kbPath}
                    onChange={(e) => setKbPath(e.target.value)}
                    placeholder="~/knowledge-base"
                    className="flex-1 px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={handleBrowseKbPath}
                    className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-1 shrink-0"
                  >
                    <FolderOpen size={14} />
                    浏览
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 'git' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-1">Git 配置</h2>
                <p className="text-xs text-gray-500 mb-4">
                  每次知识更新后将自动 commit，方便追溯变更历史
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Author Name</label>
                <input
                  type="text"
                  value={authorName}
                  onChange={(e) => setAuthorName(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Author Email</label>
                <input
                  type="email"
                  value={authorEmail}
                  onChange={(e) => setAuthorEmail(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center justify-center py-6">
              <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-4">
                <Check size={28} className="text-green-500" />
              </div>
              <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-2">配置完成</h2>
              <p className="text-sm text-gray-500 text-center max-w-xs">
                知识库已就绪！开始与 AI 对话，知识将自动沉淀到本地。
              </p>
            </div>
          )}

          {error && (
            <div className="mt-4 px-3 py-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
          <div className="text-xs text-gray-400">
            {stepIndex + 1} / {STEPS.length}
          </div>
          <div className="flex gap-2">
            {step !== 'done' ? (
              step === 'git' ? (
                <button
                  onClick={handleInitKb}
                  disabled={initializing}
                  className="inline-flex items-center gap-1.5 px-5 py-1.5 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50 transition-colors"
                >
                  {initializing ? (
                    <>
                      <RefreshCw size={14} className="animate-spin" />
                      初始化中...
                    </>
                  ) : (
                    <>
                      初始化知识库
                      <ArrowRight size={14} />
                    </>
                  )}
                </button>
              ) : (
                <button
                  onClick={handleNext}
                  className="inline-flex items-center gap-1.5 px-5 py-1.5 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors"
                >
                  下一步
                  <ArrowRight size={14} />
                </button>
              )
            ) : (
              <button
                onClick={() => config && onComplete(config)}
                className="inline-flex items-center gap-1.5 px-5 py-1.5 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors"
              >
                开始使用
                <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
