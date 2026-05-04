/**
 * 错误边界组件
 *
 * 使用 React Class Component 实现（Error Boundary 需要 componentDidCatch/static getDerivedStateFromError）。
 * 捕获子树中未处理的渲染错误，显示友好的错误界面，提供：
 * - 重试：重置错误状态，重新渲染子组件
 * - 重启：刷新整个应用（window.location.reload）
 * - 显示错误信息和堆栈（便于调试）
 */
import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  handleReload = () => {
    this.setState({ error: null });
  };

  handleRestart = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
          <div className="text-center max-w-md mx-4">
            <div className="w-14 h-14 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mx-auto mb-4">
              <AlertTriangle size={28} className="text-red-500" />
            </div>
            <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-2">
              应用出现错误
            </h1>
            <p className="text-sm text-gray-500 mb-2">
              {this.state.error.message}
            </p>
            {this.state.error.stack && (
              <pre className="text-xs text-gray-400 mt-2 mb-4 p-3 bg-gray-100 dark:bg-gray-800 rounded-md max-h-40 overflow-y-auto text-left">
                {this.state.error.stack}
              </pre>
            )}
            <div className="flex gap-2 justify-center">
              <button
                onClick={this.handleReload}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors"
              >
                <RefreshCw size={14} />
                重试
              </button>
              <button
                onClick={this.handleRestart}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                重启应用
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
