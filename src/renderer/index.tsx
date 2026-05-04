/**
 * React 渲染进程入口
 *
 * 挂载根组件到 DOM，外层包 ErrorBoundary 捕获未处理的渲染错误。
 * 样式入口 tailwind.css 在此引入，包含 Tailwind CSS 基础样式和 markdown-body 组件样式。
 */
import { createRoot } from 'react-dom/client';
import ErrorBoundary from './components/ErrorBoundary';
import App from './App';
import './styles/tailwind.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
}
