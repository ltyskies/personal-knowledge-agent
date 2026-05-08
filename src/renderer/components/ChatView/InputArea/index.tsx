/**
 * 输入区域组件
 *
 * 消息输入框 + 发送/停止按钮。支持：
 * - Enter 发送（Shift+Enter 换行）
 * - 流式输出期间输入框保持可用，按钮切换为停止按钮
 * - 流式中有内容时点击按钮 → 先中断再发送
 * - 自适应高度（rows=2 起，resize 允许用户拖拽调整）
 */
import { Send, Square } from 'lucide-react';
import { useState, KeyboardEvent } from 'react';

interface InputAreaProps {
  onSend: (text: string) => void;
  isStreaming?: boolean;
  onStop?: () => void;
}

export default function InputArea({ onSend, isStreaming, onStop }: InputAreaProps) {
  const [input, setInput] = useState('');

  const handleSend = () => {
    // 流式生成中 → 仅停止，不清空输入，用户可编辑后再次点击发送
    if (isStreaming) {
      onStop?.();
      return;
    }
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = input.trim().length > 0 || isStreaming;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 p-3">
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? 'AI 正在回复中，你也可以输入新问题...' : '输入消息，Enter 发送，Shift+Enter 换行'}
          rows={2}
          className="flex-1 resize-none rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          className={`flex items-center justify-center px-5 text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
            isStreaming
              ? 'bg-red-500 hover:bg-red-600'
              : 'bg-blue-500 hover:bg-blue-600'
          }`}
        >
          {isStreaming ? <Square size={16} /> : <Send size={16} />}
        </button>
      </div>
    </div>
  );
}
