
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
   */
  const tocNoiseRegex = /(\.{3,}\s*\d+|-\s*\d+\s*-|\s+\d+\s*$)/;
  
  // 填空项高亮正则
  const blankPattern = /_{2,}|\[\s*\]|（\s*）/g;

  const chapters: Chapter[] = [];
  let currentChapter: Chapter | null = null;

  // 遍历所有生成的 HTML 节点
  Array.from(body.children).forEach((child) => {
    const textContent = child.textContent?.trim() || '';
    
    // 跳过纯空行
    if (!textContent && child.tagName !== 'TABLE') return;

    // --- 步骤 1: 噪音过滤 ---
    // 如果该行看起来像目录项（带页码），则忽略
    if (textContent.length > 3 && tocNoiseRegex.test(textContent)) {
      // 排除掉刚好是章节标题但误触的情况（通常目录项很长且带点）
      if (textContent.includes('...') || textContent.includes('···')) return;
    }

    // --- 步骤 2: 章节标题判定 ---
    // 判定标准：匹配正则 且 (是标题标签 或 包含加粗标签)
    const hasVisualWeight = ['H1', 'H2', 'H3'].includes(child.tagName) || child.querySelector('strong, b');
    const isChapterHeading = chapterRegex.test(textContent) && hasVisualWeight;

    if (isChapterHeading) {
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

  return {
    name: file.name,
    chapters: chapters.filter(c => c.content.trim() !== '' || c.id !== 'intro'),
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
