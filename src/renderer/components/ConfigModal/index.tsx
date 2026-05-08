/**
 * 配置弹窗组件
 *
 * API 设置弹窗，支持修改：
 * - API Base URL（OpenAI 兼容地址）
 * - API Key（密码输入框，加密存储）
 * - Model 名称
 *
 * 点击遮罩层可关闭弹窗（通过比较 e.target === e.currentTarget 判断）。
 */
import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { AppConfig } from '../../../shared/types';

interface ConfigModalProps {
  open: boolean;
  onClose: () => void;
}

export default function ConfigModal({ open, onClose }: ConfigModalProps) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [baseURL, setBaseURL] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // 每次打开弹窗时重新加载配置
  useEffect(() => {
    if (!open) return;

    window.knowledgeAgent.config.get().then((data) => {
      const c = data as AppConfig;
      setConfig(c);
      setBaseURL(c.api.baseURL);
      setKey(c.api.key);
      setModel(c.api.model);
      setMessage(null);
    });
  }, [open]);

  if (!open) return null;

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setMessage(null);

    const updated: AppConfig = {
      ...config,
      api: { baseURL, key, model },
    };

    try {
      await window.knowledgeAgent.config.set(updated);
      setMessage('配置已保存');
    } catch (err) {
      setMessage(`保存失败: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        // 仅点击遮罩层（背景）时关闭，点击弹窗内容不关闭
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200">API 设置</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              API Base URL
            </label>
            <input
              type="text"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.deepseek.com/v1"
              className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              API Key
            </label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-..."
              className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Model
            </label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="deepseek-chat"
              className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {message && (
            <p
              className={`text-xs ${message.includes('失败') ? 'text-red-500' : 'text-green-500'}`}
            >
              {message}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50 transition-colors"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
