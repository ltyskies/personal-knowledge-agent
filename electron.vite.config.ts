/**
 * Electron-Vite 构建配置
 *
 * 三个构建目标：
 * - main:   主进程代码 → 编译为 CommonJS，输出到 out/main
 * - preload: preload 脚本 → 编译为 CommonJS，输出到 out/preload
 * - renderer: React 渲染进程 → Vite 打包，输出到 out/renderer
 *
 * Main/Preload 将 electron、simple-git 设为外部依赖（不打包，运行时从 node_modules 加载）。
 * Renderer 使用 @vitejs/plugin-react + @tailwindcss/vite 插件，
 * 并通过 @shared 别名引用共享类型。
 */
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        // 原生模块不打包，保持为外部依赖
        external: ['electron', 'simple-git'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
});
