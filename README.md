# 个人知识库 Agent

> 与 AI 对话，知识自动沉淀到本地 Markdown 知识库，支持 Git 版本管理。

## 核心功能

- **智能对话**：接入 OpenAI 兼容 API（DeepSeek / OpenAI ），流式实时回复
- **自动提取**：AI 从对话中提取值得记录的知识点（最多 3 条）
- **智能匹配**：自动将知识点匹配到现有知识库中最合适的章节，避免重复
- **增量合并**：AI 合并新旧内容，已有内容逐字保留，仅追加增量信息
- **可视化确认**：左右分栏对比，用户可手动编辑合并结果后确认写入
- **Git 自动提交**：每次写入后自动 commit，commit message 由 AI 生成（中文 conventional commits 格式）
- **知识库浏览**：树形章节导航，Markdown 渲染阅读
- **暗色模式**：支持亮色 / 暗色 / 跟随系统三种主题

## 工作流程

```
用户与 AI 对话
  → 点击「提取知识点」
    → AI 从对话中提取知识点（domain / subdomain / title / content）
      → AI 匹配到知识库中最合适的已有章节
        → AI 将新旧内容合并（已有内容原样保留，仅追加增量）
          → 用户确认后写入 Markdown 文件
            → 自动 git commit
```

## 技术架构

```
┌─────────────────────────────────────────┐
│              Electron Main              │
│  ┌─────────┐ ┌──────────┐ ┌─────────┐  │
│  │ AI API  │ │ File I/O │ │   Git   │  │
│  │ Client  │ │  System  │ │   Ops   │  │
│  └─────────┘ └──────────┘ └─────────┘  │
│         ↕ IPC (contextBridge)           │
├─────────────────────────────────────────┤
│           Electron Renderer             │
│  ┌──────────────────────────────────┐   │
│  │        React Application         │   │
│  │  ┌────────┐ ┌──────┐ ┌───────┐  │   │
│  │  │ChatView│ │Reader│ │Config │  │   │
│  │  │        │ │View  │ │Modal  │  │   │
│  │  └────────┘ └──────┘ └───────┘  │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

- **Main 进程**：拥有所有系统权限（文件 I/O、Git 操作、AI API 调用），API Key 仅在此层使用
- **Renderer 进程**：React UI，通过 preload 脚本的 `contextBridge` 与 Main 进程通信
- **安全隔离**：`nodeIntegration: false` + `contextIsolation: true`，Render 进程无法直接访问 Node.js 或文件系统

## 目录结构

```
src/
├── main/                    # Electron 主进程
│   ├── index.ts             # 应用入口，窗口创建，生命周期管理
│   ├── ipc-handlers.ts      # IPC 通信处理器（总枢纽）
│   ├── ai-client.ts         # AI API 客户端（同步 + 流式）
│   ├── chapter-matcher.ts   # 知识库章节 AI 匹配器
│   ├── config.ts            # 应用配置读写
│   ├── conversation-store.ts # 对话持久化存储
│   ├── file-system.ts       # Markdown 文件解析与读写
│   ├── git-ops.ts           # Git 操作封装
│   ├── index-builder.ts     # 知识库索引构建器
│   └── knowledge-merger.ts  # 知识合并引擎
├── preload/
│   └── index.ts             # contextBridge 安全通信桥梁
├── renderer/                # React 渲染进程
│   ├── index.tsx            # React 入口
│   ├── index.html           # HTML 模板
│   ├── App.tsx              # 根组件
│   ├── types.ts             # 全局类型声明
│   ├── components/
│   │   ├── Sidebar.tsx      # 侧边栏（导航 + 对话历史 + 知识库树）
│   │   ├── ChatView.tsx     # 对话视图
│   │   ├── InputArea.tsx    # 输入区域
│   │   ├── KnowledgeTree.tsx # 知识库章节树
│   │   ├── ReaderView.tsx   # 章节阅读视图
│   │   ├── DiffView.tsx     # Diff 合并确认视图
│   │   ├── ConfigModal.tsx  # API 设置弹窗
│   │   ├── SetupWizard.tsx  # 首次启动引导向导
│   │   └── ErrorBoundary.tsx # 错误边界
│   ├── hooks/
│   │   ├── useChat.ts       # 对话状态管理 Hook
│   │   └── useTheme.ts      # 主题管理 Hook
│   └── styles/
│       └── tailwind.css     # Tailwind CSS + Markdown 样式
└── shared/
    └── types.ts             # Main/Renderer 共享类型定义
```

## 快速开始

### 环境要求

- **Node.js** >= 18
- **pnpm** >= 8

### 安装

```bash
# 克隆仓库
git clone <repo-url>
cd personal-knowledge-agent

# 安装依赖
pnpm install
```

### 开发

```bash
pnpm dev
```

启动后：
1. 首次运行会弹出配置向导，填写 API 信息（Base URL + API Key + Model）
2. 选择知识库目录（一个 git 仓库，存放 Markdown 文件）
3. 配置完成即可开始对话

### 构建

```bash
pnpm build      # 构建所有目标
pnpm pack       # 打包为可安装文件（electron-builder）
```

### 构建产物

```
release/
└── 个人知识库 Agent-0.1.0-win-x64.exe   # Windows 安装包
```

## 知识库结构约定

知识库以 Markdown 文件组织，约定如下：

- 一个 `.md` 文件 = 一个知识领域（如 `Rust.md`、`计算机网络.md`）
- `# 标题` = 领域名称（一级标题，与文件名对应）
- `## 标题` = 子领域（二级标题，如 `## 所有权系统`）
- `### 标题` = 知识点（三级标题，匹配和更新的最小粒度，如 `### 移动语义`）

示例 `Rust.md`：

```markdown
# Rust

Rust 是一门系统编程语言...

## 所有权系统

Rust 的所有权系统是...

### 移动语义

默认情况下，变量赋值会转移所有权，称为移动...

### 借用与引用

通过引用可以在不转移所有权的情况下访问值...
```

`index.json` 由系统自动维护，无需手动编辑。

## 配置

配置文件存储在 `~/.knowledge-agent/config.json`：

```json
{
  "kbPath": "~/knowledge-base",
  "api": {
    "baseURL": "https://api.deepseek.com/v1",
    "key": "sk-...",
    "model": "deepseek-chat"
  },
  "relevance": {
    "maxChapters": 5,
    "maxSummaryLength": 100
  },
  "git": {
    "autoCommit": true,
    "authorName": "Knowledge Agent",
    "authorEmail": "agent@local"
  }
}
```

支持任何 OpenAI 兼容 API，包括：
- [DeepSeek](https://platform.deepseek.com/)
- [OpenAI](https://platform.openai.com/)
- [Ollama](https://ollama.com/)（本地运行，`baseURL: http://localhost:11434/v1`）

## IPC 通信规范

- 通道名格式：`namespace:action`（如 `kb:getTree`、`chat:stream`）
- 请求-响应：Main 用 `ipcMain.handle`，Renderer 用 `ipcRenderer.invoke`
- 流式推送：Main 用 `sender.send`，通道名加 `-stream` 后缀（如 `chat:stream-chunk`）
- 所有通道在 `src/main/ipc-handlers.ts` 统一注册

## 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | Electron |
| 前端 | React 19 + TypeScript 5 |
| 样式 | Tailwind CSS 4 |
| Markdown | react-markdown + remark-gfm |
| Diff | jsdiff |
| Git | simple-git |
| AI 调用 | OpenAI-compatible Chat API (fetch + SSE) |
| 构建 | electron-vite + electron-builder |
| 包管理 | pnpm |

## License

MIT
