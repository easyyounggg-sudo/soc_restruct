"""
PDF 文档解析后端服务
使用 PyMuPDF 提取 PDF 结构化内容
"""

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict
import fitz  # PyMuPDF
import pdfplumber
import re
import io

app = FastAPI(title="PDF Parser API", version="1.0.0")

# CORS 配置 - 允许前端访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境应限制具体域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==================== 数据模型 ====================

class Chapter(BaseModel):
    id: str
    title: str
    content: str


class ParsedDocument(BaseModel):
    name: str
    chapters: List[Chapter]
    rawHtml: str


# ==================== 章节识别逻辑 ====================

# 中文数字映射
CHINESE_NUM_MAP = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
    '十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15,
    '十六': 16, '十七': 17, '十八': 18, '十九': 19, '二十': 20
}

# 目录行正则（带页码或省略号）
TOC_LINE_REGEX = re.compile(
    r'(第\s*[一二三四五六七八九十\d]+\s*[章节篇部].{2,50}[\.·…]{2,}\s*\d+|'  # 章节标题+省略号+页码
    r'[（\(][一二三四五六七八九十\d]+[）\)].{2,30}[\.·…]{2,}\s*\d+|'  # (一) 标题...页码
    r'.{2,30}[\.·…]{3,}\s*\d{1,3}\s*$)'  # 任意内容...页码
)

# 页眉页脚页码过滤规则
def is_header_footer_or_page_number(line: str) -> bool:
    """检查是否是页眉、页脚或页码"""
    line = line.strip()
    
    if not line:
        return False
    
    # 1. 纯数字页码（如 "1", "12", "123"）
    if re.match(r'^\d{1,3}$', line):
        return True
    
    # 2. 带格式的页码（如 "- 1 -", "— 12 —", "第 1 页", "Page 1"）
    if re.match(r'^[-—]\s*\d{1,3}\s*[-—]$', line):
        return True
    if re.match(r'^第\s*\d{1,3}\s*页', line):
        return True
    if re.match(r'^[Pp]age\s*\d{1,3}', line):
        return True
    if re.match(r'^\d{1,3}\s*/\s*\d{1,3}$', line):  # 1/10 格式
        return True
    
    # 3. 常见页眉关键词（短行且包含特定词）
    if len(line) < 30:
        # 招标文件常见页眉
        if re.match(r'^(招标文件|投标文件|采购文件|竞争性|磋商文件|询价文件)', line):
            return True
        # 机构名称作为页眉（通常很短）
        if re.match(r'^[\u4e00-\u9fa5]{2,10}(公司|机构|中心|学院|大学|医院|集团)$', line):
            return True
    
    # 4. 只有标点符号
    if re.match(r'^[—\-_=\.·…\s]+$', line):
        return True
    
    # 5. 非常短的行（可能是页眉页脚碎片）
    if len(line) <= 2 and not re.match(r'^[\u4e00-\u9fa5]', line):
        return True
    
    return False


def extract_tables_and_text_from_pdf(pdf_bytes: bytes) -> tuple:
    """
    使用 pdfplumber 提取 PDF 中的表格和过滤后的文本
    
    返回: (page_tables, page_texts_without_tables)
        - page_tables: {页码: [表格HTML列表]}
        - page_texts_without_tables: {页码: 过滤掉表格和页眉页脚后的文本}
    """
    page_tables: Dict[int, List[str]] = {}
    page_texts_clean: Dict[int, str] = {}
    
    # 页眉页脚区域（相对于页面高度的比例）
    HEADER_RATIO = 0.08  # 顶部 8% 为页眉区域
    FOOTER_RATIO = 0.08  # 底部 8% 为页脚区域
    
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page_num, page in enumerate(pdf.pages):
                page_height = page.height
                header_threshold = page_height * HEADER_RATIO
                footer_threshold = page_height * (1 - FOOTER_RATIO)
                
                # 提取表格 - 尝试多种策略，选择最佳结果
                table_bboxes = []
                best_tables = []
                best_col_count = 0
                
                # 策略1: lines（使用线条边界）
                strategies = [
                    {"vertical_strategy": "lines", "horizontal_strategy": "lines"},
                    {"vertical_strategy": "lines", "horizontal_strategy": "text"},
                    {"vertical_strategy": "text", "horizontal_strategy": "text"},
                    {"vertical_strategy": "text", "horizontal_strategy": "lines"},
                ]
                
                for strategy in strategies:
                    try:
                        test_tables = page.extract_tables(strategy)
                        if test_tables:
                            # 计算总列数
                            total_cols = sum(
                                max(len(row) for row in table if row) if table else 0
                                for table in test_tables
                            )
                            # 选择列数最多的策略（通常意味着更好的表格识别）
                            if total_cols > best_col_count:
                                best_col_count = total_cols
                                best_tables = test_tables
                    except Exception as e:
                        continue
                
                tables = best_tables
                
                if tables:
                    page_tables[page_num] = []
                    # 获取表格边界框（使用默认设置）
                    try:
                        for table_obj in page.find_tables():
                            table_bboxes.append(table_obj.bbox)
                    except:
                        pass  # 如果获取边界框失败，继续处理
                    
                    for table in tables:
                        if table and len(table) > 0:
                            html = table_to_html(table, page_num)
                            if html:
                                page_tables[page_num].append(html)
                    
                    if page_tables[page_num]:
                        print(f"[DEBUG] 第{page_num}页发现 {len(page_tables[page_num])} 个表格")
                
                # 定义过滤函数：排除表格区域 + 页眉页脚区域
                def should_keep(obj):
                    """检查对象是否应该保留"""
                    if 'top' not in obj:
                        return True
                    
                    obj_top = obj.get('top', 0)
                    obj_bottom = obj.get('bottom', obj_top)
                    obj_center_y = (obj_top + obj_bottom) / 2
                    
                    # 排除页眉区域（页面顶部）
                    if obj_center_y < header_threshold:
                        return False
                    
                    # 排除页脚区域（页面底部）
                    if obj_center_y > footer_threshold:
                        return False
                    
                    # 排除表格区域
                    if table_bboxes:
                        obj_center_x = (obj.get('x0', 0) + obj.get('x1', 0)) / 2
                        for bbox in table_bboxes:
                            if (bbox[0] - 5 <= obj_center_x <= bbox[2] + 5 and 
                                bbox[1] - 5 <= obj_center_y <= bbox[3] + 5):
                                return False
                    
                    return True
                
                filtered_page = page.filter(should_keep)
                page_texts_clean[page_num] = filtered_page.extract_text() or ""
                    
    except Exception as e:
        print(f"[ERROR] pdfplumber 提取失败: {e}")
        import traceback
        traceback.print_exc()
    
    return page_tables, page_texts_clean


def table_to_html(table: List[List], page_num: int = -1) -> str:
    """将表格数据转换为 HTML"""
    if not table or len(table) == 0:
        return ""
    
    # 过滤掉完全为空的行
    valid_rows = [row for row in table if row and any(cell for cell in row)]
    if not valid_rows:
        return ""
    
    # 检测表头：第一行是否看起来像表头（通常是短文本）
    first_row = valid_rows[0] if valid_rows else []
    is_header_row = all(
        len(str(cell or '').strip()) < 30 
        for cell in first_row
    ) if first_row else False
    
    # 调试输出
    print(f"[DEBUG] 第{page_num}页表格: {len(valid_rows)}行, {len(first_row) if first_row else 0}列, 有表头={is_header_row}")
    
    html_parts = ['<table class="pdf-table">']
    
    for row_idx, row in enumerate(valid_rows):
        if not row:
            continue
        
        # 第一行作为表头（如果检测到是表头行）
        tag = 'th' if row_idx == 0 and is_header_row else 'td'
        
        html_parts.append('<tr>')
        for cell in row:
            cell_content = str(cell) if cell else ''
            # 清理多余空白，但保留换行
            cell_content = cell_content.strip()
            # 将内部的多个空白替换为单个空格
            cell_content = re.sub(r'[ \t]+', ' ', cell_content)
            # 保留换行符，转为 <br>
            cell_content = cell_content.replace('\n', '<br>')
            html_parts.append(f'<{tag}>{cell_content}</{tag}>')
        html_parts.append('</tr>')
    
    html_parts.append('</table>')
    
    return '\n'.join(html_parts)


def get_chapter_number(title: str) -> Optional[int]:
    """提取章节编号"""
    match = re.search(r'第\s*([一二三四五六七八九十]+|\d+)\s*[章节篇部]', title)
    if not match:
        return None
    
    num_str = match.group(1)
    if num_str.isdigit():
        return int(num_str)
    return CHINESE_NUM_MAP.get(num_str)


def extract_pdf_structure(pdf_bytes: bytes, filename: str) -> ParsedDocument:
    """
    提取 PDF 文档结构
    
    流程：
    1. 使用 pdfplumber 提取表格
    2. 使用 PyMuPDF 提取文本和识别章节
    3. 检测目录区域（连续章节标题）
    4. 按章节切分内容，整合表格
    """
    
    # 使用 pdfplumber 提取表格和过滤后的文本
    print("[DEBUG] 开始使用 pdfplumber 提取表格和文本...")
    page_tables, pdfplumber_texts = extract_tables_and_text_from_pdf(pdf_bytes)
    total_tables = sum(len(t) for t in page_tables.values())
    print(f"[DEBUG] 共提取到 {total_tables} 个表格")
    
    # 打开 PDF（使用 PyMuPDF 识别章节结构）
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    
    # 收集所有页面的文本
    page_texts = []        # 用于章节识别的完整文本
    page_clean_htmls = []  # 过滤目录和表格后的 HTML
    chapter_matches = []
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        
        # 使用 PyMuPDF 提取完整文本（用于章节识别）
        full_text = page.get_text()
        page_texts.append(full_text)
        
        # 使用 pdfplumber 提取的过滤后文本（用于显示）
        clean_text = pdfplumber_texts.get(page_num, full_text)
        
        # 转换为 HTML 格式
        page_html = format_text_to_html(clean_text)
        
        # 使用完整文本识别章节和目录
        lines = full_text.split('\n')
        toc_line_count = 0  # 统计本页目录行数量
        is_toc_page = False
        
        for line_num, line in enumerate(lines):
            line_stripped = line.strip()
            
            # 跳过空行
            if not line_stripped:
                continue
            
            # 检查是否是目录行
            if TOC_LINE_REGEX.match(line_stripped):
                toc_line_count += 1
                continue
            
            # 检查是否是章节标题（支持多种格式）
            chapter_match = re.match(
                r'^第\s*[一二三四五六七八九十零\d]+\s*[章节篇部]\s*(.{0,40})',
                line_stripped.replace('　', ' ')  # 全角空格转半角
            )
            
            if chapter_match:
                # 提取简洁的标题
                clean_title = re.sub(r'[\.·…]+\s*\d*\s*$', '', line_stripped).strip()
                clean_title = clean_title.replace('　', ' ')  # 全角空格转半角
                
                # 验证标题格式
                if 4 <= len(clean_title) <= 60:
                    if not re.search(r'[""《》]', clean_title):
                        chapter_matches.append({
                            'title': clean_title,
                            'page': page_num,
                            'line': line_num,
                            'is_toc_page': False
                        })
                        print(f"[DEBUG] 第{page_num}页发现章节: {clean_title}")
        
        # 如果本页目录行超过10行，标记为目录页
        if toc_line_count >= 10:
            is_toc_page = True
            for ch in chapter_matches:
                if ch['page'] == page_num:
                    if ch.get('line', 0) < len(lines) // 2:
                        ch['is_toc_page'] = True
        
        # 从 pdfplumber 的过滤后文本中过滤页码
        # 注意：保留目录行内容以便在前言中显示完整目录
        clean_text_lines = clean_text.split('\n') if clean_text else []
        filtered_lines = []
        for line in clean_text_lines:
            line_stripped = line.strip()
            if not line_stripped:
                filtered_lines.append('')
                continue
            # 只过滤明显的页码（位置检测可能遗漏的）
            if re.match(r'^[-—]?\s*\d{1,3}\s*[-—]?$', line_stripped):
                continue
            # 保留目录行内容（不再过滤 TOC_LINE_REGEX）
            filtered_lines.append(line)
        
        final_clean_text = '\n'.join(filtered_lines)
        
        # 生成页面 HTML（使用过滤后的文本，不含表格内容）
        page_clean_htmls.append(format_text_to_html(final_clean_text))
    
    doc.close()
    
    # 调试：打印所有识别到的章节
    print(f"[DEBUG] 原始识别章节: {[(ch['title'], ch['page'], ch.get('is_toc_page')) for ch in chapter_matches]}")
    
    # 过滤掉目录页的章节标题
    filtered_chapters = [ch for ch in chapter_matches if not ch.get('is_toc_page', False)]
    
    # 检测目录页：如果同一页有3个以上章节标题，认为是目录页
    page_chapter_count = {}
    for ch in filtered_chapters:
        page = ch['page']
        page_chapter_count[page] = page_chapter_count.get(page, 0) + 1
    
    toc_pages = {p for p, count in page_chapter_count.items() if count >= 3}
    print(f"[DEBUG] 识别到的目录页: {toc_pages}")
    
    # 使用重复章节编号检测来区分目录和正文
    # 规则：当遇到重复的章节编号时（如第二个"第一章"），说明正文开始
    def extract_chapter_num_str(title: str) -> Optional[str]:
        """提取章节编号的原始字符串（用于重复检测）"""
        match = re.search(r'第\s*([一二三四五六七八九十\d]+)\s*[章节篇部]', title)
        return match.group(1) if match else None
    
    # 按页面和行号排序，确保按文档顺序处理
    sorted_chapters = sorted(filtered_chapters, key=lambda x: (x['page'], x.get('line', 0)))
    
    # 检测目录结束位置（使用重复章节编号规则）
    seen_chapter_nums = set()
    toc_end_index = 0
    
    for i, ch in enumerate(sorted_chapters):
        chapter_num = extract_chapter_num_str(ch['title'])
        
        if chapter_num:
            if chapter_num in seen_chapter_nums:
                # 遇到重复章节编号，目录在此结束
                toc_end_index = i
                print(f"[DEBUG] 检测到重复章节编号 '{chapter_num}'，目录在索引 {i} 结束（正文开始）")
                break
            seen_chapter_nums.add(chapter_num)
    
    # 如果检测到重复编号，过滤掉目录部分的章节
    if toc_end_index > 0:
        # 目录部分：索引 0 到 toc_end_index-1
        # 正文部分：索引 toc_end_index 及之后
        filtered_chapters = sorted_chapters[toc_end_index:]
        print(f"[DEBUG] 使用重复编号规则过滤后: {[ch['title'] for ch in filtered_chapters]}")
    else:
        # 没有检测到重复编号，使用原有的目录页过滤
        filtered_chapters = [ch for ch in sorted_chapters if ch['page'] not in toc_pages]
        print(f"[DEBUG] 过滤目录页后: {[ch['title'] for ch in filtered_chapters]}")
    
    # 去重（相同标题只保留第一个）
    seen_titles = set()
    unique_chapters = []
    for ch in filtered_chapters:
        normalized = ch['title'].replace(' ', '').lower()
        if normalized not in seen_titles:
            seen_titles.add(normalized)
            unique_chapters.append(ch)
    
    # 章节连续性检查
    continuous_chapters = []
    
    # 先按章节号排序
    chapters_with_num = []
    for ch in unique_chapters:
        num = get_chapter_number(ch['title'])
        if num is not None:
            chapters_with_num.append((num, ch))
    
    # 按章节号排序
    chapters_with_num.sort(key=lambda x: x[0])
    
    # 检查连续性（从第一章开始）
    if chapters_with_num:
        expected_num = chapters_with_num[0][0]  # 从实际的第一个章节号开始
        
        for num, ch in chapters_with_num:
            # 允许小范围跳跃（最多跳2章）
            if expected_num <= num <= expected_num + 2:
                continuous_chapters.append(ch)
                expected_num = num + 1
    
    # 如果连续性检查后太少，使用原结果
    final_chapters = continuous_chapters if len(continuous_chapters) >= 2 else unique_chapters
    
    # 确保按页面顺序排列
    final_chapters.sort(key=lambda x: (x['page'], x.get('line', 0)))
    
    # 调试日志
    print(f"[DEBUG] 识别到的章节: {[ch['title'] for ch in final_chapters]}")
    
    # 获取文档总页数（提前定义，后续多处使用）
    total_pages = len(page_clean_htmls)
    print(f"[DEBUG] 文档总页数: {total_pages}")
    
    # 过滤掉页码超出范围的章节
    valid_chapters = [ch for ch in final_chapters if 0 <= ch['page'] < total_pages]
    if len(valid_chapters) != len(final_chapters):
        print(f"[DEBUG] 过滤掉 {len(final_chapters) - len(valid_chapters)} 个页码超出范围的章节")
        final_chapters = valid_chapters
    
    # 构建章节内容（使用带格式的 HTML）
    chapters = []
    
    # 前言（第一章之前的内容）
    if final_chapters:
        first_chapter_page = min(final_chapters[0]['page'], total_pages)
        if first_chapter_page > 0:
            intro_html = "\n".join(page_clean_htmls[:first_chapter_page])
            # 检查实际文本长度（去除 HTML 标签）
            intro_text = re.sub(r'<[^>]+>', '', intro_html)
            if len(intro_text.strip()) > 100:
                chapters.append(Chapter(
                    id="intro",
                    title="文件封面/前言",
                    content=intro_html
                ))
    
    # 构建各章节
    for i, ch in enumerate(final_chapters):
        start_page = ch['page']
        # 确保 end_page 不超出范围
        if i + 1 < len(final_chapters):
            end_page = min(final_chapters[i + 1]['page'], total_pages)
        else:
            end_page = total_pages
        
        # 确保 start_page 和 end_page 有效
        start_page = max(0, min(start_page, total_pages - 1))
        end_page = max(start_page + 1, min(end_page, total_pages))
        
        # 收集章节内容
        chapter_html_parts = []
        
        for page_idx in range(start_page, end_page):
            # 添加该页的文本内容
            if page_idx < len(page_clean_htmls):
                chapter_html_parts.append(page_clean_htmls[page_idx])
            
            # 添加该页的表格（如果有）
            if page_idx in page_tables and page_tables[page_idx]:
                for table_html in page_tables[page_idx]:
                    chapter_html_parts.append(f'<div class="extracted-table">{table_html}</div>')
        
        chapter_html = "\n".join(chapter_html_parts)
        
        # 检查实际文本长度
        chapter_text = re.sub(r'<[^>]+>', '', chapter_html)
        
        if len(chapter_text.strip()) > 50:
            chapters.append(Chapter(
                id=f"chapter-{i}",
                title=ch['title'],
                content=chapter_html
            ))
    
    # 如果没有识别出章节，将整个文档作为一个章节
    if not chapters:
        full_html = "\n".join(page_clean_htmls)
        chapters.append(Chapter(
            id="full",
            title="完整文档",
            content=full_html
        ))
    
    # 构建 rawHtml
    raw_html = "\n".join(
        f"<h2>{ch.title}</h2>\n{ch.content}"
        for ch in chapters
    )
    
    return ParsedDocument(
        name=filename,
        chapters=chapters,
        rawHtml=raw_html
    )


def clean_pymupdf_html(html: str) -> str:
    """
    清理 PyMuPDF 生成的 HTML，保留表格和基本格式
    """
    # 移除 doctype 和 html/head/body 标签
    html = re.sub(r'<!DOCTYPE[^>]*>', '', html)
    html = re.sub(r'</?html[^>]*>', '', html)
    html = re.sub(r'<head[^>]*>.*?</head>', '', html, flags=re.DOTALL)
    html = re.sub(r'</?body[^>]*>', '', html)
    
    # 保留表格标签，清理其过于复杂的样式
    html = re.sub(r'<table[^>]*>', '<table class="pdf-table">', html)
    html = re.sub(r'<tr[^>]*>', '<tr>', html)
    html = re.sub(r'<td[^>]*>', '<td>', html)
    html = re.sub(r'<th[^>]*>', '<th>', html)
    
    # 保留 div 结构（用于布局）
    html = re.sub(r'<div[^>]*>', '<div class="pdf-block">', html)
    
    # 保留段落，添加适当间距
    html = re.sub(r'<p[^>]*>', '<p class="pdf-para">', html)
    
    # 移除 span 的复杂样式，但保留粗体
    def simplify_span(match):
        style = match.group(1) if match.group(1) else ""
        content = match.group(2)
        if 'font-weight' in style and ('bold' in style or '700' in style or '600' in style):
            return f'<strong>{content}</strong>'
        return content
    
    html = re.sub(r'<span[^>]*style="([^"]*)"[^>]*>(.*?)</span>', simplify_span, html, flags=re.DOTALL)
    html = re.sub(r'<span[^>]*>(.*?)</span>', r'\1', html, flags=re.DOTALL)
    
    # 移除空段落
    html = re.sub(r'<p[^>]*>\s*</p>', '', html)
    
    # 保留换行符作为 <br>
    html = re.sub(r'\n{2,}', '</p><p class="pdf-para">', html)
    
    # 高亮填空项
    blank_pattern = re.compile(r'(_{2,}|\[\s*\]|（\s*）)')
    html = blank_pattern.sub(r'<span class="highlight-blank">\1</span>', html)
    
    return html.strip()


def format_text_to_html(text: str) -> str:
    """将纯文本转换为 HTML，保留段落结构"""
    # 填空项高亮
    blank_pattern = re.compile(r'(_{2,}|\[\s*\]|（\s*）)')
    
    lines = text.split('\n')
    html_parts = []
    current_para = []
    
    for line in lines:
        line_stripped = line.strip()
        
        if not line_stripped:
            # 空行表示段落结束
            if current_para:
                para_text = ' '.join(current_para)
                para_text = blank_pattern.sub(r'<span class="highlight-blank">\1</span>', para_text)
                html_parts.append(f'<p class="pdf-para">{para_text}</p>')
                current_para = []
        else:
            # 检查是否是新段落开始（以序号、数字开头，或者明显的标题）
            is_new_para = (
                re.match(r'^[\d一二三四五六七八九十]+[、.．）\)]\s*', line_stripped) or
                re.match(r'^[（\(][\d一二三四五六七八九十]+[）\)]\s*', line_stripped) or
                re.match(r'^第\s*[一二三四五六七八九十\d]+\s*[条章节]', line_stripped) or
                len(line_stripped) < 20  # 短行可能是标题
            )
            
            if is_new_para and current_para:
                para_text = ' '.join(current_para)
                para_text = blank_pattern.sub(r'<span class="highlight-blank">\1</span>', para_text)
                html_parts.append(f'<p class="pdf-para">{para_text}</p>')
                current_para = []
            
            current_para.append(line_stripped)
    
    # 处理最后一个段落
    if current_para:
        para_text = ' '.join(current_para)
        para_text = blank_pattern.sub(r'<span class="highlight-blank">\1</span>', para_text)
        html_parts.append(f'<p class="pdf-para">{para_text}</p>')
    
    return "\n".join(html_parts)


def format_html(text: str) -> str:
    """将纯文本转换为 HTML（兼容旧版）"""
    return format_text_to_html(text)


# ==================== API 路由 ====================

@app.get("/")
async def root():
    return {"message": "PDF Parser API is running", "version": "1.0.0"}


@app.post("/api/parse-pdf", response_model=ParsedDocument)
async def parse_pdf(file: UploadFile = File(...)):
    """
    解析 PDF 文件
    
    - **file**: PDF 文件
    - 返回: 解析后的文档结构
    """
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="只支持 PDF 文件")
    
    try:
        # 读取文件内容
        pdf_bytes = await file.read()
        
        # 解析 PDF
        result = extract_pdf_structure(pdf_bytes, file.filename)
        
        return result
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF 解析失败: {str(e)}")


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


# ==================== 启动服务 ====================

if __name__ == "__main__":
    import uvicorn
    print("=" * 50)
    print("  PDF Parser API Server")
    print("  http://localhost:8000")
    print("  API Docs: http://localhost:8000/docs")
    print("=" * 50)
    uvicorn.run(app, host="0.0.0.0", port=8000)
