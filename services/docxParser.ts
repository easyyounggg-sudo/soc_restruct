
import * as mammoth from 'mammoth';
import { ParsedDocument, Chapter } from '../types';

/**
 * Strips noise and structure document into chapters.
 * - Filters TOC lines (ending in dots + numbers)
 * - Identifies chapters based on regex (Chapter X or 第X章)
 * - Preserves tables as HTML
 * - Highlights fill-in-the-blanks
 */
export async function extractPerfectStructure(file: File): Promise<ParsedDocument> {
  const arrayBuffer = await file.arrayBuffer();
  
  // Convert DOCX to HTML using mammoth
  // We use custom styling maps to ensure we catch bold text which often denotes headers in Word
  const options = {
    styleMap: [
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
      "b => strong"
    ]
  };

  const result = await mammoth.convertToHtml({ arrayBuffer }, options);
  let html = result.value;

  // Create a temporary DOM to parse the HTML structure
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const body = doc.body;

  // Regex patterns
  const chapterRegex = /(^Chapter\s+\d+|^第[一二三四五六七八九十百]+[章节])/i;
  const tocNoiseRegex = /(\.{3,}\s*\d+|\s*\d+\s*$)/; // Simple TOC line detection
  const blankPattern = /_{2,}|\[\s*\]/g;

  const chapters: Chapter[] = [];
  let currentChapter: Chapter | null = null;

  // Iterate through children and group by chapters
  Array.from(body.children).forEach((child, index) => {
    const textContent = child.textContent?.trim() || '';
    
    // 1. Noise filtering: Skip empty lines or TOC-like lines
    if (!textContent && child.tagName !== 'TABLE') return;
    if (textContent.length > 5 && tocNoiseRegex.test(textContent) && textContent.includes('..')) return;

    // 2. Chapter detection (Matches Chapter X or 第X章/第X节)
    // We assume a chapter is either an H1-H3 tag or starts with the keyword
    const isChapterHeading = chapterRegex.test(textContent) || 
                             (['H1', 'H2'].includes(child.tagName) && chapterRegex.test(textContent));

    if (isChapterHeading) {
      currentChapter = {
        id: `chapter-${chapters.length}`,
        title: textContent,
        content: ''
      };
      chapters.push(currentChapter);
    } else {
      // If no chapter has been found yet, create a "Front Matter" section
      if (!currentChapter) {
        currentChapter = {
          id: 'intro',
          title: '前言/导引',
          content: ''
        };
        chapters.push(currentChapter);
      }

      // Process content: Highlight blanks
      let itemHtml = child.outerHTML;
      if (child.tagName === 'P' || child.tagName === 'SPAN' || child.tagName.startsWith('H')) {
        itemHtml = itemHtml.replace(blankPattern, (match) => `<span class="highlight-blank">${match}</span>`);
      }

      currentChapter.content += itemHtml;
    }
  });

  return {
    name: file.name,
    chapters,
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
