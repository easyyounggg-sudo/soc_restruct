
import * as mammoth from 'mammoth';
import { ParsedDocument, Chapter } from '../types';

/**
 * 统一的文档解析入口
 * 仅支持 .docx 格式
 */
export async function parseDocument(file: File): Promise<ParsedDocument> {
  const fileName = file.name.toLowerCase();
  
  if (fileName.endsWith('.docx')) {
    return extractPerfectStructure(file);
  } else if (fileName.endsWith('.doc')) {
    throw new Error('不支持旧版 .doc 格式，请将文件另存为 .docx');
  } else {
    throw new Error('不支持的文件格式，请上传 .docx 文件');
  }
}

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
   * 章节识别正则 - 支持多种类型
   */
  // 各类型的正则
  const chapterTypeRegexMap: Record<string, RegExp> = {
    '章': /^第\s*[一二三四五六七八九十百\d]+\s*章/,
    '部分': /^第\s*[一二三四五六七八九十百\d]+\s*部分/,
    '篇': /^第\s*[一二三四五六七八九十百\d]+\s*篇/,
  };
  
  // 排除的类型（分组/子级）
  const excludeTypeRegex = /^第\s*[一二三四五六七八九十百\d]+\s*(卷|节|条|款)/;
  
  // 默认使用"章"
  let activeChapterType = '章';
  let chapterRegex = chapterTypeRegexMap[activeChapterType];
  
  // 统计各类型在全文中的出现次数（遍历每个节点）
  const countChapterTypes = (): Record<string, number> => {
    const counts: Record<string, number> = { '章': 0, '部分': 0, '篇': 0 };
    
    // 遍历所有子节点，逐个检查
    for (const child of Array.from(body.children)) {
      const text = child.textContent?.trim() || '';
      if (!text) continue;
      
      for (const [type, regex] of Object.entries(chapterTypeRegexMap)) {
        if (regex.test(text)) {
          counts[type]++;
          break; // 一个节点只计一次
        }
      }
    }
    
    return counts;
  };
  
  /**
   * 目录/噪音识别：
   * 1. 结尾带有连续点号加数字（TOC 典型特征）
   * 2. 结尾带有页码标识如 "- 5 -" 或 "  5"
   * 3. 章节标题后直接跟页码数字
   */
  const tocNoiseRegex = /(\.{3,}\s*\d+|·{3,}\s*\d+|-\s*\d+\s*-|\s+\d+\s*$)/;
  
  // === 智能降级检测 ===
  // 先用默认"章"策略，如果结果 < 2，触发降级
  const detectAndSelectChapterType = async (): Promise<string> => {
    const counts = countChapterTypes();
    console.log('[DOCX Parser] 章节类型统计:', counts);
    
    // 默认"章"有 >= 2 个，直接使用
    if (counts['章'] >= 2) {
      return '章';
    }
    
    // 找出 >= 3 的类型
    const validTypes = Object.entries(counts)
      .filter(([_, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1]); // 按数量降序
    
    if (validTypes.length === 0) {
      // 没有足够的章节，使用默认
      console.log('[DOCX Parser] 未找到足够章节，使用默认"章"策略');
      return '章';
    }
    
    if (validTypes.length === 1) {
      // 只有一个类型满足条件
      console.log(`[DOCX Parser] 自动选择"${validTypes[0][0]}"作为主结构`);
      return validTypes[0][0];
    }
    
    // 检查是否有并列最多的
    const maxCount = validTypes[0][1];
    const topTypes = validTypes.filter(([_, count]) => count === maxCount);
    
    if (topTypes.length === 1) {
      console.log(`[DOCX Parser] 自动选择"${topTypes[0][0]}"作为主结构`);
      return topTypes[0][0];
    }
    
    // 多个并列，弹窗让用户选择
    const options = topTypes.map(([type, count]) => `第X${type}（出现 ${count} 次）`);
    const message = `检测到多种章节命名方式，请选择主结构：\n\n${options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}`;
    
    // 简单的 prompt 选择
    const choice = window.prompt(message + '\n\n请输入序号（1-' + topTypes.length + '）：', '1');
    const choiceIndex = parseInt(choice || '1') - 1;
    
    if (choiceIndex >= 0 && choiceIndex < topTypes.length) {
      console.log(`[DOCX Parser] 用户选择"${topTypes[choiceIndex][0]}"作为主结构`);
      return topTypes[choiceIndex][0];
    }
    
    return topTypes[0][0];
  };
  
  // 执行检测
  activeChapterType = await detectAndSelectChapterType();
  chapterRegex = chapterTypeRegexMap[activeChapterType];
  console.log(`[DOCX Parser] 使用"第X${activeChapterType}"作为主结构`);
  
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

  // === 预处理：识别目录区域并提取章节参考列表 ===
  // 目录特征：多个章节标题连续出现（之间没有实质内容）
  const children = Array.from(body.children);
  const tocIndices = new Set<number>(); // 存储目录区域的节点索引
  const tocChapterTitles: string[] = []; // 目录中的章节标题列表（作为参考）
  
  // 用于目录识别的宽泛正则（包含章/部分/篇，但跳过卷/节/条）
  const tocChapterRegex = /^第\s*[一二三四五六七八九十百\d]+\s*(章|部分|篇)/;
  
  // 提取章节编号的辅助函数
  const extractChapterNum = (text: string): string | null => {
    const match = text.match(/第\s*([一二三四五六七八九十百\d]+)\s*[章部篇]/);
    return match ? match[1] : null;
  };
  
  // 扫描连续的章节标题（目录检测）
  for (let i = 0; i < children.length; i++) {
    const text = children[i].textContent?.trim() || '';
    
    // 跳过"卷/节/条"等分组或子级标题
    if (excludeTypeRegex.test(text)) continue;
    
    // 只匹配章/部分/篇
    if (!tocChapterRegex.test(text)) continue;
    
    // 找到一个章节标题，检查后面是否紧跟着另一个章节标题
    let consecutiveCount = 1;
    let consecutiveTitles: Array<{index: number, text: string}> = [{index: i, text}];
    const seenChapterNums = new Set<string>(); // 记录已见的章节编号
    const firstNum = extractChapterNum(text);
    if (firstNum) seenChapterNums.add(firstNum);
    
    let j = i + 1;
    
    // 向后查找，跳过空行、短行和"卷"标题
    while (j < children.length) {
      const nextText = children[j].textContent?.trim() || '';
      const nextLength = nextText.length;
      
      // 跳过空行或很短的行（可能是空格、页码等）
      if (nextLength < 5) {
        j++;
        continue;
      }
      
      // 跳过"卷/节/条"等分组标题，但不打断连续性
      if (excludeTypeRegex.test(nextText)) {
        j++;
        continue;  // 跳过但继续查找
      }
      
      // 如果下一个是章节标题（章/部分/篇）
      if (tocChapterRegex.test(nextText)) {
        // 检查章节编号是否重复（重复说明正文开始了）
        const chapterNum = extractChapterNum(nextText);
        if (chapterNum && seenChapterNums.has(chapterNum)) {
          console.log(`[DOCX Parser] 目录检测：遇到重复章节编号"${chapterNum}"，停止（正文开始）`);
          break; // 重复编号，正文开始
        }
        if (chapterNum) seenChapterNums.add(chapterNum);
        
        consecutiveCount++;
        consecutiveTitles.push({index: j, text: nextText});
        j++;
      } else {
        // 遇到非章节标题的实质内容，停止
        break;
      }
    }
    
    // 如果连续 3 个以上章节标题紧挨着，认为是目录区域
    if (consecutiveCount >= 3) {
      // 标记这些索引为目录区域，并提取章节标题
      for (const item of consecutiveTitles) {
        tocIndices.add(item.index);
        // 清理目录项的页码部分，提取纯标题
        const cleanTitle = item.text
          .replace(/[\.·…]+\s*\d*\s*$/, '')  // 去除省略号+页码
          .replace(/\s+\d{1,3}\s*$/, '')      // 去除末尾页码
          .trim();
        if (cleanTitle && !tocChapterTitles.includes(cleanTitle)) {
          tocChapterTitles.push(cleanTitle);
        }
      }
      // 跳过已处理的区域
      i = j - 1;
    }
  }
  
  console.log('[DOCX Parser] 目录识别:', {
    目录章节数: tocChapterTitles.length,
    目录列表: tocChapterTitles,
    目录区域索引: Array.from(tocIndices).sort((a, b) => a - b)
  });

  // 遍历所有生成的 HTML 节点
  children.forEach((child, index) => {
    const textContent = child.textContent?.trim() || '';
    
    // 跳过纯空行
    if (!textContent && child.tagName !== 'TABLE') return;

    // --- 步骤 1: 噪音过滤 ---
    
    // 检查是否匹配章节正则（用于调试）
    const potentialChapter = chapterRegex.test(textContent);
    
    // 辅助函数：确保前言章节存在并添加内容
    const addToIntro = (html: string) => {
      if (!currentChapter) {
        currentChapter = {
          id: 'intro',
          title: '文件封面/前言',
          content: ''
        };
        chapters.push(currentChapter);
      }
      // 只有在前言章节时添加内容（避免往正文章节添加目录内容）
      if (currentChapter.id === 'intro') {
        currentChapter.content += html;
      }
    };
    
    // 如果在目录区域（连续章节标题区），归入前言而不是跳过
    if (tocIndices.has(index)) {
      if (potentialChapter) {
        console.log(`[DOCX Parser] 目录区域章节归入前言: "${textContent.substring(0, 30)}", index=${index}`);
      }
      addToIntro(child.outerHTML);
      return; // 不作为新章节识别
    }
    
    // 如果该行看起来像目录项（带页码），归入前言
    if (textContent.length > 3 && tocNoiseRegex.test(textContent)) {
      if (potentialChapter) {
        console.log(`[DOCX Parser] 带页码目录项归入前言: "${textContent.substring(0, 30)}", index=${index}`);
      }
      addToIntro(child.outerHTML);
      return;
    }
    
    // 如果是章节标题格式但末尾带页码，归入前言
    if (tocPageNumberRegex.test(textContent)) {
      if (potentialChapter) {
        console.log(`[DOCX Parser] 页码格式标题归入前言: "${textContent.substring(0, 30)}", index=${index}`);
      }
      addToIntro(child.outerHTML);
      return;
    }

    // --- 步骤 2: 章节标题判定 ---
    // 判定标准：匹配正则 且 (是标题标签 或 包含加粗标签 或 短标题)
    const matchesRegex = chapterRegex.test(textContent);
    const hasVisualWeight = ['H1', 'H2', 'H3'].includes(child.tagName) || child.querySelector('strong, b');
    const isShortTitle = textContent.length < 50; // 短标题不要求样式
    const isChapterHeading = matchesRegex && (hasVisualWeight || isShortTitle);
    
    // 调试：显示匹配到章节正则但未被识别的情况
    if (matchesRegex && !isChapterHeading) {
      console.log(`[DOCX Parser] 匹配正则但未识别为章节: "${textContent.substring(0, 50)}", 长度=${textContent.length}, 标签=${child.tagName}`);
    }

    if (isChapterHeading) {
      const normalizedTitle = normalizeTitle(textContent);
      
      // 去重检查：如果已有同名章节，跳过
      if (seenTitles.has(normalizedTitle)) {
        console.log(`[DOCX Parser] 跳过重复章节: "${textContent.substring(0, 30)}"`);
        return;
      }
      seenTitles.add(normalizedTitle);
      console.log(`[DOCX Parser] ✅ 识别到章节: "${textContent.substring(0, 30)}", index=${index}`);
      
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
  const contentFilteredChapters = chapters.filter(c => {
    const contentLength = c.content.replace(/<[^>]*>/g, '').trim().length;
    
    // 前言章节保留（即使内容少）
    if (c.id === 'intro') {
      return contentLength > 0;
    }
    
    // 其他章节必须有足够内容
    return contentLength >= MIN_CONTENT_LENGTH;
  });

  // === 章节连续性检查 ===
  // 中文数字映射
  const CHINESE_NUM_MAP: Record<string, number> = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
    '十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15,
    '十六': 16, '十七': 17, '十八': 18, '十九': 19, '二十': 20
  };

  // 提取章节编号
  const getChapterNumber = (title: string): number | null => {
    const match = title.match(/第\s*([一二三四五六七八九十]+|\d+)\s*[章节篇部]/);
    if (!match) return null;
    
    const numStr = match[1];
    if (/^\d+$/.test(numStr)) {
      return parseInt(numStr);
    }
    return CHINESE_NUM_MAP[numStr] || null;
  };

  // 分离前言和正式章节
  const introChapter = contentFilteredChapters.find(c => c.id === 'intro');
  const numberedChapters = contentFilteredChapters.filter(c => c.id !== 'intro');

  // 为每个章节添加编号
  const chaptersWithNum = numberedChapters
    .map(c => ({ chapter: c, num: getChapterNumber(c.title) }))
    .filter(item => item.num !== null) as Array<{ chapter: Chapter; num: number }>;

  // 按章节号排序
  chaptersWithNum.sort((a, b) => a.num - b.num);

  // 检查连续性：必须从第一章开始
  const continuousChapters: Chapter[] = [];
  let expectedNum = 1;

  for (const { chapter, num } of chaptersWithNum) {
    // 必须从第一章开始
    if (continuousChapters.length === 0 && num !== 1) {
      continue; // 跳过，直到找到第一章
    }
    
    // 允许小范围跳跃（最多跳2章）
    if (expectedNum <= num && num <= expectedNum + 2) {
      continuousChapters.push(chapter);
      expectedNum = num + 1;
    }
  }

  // === 目录辅助验证 ===
  // 如果从目录中识别到了章节列表，用它来验证和排序
  let finalChapters: Chapter[] = [];
  
  // 标准化标题用于匹配
  const normalizeTitleForMatch = (title: string): string => {
    return title.replace(/\s+/g, '').replace(/第([一二三四五六七八九十\d]+)[章节篇部分]/, '第$1章');
  };
  
  // 选择匹配来源：优先用连续性检查结果，如果为空则用所有有编号章节
  const sourceChapters = continuousChapters.length > 0 
    ? continuousChapters 
    : chaptersWithNum.map(item => item.chapter);
  
  console.log('[DOCX Parser] 匹配源:', {
    连续性检查章节数: continuousChapters.length,
    有编号章节数: chaptersWithNum.length,
    使用: continuousChapters.length > 0 ? '连续性检查结果' : '所有有编号章节'
  });
  
  if (tocChapterTitles.length >= 3) {
    // 有目录参考，按目录顺序匹配
    console.log('[DOCX Parser] 使用目录辅助验证...');
    
    for (const tocTitle of tocChapterTitles) {
      const normalizedToc = normalizeTitleForMatch(tocTitle);
      
      // 在源章节中查找匹配的章节
      const matchedChapter = sourceChapters.find(c => {
        const normalizedChapter = normalizeTitleForMatch(c.title);
        return normalizedChapter === normalizedToc || 
               normalizedChapter.includes(normalizedToc) || 
               normalizedToc.includes(normalizedChapter);
      });
      
      if (matchedChapter && !finalChapters.includes(matchedChapter)) {
        finalChapters.push(matchedChapter);
      } else if (!matchedChapter) {
        console.log(`[DOCX Parser] ⚠️ 目录章节未找到匹配: "${tocTitle}"`);
      }
    }
    
    // 如果目录匹配的章节太少，回退到源章节
    if (finalChapters.length < sourceChapters.length * 0.5) {
      console.log('[DOCX Parser] 目录匹配不足，使用源章节');
      finalChapters = sourceChapters;
    }
  } else {
    // 没有目录参考，使用源章节
    finalChapters = sourceChapters;
  }

  console.log('[DOCX Parser] 最终章节:', {
    目录章节数: tocChapterTitles.length,
    连续性检查章节数: continuousChapters.length,
    最终章节数: finalChapters.length,
    章节列表: finalChapters.map(c => c.title)
  });
  
  // 组合最终结果：前言 + 验证后的章节
  const filteredChapters: Chapter[] = [];
  if (introChapter) {
    filteredChapters.push(introChapter);
  }
  filteredChapters.push(...finalChapters);

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
