/**
 * Electron 主进程入口
 *
 * 职责：
 * - 创建应用窗口（BrowserWindow），设置标题和尺寸
 * - 通过 ipc-handlers 注册所有 IPC 通信通道
 * - 管理应用生命周期（单实例锁、窗口激活、退出清理）
 *
 * 架构约束：
 * - 主进程拥有所有系统权限：文件 I/O、Git 操作、AI API 调用
 * - Renderer 进程通过 IPC 间接使用这些能力，API Key 不会暴露到渲染进程
 * - 使用 contextBridge + preload 脚本实现安全的进程间通信
 */
import { app, BrowserWindow, shell, Menu } from 'electron';
import { join } from 'path';
import { is } from '@electron-toolkit/utils';
import { registerHandlers } from './ipc-handlers';

// 单实例锁 — 防止重复启动应用
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

/**
 * 创建主窗口
 *
 * 开发模式下加载 Vite 开发服务器 URL 并打开 DevTools；
 * 生产模式下加载打包后的 index.html。
 * contextIsolation: true 确保渲染进程无法直接访问 Node.js API。
 */
function createWindow(): void {
  try {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      title: '个人知识库 Agent',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    // 阻止窗口内打开新窗口，外部链接用系统默认浏览器打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    // 开发模式：加载 Vite 开发服务器并打开 DevTools
    if (is.dev && process.env.ELECTRON_RENDERER_URL) {
      mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
      mainWindow.webContents.openDevTools();
    } else {
      // 生产模式：加载 vite 构建后的静态文件
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  } catch (err) {
    console.error('Failed to create window:', err);
    app.quit();
  }
}

// 第二个实例启动时，聚焦已有窗口而非创建新窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  try {
    // 移除菜单栏（应用使用自定义 UI）
    Menu.setApplicationMenu(null);
    // 注册所有 IPC 通信通道（Main↔Renderer 桥梁）
    registerHandlers();
    createWindow();

    // macOS 特性：点击 Dock 图标时重新创建窗口
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (err) {
    console.error('Failed to start app:', err);
    app.quit();
  }
});

// 非 macOS 平台：所有窗口关闭时退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
