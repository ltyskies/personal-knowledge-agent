/**
 * 主题管理 Hook
 *
 * 支持三种主题模式：亮色、暗色、跟随系统。
 * 主题选择持久化到 localStorage，暗色模式通过 HTML 元素的 .dark class 控制。
 *
 * 系统主题变化时（prefers-color-scheme 媒体查询），若当前为跟随系统模式则自动更新。
 * toggle() 在三者之间循环切换：light → dark → system → light ...
 */
import { useState, useEffect, useCallback } from 'react';

type Theme = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'knowledge-agent-theme';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch { /* localStorage 不可用时的降级处理 */ }
  return 'system';
}

/** 将主题应用到 DOM：通过切换 .dark 类控制 Tailwind 暗色样式 */
function applyTheme(theme: Theme): void {
  const resolved = theme === 'system' ? getSystemTheme() : theme;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

interface UseThemeReturn {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

export function useTheme(): UseThemeReturn {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  const resolvedTheme = theme === 'system' ? getSystemTheme() : theme;

  // 主题变更时应用 + 监听系统主题变化
  useEffect(() => {
    applyTheme(theme);

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (theme === 'system') {
        applyTheme('system');
        // 强制 re-render 以更新 resolvedTheme 值
        setThemeState('system');
      }
    };
    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    try { localStorage.setItem(STORAGE_KEY, t); } catch { /* noop */ }
    setThemeState(t);
  }, []);

  // 在 light → dark → system 之间循环切换
  const toggle = useCallback(() => {
    const cycle: Theme[] = ['light', 'dark', 'system'];
    const idx = cycle.indexOf(theme);
    setTheme(cycle[(idx + 1) % cycle.length]);
  }, [theme, setTheme]);

  return { theme, resolvedTheme, setTheme, toggle };
}
