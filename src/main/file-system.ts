/**
 * Markdown 文件系统
 *
 * 知识库存储的核心模块。提供以下能力：
 * 1. Markdown 文件结构解析（parseMarkdownFile）— 将 .md 文件解析为结构化的段落树
 * 2. 文件读写（read/write）— 主进程独占的文件 I/O
 * 3. 章节内容读写（readChapterContent/writeChapterContent）— 按章节 ID 定位并更新
 * 4. 索引构建辅助（buildFileEntry/buildSectionId）— 供 index-builder 使用
 *
 * Markdown 结构约定：
 * - `# 标题`   = 文件名（一级标题，唯一）
 * - `## 标题`  = 子领域（二级标题）
 * - `### 标题` = 知识点（三级标题，匹配和更新的最小粒度）
 *
 * 章节 ID 生成规则：{文件名slug}-{h2slug}-{h3slug}
 * 例如：rust-lang-suo-you-quan-xi-tong-yi-dong-yu-yi
 */
import { readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'fs';
import { join, extname, basename } from 'path';
import type { SectionEntry, FileEntry } from '../shared/types';

/**
 * 将文本转换为 URL 友好的 slug
 * 支持中文字符（Unicode CJK 范围：一-鿿）
 */
export function slugify(text: string): string {
  return text
    .replace(/^#+\s*/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface ParsedSection {
  level: 2 | 3;
  heading: string;
  content: string;
  children: ParsedSection[];
}

interface ParseResult {
  title: string;
  intro: string;
  sections: ParsedSection[];
}

/**
 * 解析 Markdown 文件为结构化数据
 *
 * 解析策略：
 * - 第一个 `# 标题` 作为文件标题
 * - `## 标题` 作为二级章节，其内容包含在下一个同级或更高级标题之前的所有内容
 * - `### 标题` 作为三级章节（知识点），嵌套在最近的二级章节下
 * - 标题之前的内容为导语（intro），三级标题之前的内容归入所属二级标题的正文
 *
 * 状态机：pastTitle / inH2 / currentH2 / currentH3
 */
export function parseMarkdownFile(content: string): ParseResult {
  const lines = content.split('\n');
  let title = '';
  let intro = '';
  const sections: ParsedSection[] = [];
  let currentH2: ParsedSection | null = null;
  let currentH3: ParsedSection | null = null;
  let contentBuffer: string[] = [];
  let pastTitle = false;
  let inH2 = false;

  function flushBuffer(): string {
    const text = contentBuffer.join('\n').trim();
    contentBuffer = [];
    return text;
  }

  for (const line of lines) {
    // 第一个 # 标题视为文件标题，忽略后续出现的 # 标题
    if (line.startsWith('# ') && !pastTitle) {
      title = line.replace(/^#\s*/, '').trim();
      pastTitle = true;
      continue;
    }

    if (line.startsWith('## ')) {
      const h2Content = flushBuffer();
      if (currentH3) {
        currentH3.content = h2Content;
        currentH3 = null;
      } else if (currentH2) {
        if (!inH2) {
          currentH2.content = h2Content;
        }
      } else if (!inH2 && !currentH2) {
        intro = h2Content;
      }

      if (currentH2) {
        sections.push(currentH2);
      }

      const heading = line.replace(/^##\s*/, '').trim();
      currentH2 = {
        level: 2,
        heading: `## ${heading}`,
        content: '',
        children: [],
      };
      currentH3 = null;
      inH2 = true;
      continue;
    }

    if (line.startsWith('### ')) {
      const h3Content = flushBuffer();
      if (currentH3) {
        currentH3.content = h3Content;
      } else if (currentH2 && inH2 && !currentH2.content) {
        // 这是紧跟在 H2 标题后的第一个 H3，将之前的缓冲归入 H2 正文
        currentH2.content = h3Content;
        inH2 = false;
      } else if (currentH2) {
        currentH3!.content = h3Content;
      }

      const heading = line.replace(/^###\s*/, '').trim();
      currentH3 = {
        level: 3,
        heading: `### ${heading}`,
        content: '',
        children: [],
      };

      if (currentH2) {
        currentH2.children.push(currentH3);
        inH2 = false;
      }
      continue;
    }

    if (pastTitle) {
      contentBuffer.push(line);
    }
  }

  // 处理文件末尾的剩余内容
  const remaining = flushBuffer();
  if (currentH3) {
    currentH3.content = remaining;
  } else if (currentH2 && !currentH2.content) {
    currentH2.content = remaining;
  }

  if (currentH2) {
    sections.push(currentH2);
  }

  if (!pastTitle) {
    intro = lines.join('\n').trim();
    title = basename(process.cwd());
  }

  return { title, intro, sections };
}

export function readMarkdownFile(kbPath: string, relativePath: string): string {
  const fullPath = join(kbPath, relativePath);
  return readFileSync(fullPath, 'utf-8');
}

export function writeMarkdownFile(kbPath: string, relativePath: string, content: string): void {
  const fullPath = join(kbPath, relativePath);
  writeFileSync(fullPath, content, 'utf-8');
}

/**
 * 将解析后的 Markdown 结构序列化回文本
 *
 * 输出格式：
 * # 标题
 *
 * 导语
 *
 * ## H2标题
 * H2正文
 *
 * ### H3标题
 * H3正文
 */
export function serializeMarkdownFile(result: ParseResult): string {
  const lines: string[] = [];
  lines.push(`# ${result.title}`);

  if (result.intro) {
    lines.push('');
    lines.push(result.intro);
  }

  for (const h2 of result.sections) {
    lines.push('');
    lines.push(h2.heading);
    if (h2.content) {
      lines.push('');
      lines.push(h2.content.trimEnd());
    }
    for (const h3 of h2.children) {
      lines.push('');
      lines.push(h3.heading);
      if (h3.content) {
        lines.push('');
        lines.push(h3.content.trimEnd());
      }
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * 将知识点内容写入知识库文件
 *
 * 处理三种情况：
 * 1. 新文件：创建文件，写入 domain 标题 + subdomain 二级标题 + 知识点三级标题和内容
 * 2. 已有章节更新：定位到已有章节并替换其内容
 * 3. 新章节追加：在已有文件中追加新的 H2 或 H3 章节
 */
export function writeChapterContent(
  kbPath: string,
  filePath: string,
  chapterId: string,
  newContent: string,
  heading: string,
  domain: string,
  subdomain: string,
  isNewFile: boolean,
  isNewChapter: boolean,
): void {
  const fullPath = join(kbPath, filePath);

  if (isNewFile) {
    const content = `# ${domain}\n\n## ${subdomain}\n\n${heading}\n${newContent}\n`;
    writeFileSync(fullPath, content, 'utf-8');
    return;
  }

  const existingContent = readFileSync(fullPath, 'utf-8');
  const parsed = parseMarkdownFile(existingContent);
  const baseName = basename(filePath, '.md');

  // 尝试按 chapterId 查找并更新已有章节
  let found = false;
  for (const h2 of parsed.sections) {
    const h2Id = buildSectionId(baseName, h2.heading);
    if (h2Id === chapterId) {
      h2.content = newContent;
      found = true;
      break;
    }
    for (const h3 of h2.children) {
      const h3Id = buildSectionId(baseName, h3.heading, h2.heading);
      if (h3Id === chapterId) {
        h3.content = newContent;
        found = true;
        break;
      }
    }
    if (found) break;
  }

  if (!found && isNewChapter) {
    const headingLevel = heading.startsWith('###') ? 3 : 2;
    const newSection: ParsedSection = {
      level: headingLevel as 2 | 3,
      heading,
      content: newContent,
      children: [],
    };

    if (headingLevel === 2) {
      parsed.sections.push(newSection);
    } else {
      // 查找匹配的 H2 父章节，或创建新的 H2 + H3
      const targetH2 = parsed.sections.find(
        (s) => s.heading.replace(/^##\s*/, '') === subdomain,
      );
      if (targetH2) {
        targetH2.children.push(newSection);
      } else {
        parsed.sections.push({
          level: 2,
          heading: `## ${subdomain}`,
          content: '',
          children: [newSection],
        });
      }
    }
  }

  const serialized = serializeMarkdownFile(parsed);
  writeFileSync(fullPath, serialized, 'utf-8');
}

/**
 * 按章节 ID 读取具体章节的内容
 *
 * 遍历文件的所有 H2 和 H3 章节，通过 ID 匹配定位目标章节。
 * 返回章节的正文内容（不含标题）。
 */
export function readChapterContent(kbPath: string, filePath: string, chapterId: string): string | null {
  const content = readMarkdownFile(kbPath, filePath);
  const parsed = parseMarkdownFile(content);

  for (const h2 of parsed.sections) {
    const h2Id = buildSectionId(basename(filePath, '.md'), h2.heading);
    if (h2Id === chapterId) {
      return h2.content;
    }
    for (const h3 of h2.children) {
      const h3Id = buildSectionId(basename(filePath, '.md'), h3.heading, h2.heading);
      if (h3Id === chapterId) {
        return h3.content;
      }
    }
  }
  return null;
}

export function getFileMtime(filePath: string): string {
  return statSync(filePath).mtime.toISOString();
}

export function listMarkdownFiles(kbPath: string): string[] {
  if (!existsSync(kbPath)) return [];
  return readdirSync(kbPath)
    .filter((f) => extname(f) === '.md')
    .sort();
}

/**
 * 构建章节唯一 ID
 *
 * 规则：
 * - H2: {文件名slug}-{h2标题slug}
 * - H3: {文件名slug}-{h2标题slug}-{h3标题slug}
 *
 * 例如：rust-lang-suo-you-quan-xi-tong
 */
export function buildSectionId(fileSlug: string, heading: string, parentHeading?: string): string {
  const base = slugify(fileSlug);
  if (parentHeading) {
    const parentSlug = slugify(parentHeading);
    const childSlug = slugify(heading);
    return `${base}-${parentSlug}-${childSlug}`;
  }
  const headingSlug = slugify(heading);
  return `${base}-${headingSlug}`;
}

/**
 * 构建单个文件的索引条目（FileEntry）
 *
 * 包含文件的元数据、标题、修改时间，以及所有章节的摘要信息。
 * 章节摘要取内容前 100 字符，用于 AI 匹配提示。
 */
export function buildFileEntry(kbPath: string, fileName: string): FileEntry {
  const fullPath = join(kbPath, fileName);
  const content = readFileSync(fullPath, 'utf-8');
  const parsed = parseMarkdownFile(content);
  const mtime = getFileMtime(fullPath);
  const baseName = basename(fileName, '.md');

  function toSectionEntry(section: ParsedSection): SectionEntry {
    const id = buildSectionId(baseName, section.heading);
    return {
      id,
      heading: section.heading,
      level: section.level,
      // 章节摘要：取内容前 100 字符，去除换行符
      summary: section.content.slice(0, 100).replace(/\n/g, ' '),
      children: section.children.map((child) => {
        const childId = buildSectionId(baseName, child.heading, section.heading);
        return {
          id: childId,
          heading: child.heading,
          level: child.level,
          summary: child.content.slice(0, 100).replace(/\n/g, ' '),
          children: [],
        };
      }),
    };
  }

  return {
    path: fileName,
    title: parsed.title,
    mtime,
    summary: parsed.intro.slice(0, 100).replace(/\n/g, ' ') || parsed.title,
    sections: parsed.sections.map(toSectionEntry),
  };
}

/**
 * 全局搜索章节 — 遍历所有文件，按 ID 查找章节内容
 *
 * 用于合并流程中查找已有章节内容。
 */
export function resolveChapter(kbPath: string, chapterId: string): { filePath: string; content: string } | null {
  const files = listMarkdownFiles(kbPath);
  for (const file of files) {
    const content = readChapterContent(kbPath, file, chapterId);
    if (content !== null) {
      return { filePath: file, content };
    }
  }
  return null;
}
