
import * as mammoth from 'mammoth';
import { ParsedDocument, Chapter } from '../types';

/**
 * 针对中国招标文件的结构化解析逻辑
 * - 识别：Chapter X, 第X章, 第X节, 第X篇, 第X部分
 * - 过滤：目录（带页码的行）、页眉页脚噪音
 * - 转换：表格保留 HTML 结构
 * - 高亮：下划线和括号填空项
 */
export async function extractPerfectStructure(file: File): Promise<ParsedDocument> {
  const arrayBuffer = await file.arrayBuffer();
  
  // 转换配置：将常用标题样式映射为 H 标签，加粗映射为 strong
  const options = {
    styleMap: [
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
      "p[style-name='Title'] => h1:fresh",
      "b => strong",
      "i => em"
    ]
  };

  const result = await mammoth.convertToHtml({ arrayBuffer }, options);
  let html = result.value;

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;

  /**
   * 章节识别正则增强版：
   * 1. 支持：Chapter 1, 第1章, 第一章, 第一篇, 第一部分, 第一节
   * 2. 允许中间有空格
   */
  const chapterRegex = /^(Chapter\s*\d+|第\s*[一二三四五六七八九十百\d]+\s*[章节篇部])/i;
  
  /**
   * 目录/噪音识别：
   * 1. 结尾带有连续点号加数字（TOC 典型特征）
   * 2. 结尾带有页码标识如 "- 5 -" 或 "  5"
   * 3. 章节标题后直接跟页码数字
   */
  const tocNoiseRegex = /(\.{3,}\s*\d+|·{3,}\s*\d+|-\s*\d+\s*-|\s+\d+\s*$)/;
  
  /**
   * 目录项页码识别：章节标题 + 空格 + 纯数字页码
   * 例如："第一章 招标公告 2" 或 "第二章 投标人须知 5"
   */
  const tocPageNumberRegex = /^(第\s*[一二三四五六七八九十百\d]+\s*[章节篇部]).+\s+\d{1,3}\s*$/;
  
  // 填空项高亮正则
  const blankPattern = /_{2,}|\[\s*\]|（\s*）/g;

  const chapters: Chapter[] = [];
  let currentChapter: Chapter | null = null;
  
  // 用于去重的标题集合（标准化后的标题）
  const seenTitles = new Set<string>();
  
  // 标准化章节标题（去除页码、空格，用于去重比较）
  const normalizeTitle = (title: string): string => {
    return title
      .replace(/\s+\d{1,3}\s*$/, '')  // 去除末尾页码
      .replace(/\s+/g, '')             // 去除所有空格
      .toLowerCase();
  };

  // === 预处理：识别目录区域 ===
  // 目录特征：多个章节标题连续出现（之间没有实质内容）
  const children = Array.from(body.children);
  const tocIndices = new Set<number>(); // 存储目录区域的节点索引
  
  // 扫描连续的章节标题（目录检测）
  for (let i = 0; i < children.length; i++) {
    const text = children[i].textContent?.trim() || '';
    if (!chapterRegex.test(text)) continue;
    
    // 找到一个章节标题，检查后面是否紧跟着另一个章节标题
    let consecutiveCount = 1;
    let j = i + 1;
    
    // 向后查找，跳过空行和短行
    while (j < children.length) {
      const nextText = children[j].textContent?.trim() || '';
      const nextLength = nextText.length;
      
      // 跳过空行或很短的行（可能是空格、页码等）
      if (nextLength < 5) {
        j++;
        continue;
      }
      
      // 如果下一个是章节标题，计数+1
      if (chapterRegex.test(nextText)) {
        consecutiveCount++;
        j++;
      } else {
        // 遇到非章节标题的实质内容，停止
        break;
      }
    }
    
    // 如果连续 3 个以上章节标题紧挨着，认为是目录区域
    if (consecutiveCount >= 3) {
      // 标记这些索引为目录区域
      let k = i;
      let marked = 0;
      while (k < children.length && marked < consecutiveCount) {
        const kText = children[k].textContent?.trim() || '';
        if (chapterRegex.test(kText) || kText.length < 5) {
          tocIndices.add(k);
          if (chapterRegex.test(kText)) marked++;
        }
        k++;
      }
    }
  }

  // 遍历所有生成的 HTML 节点
  children.forEach((child, index) => {
    const textContent = child.textContent?.trim() || '';
    
    // 跳过纯空行
    if (!textContent && child.tagName !== 'TABLE') return;

    // --- 步骤 1: 噪音过滤 ---
    
    // 如果在目录区域（连续章节标题区），跳过
    if (tocIndices.has(index)) {
      return;
    }
    
    // 如果该行看起来像目录项（带页码），则忽略
    if (textContent.length > 3 && tocNoiseRegex.test(textContent)) {
      return; // 直接跳过所有目录项
    }
    
    // 如果是章节标题格式但末尾带页码，跳过（目录项）
    if (tocPageNumberRegex.test(textContent)) {
      return;
    }

    // --- 步骤 2: 章节标题判定 ---
    // 判定标准：匹配正则 且 (是标题标签 或 包含加粗标签)
    const hasVisualWeight = ['H1', 'H2', 'H3'].includes(child.tagName) || child.querySelector('strong, b');
    const isChapterHeading = chapterRegex.test(textContent) && hasVisualWeight;

    if (isChapterHeading) {
      const normalizedTitle = normalizeTitle(textContent);
      
      // 去重检查：如果已有同名章节，跳过
      if (seenTitles.has(normalizedTitle)) {
        return;
      }
      seenTitles.add(normalizedTitle);
      
      currentChapter = {
        id: `chapter-${chapters.length}`,
        title: textContent,
        content: ''
      };
      chapters.push(currentChapter);
    } else {
      // --- 步骤 3: 内容归档 ---
      if (!currentChapter) {
        // 在遇到第一个正式章节前的所有内容归入“前言”
        currentChapter = {
          id: 'intro',
          title: '文件封面/前言',
          content: ''
        };
        chapters.push(currentChapter);
      }

      // 处理内容中的填空项高亮
      let itemHtml = child.outerHTML;
      if (child.tagName === 'P' || child.tagName === 'SPAN' || child.tagName.startsWith('H')) {
        itemHtml = itemHtml.replace(blankPattern, (match) => `<span class="highlight-blank">${match}</span>`);
      }

      currentChapter.content += itemHtml;
    }
  });

  // 如果没有识别出任何章节（可能文档不规范），将整篇作为内容
  if (chapters.length === 1 && chapters[0].id === 'intro' && !chapters[0].content) {
      chapters[0].content = html;
  }

  // 最小内容长度阈值（HTML 字符数）
  // 正文章节至少应有 200 字符内容，避免把目录项误识别为章节
  const MIN_CONTENT_LENGTH = 200;
  
  // 过滤章节：
  // 1. 去除空内容
  // 2. 非前言章节必须有足够内容
  const filteredChapters = chapters.filter(c => {
    const contentLength = c.content.replace(/<[^>]*>/g, '').trim().length;
    
    // 前言章节保留（即使内容少）
    if (c.id === 'intro') {
      return contentLength > 0;
    }
    
    // 其他章节必须有足够内容
    return contentLength >= MIN_CONTENT_LENGTH;
  });

  return {
    name: file.name,
    chapters: filteredChapters,
    rawHtml: html
  };
}

export function downloadJson(data: any, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
