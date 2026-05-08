/**
 * 输入区域组件
 *
 * 消息输入框 + 发送按钮。支持：
 * - Enter 发送（Shift+Enter 换行）
 * - 流式输出期间禁用输入
 * - 自适应高度（rows=2 起，resize 允许用户拖拽调整）
 */
import { Send } from 'lucide-react';
import { useState, KeyboardEvent } from 'react';

interface InputAreaProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export default function InputArea({ onSend, disabled }: InputAreaProps) {
  const [input, setInput] = useState('');

  const handleSend = () => {
    const text = input.trim();
    if (!text || disabled) return;
    onSend(text);
    setInput('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 p-3">
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? 'AI 正在回复中...' : '输入消息，Enter 发送，Shift+Enter 换行'}
          disabled={disabled}
          rows={2}
          className="flex-1 resize-none rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={disabled}
          className="flex items-center justify-center px-5 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
