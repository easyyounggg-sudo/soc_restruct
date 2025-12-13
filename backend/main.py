"""
PDF 文档解析后端服务
使用 PyMuPDF 提取 PDF 结构化内容

优化:
1. Memory: 使用 tempfile 流式处理大型 PDF
2. Accuracy: 自适应页眉检测
3. Consistency: 跨页表格合并
"""

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Tuple
import fitz  # PyMuPDF
import pdfplumber
import re
import io
import tempfile
import os

app = FastAPI(title="PDF Parser API", version="2.0.0")

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


# ==================== 自适应页眉页脚检测 ====================

def detect_adaptive_header_footer(pdf_path: str, sample_pages: int = 5) -> Tuple[float, float]:
    """
    自适应检测页眉页脚区域
    
    通过分析前 N 页的文本分布，检测重复出现在页面顶部/底部的内容
    
    返回: (header_ratio, footer_ratio) - 页眉和页脚占页面高度的比例
    """
    header_candidates = []  # 每页顶部文本的 Y 坐标
    footer_candidates = []  # 每页底部文本的 Y 坐标
    
    try:
        with pdfplumber.open(pdf_path) as pdf:
            pages_to_check = min(sample_pages, len(pdf.pages))
            
            for page_num in range(pages_to_check):
                page = pdf.pages[page_num]
                page_height = page.height
                
                # 获取所有文本对象
                chars = page.chars
                if not chars:
                    continue
                
                # 按 Y 坐标分组
                top_chars = [c for c in chars if c.get('top', 0) < page_height * 0.15]
                bottom_chars = [c for c in chars if c.get('bottom', page_height) > page_height * 0.85]
                
                # 记录顶部区域最低的文本位置
                if top_chars:
                    max_top = max(c.get('bottom', 0) for c in top_chars)
                    header_candidates.append(max_top / page_height)
                
                # 记录底部区域最高的文本位置
                if bottom_chars:
                    min_bottom = min(c.get('top', page_height) for c in bottom_chars)
                    footer_candidates.append(1 - min_bottom / page_height)
        
        # 计算平均值，如果没有检测到则使用默认值
        header_ratio = sum(header_candidates) / len(header_candidates) if header_candidates else 0.08
        footer_ratio = sum(footer_candidates) / len(footer_candidates) if footer_candidates else 0.08
        
        # 限制在合理范围内
        header_ratio = max(0.03, min(0.15, header_ratio))
        footer_ratio = max(0.03, min(0.15, footer_ratio))
        
        print(f"[DEBUG] 自适应检测: 页眉区域={header_ratio:.1%}, 页脚区域={footer_ratio:.1%}")
        
        return header_ratio, footer_ratio
        
    except Exception as e:
        print(f"[WARN] 自适应检测失败，使用默认值: {e}")
        return 0.08, 0.08


# ==================== 跨页表格合并 ====================

def are_tables_similar(table1: List[List], table2: List[List]) -> bool:
    """
    判断两个表格是否可能是同一个跨页表格
    
    规则:
    1. 列数相同
    2. 第一个表格没有明显的结束标志
    3. 第二个表格没有表头（或表头与第一个表格相同）
    """
    if not table1 or not table2:
        return False
    
    # 获取列数
    cols1 = max(len(row) for row in table1 if row) if table1 else 0
    cols2 = max(len(row) for row in table2 if row) if table2 else 0
    
    # 列数必须相同
    if cols1 != cols2 or cols1 == 0:
        return False
    
    # 检查第二个表格的第一行是否像表头
    first_row_2 = table2[0] if table2 else []
    first_row_1 = table1[0] if table1 else []
    
    # 如果第二个表格的第一行与第一个表格的第一行相同，可能是重复的表头
    if first_row_1 and first_row_2:
        if all(str(c1 or '').strip() == str(c2 or '').strip() 
               for c1, c2 in zip(first_row_1, first_row_2)):
            return True
    
    # 如果第二个表格的第一行看起来不像表头（包含长文本或数字），可能是续表
    if first_row_2:
        avg_length = sum(len(str(cell or '')) for cell in first_row_2) / len(first_row_2)
        if avg_length > 20:  # 平均单元格长度超过20，不太像表头
            return True
    
    return False


def merge_tables(table1: List[List], table2: List[List]) -> List[List]:
    """合并两个表格"""
    if not table1:
        return table2
    if not table2:
        return table1
    
    result = list(table1)
    
    # 检查第二个表格是否有重复的表头
    first_row_1 = table1[0] if table1 else []
    first_row_2 = table2[0] if table2 else []
    
    start_idx = 0
    if first_row_1 and first_row_2:
        if all(str(c1 or '').strip() == str(c2 or '').strip() 
               for c1, c2 in zip(first_row_1, first_row_2)):
            start_idx = 1  # 跳过重复的表头
    
    result.extend(table2[start_idx:])
    return result


def extract_tables_with_merging(pdf_path: str, header_ratio: float, footer_ratio: float) -> Tuple[Dict[int, List[str]], Dict[int, str]]:
    """
    提取表格并合并跨页表格
    
    返回: (page_tables, page_texts_clean)
    """
    page_tables: Dict[int, List[str]] = {}
    page_texts_clean: Dict[int, str] = {}
    
    # 临时存储：用于跨页表格检测
    pending_table: Optional[List[List]] = None
    pending_table_page: int = -1
    
    try:
        with pdfplumber.open(pdf_path) as pdf:
            total_pages = len(pdf.pages)
            
            for page_num, page in enumerate(pdf.pages):
                page_height = page.height
                header_threshold = page_height * header_ratio
                footer_threshold = page_height * (1 - footer_ratio)
                
                # 提取表格 - 尝试多种策略
                table_bboxes = []
                best_tables = []
                best_col_count = 0
                
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
                            total_cols = sum(
                                max(len(row) for row in table if row) if table else 0
                                for table in test_tables
                            )
                            if total_cols > best_col_count:
                                best_col_count = total_cols
                                best_tables = test_tables
                    except:
                        continue
                
                tables = best_tables
                
                # 处理跨页表格合并
                current_page_tables = []
                
                for table_idx, table in enumerate(tables):
                    if not table or len(table) == 0:
                        continue
                    
                    # 检查是否应该与上一页的表格合并
                    if pending_table and table_idx == 0:
                        if are_tables_similar(pending_table, table):
                            print(f"[DEBUG] 合并跨页表格: 第{pending_table_page}页 + 第{page_num}页")
                            table = merge_tables(pending_table, table)
                            # 更新上一页的表格
                            if pending_table_page in page_tables and page_tables[pending_table_page]:
                                page_tables[pending_table_page].pop()  # 移除未完成的表格
                        pending_table = None
                        pending_table_page = -1
                    
                    # 检查当前表格是否可能跨页（是本页最后一个表格）
                    is_last_table = (table_idx == len(tables) - 1)
                    is_near_bottom = False
                    
                    try:
                        table_objs = page.find_tables()
                        if table_objs and table_idx < len(table_objs):
                            table_bbox = table_objs[table_idx].bbox
                            # 如果表格底部接近页面底部
                            if table_bbox[3] > page_height * 0.9:
                                is_near_bottom = True
                    except:
                        pass
                    
                    if is_last_table and is_near_bottom and page_num < total_pages - 1:
                        # 可能是跨页表格，暂存
                        pending_table = table
                        pending_table_page = page_num
                    
                    # 生成 HTML
                    html = table_to_html(table, page_num)
                    if html:
                        current_page_tables.append(html)
                
                if current_page_tables:
                    page_tables[page_num] = current_page_tables
                    print(f"[DEBUG] 第{page_num}页发现 {len(current_page_tables)} 个表格")
                
                # 获取表格边界框用于文本过滤
                try:
                    for table_obj in page.find_tables():
                        table_bboxes.append(table_obj.bbox)
                except:
                    pass
                
                # 过滤文本
                def should_keep(obj):
                    if 'top' not in obj:
                        return True
                    
                    obj_top = obj.get('top', 0)
                    obj_bottom = obj.get('bottom', obj_top)
                    obj_center_y = (obj_top + obj_bottom) / 2
                    
                    if obj_center_y < header_threshold:
                        return False
                    if obj_center_y > footer_threshold:
                        return False
                    
                    if table_bboxes:
                        obj_center_x = (obj.get('x0', 0) + obj.get('x1', 0)) / 2
                        for bbox in table_bboxes:
                            if (bbox[0] - 5 <= obj_center_x <= bbox[2] + 5 and 
                                bbox[1] - 5 <= obj_center_y <= bbox[3] + 5):
                                return False
                    
                    return True
                
                filtered_page = page.filter(should_keep)
                page_texts_clean[page_num] = filtered_page.extract_text() or ""
            
            # 处理最后一个可能的跨页表格
            if pending_table:
                html = table_to_html(pending_table, pending_table_page)
                if html:
                    if pending_table_page not in page_tables:
                        page_tables[pending_table_page] = []
                    page_tables[pending_table_page].append(html)
                    
    except Exception as e:
        print(f"[ERROR] 表格提取失败: {e}")
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
    
    # 获取最大列数
    max_cols = max(len(row) for row in valid_rows) if valid_rows else 0
    
    # 检测表头
    first_row = valid_rows[0] if valid_rows else []
    is_header_row = all(
        len(str(cell or '').strip()) < 30 
        for cell in first_row
    ) if first_row else False
    
    print(f"[DEBUG] 第{page_num}页表格: {len(valid_rows)}行, {max_cols}列, 有表头={is_header_row}")
    
    html_parts = ['<div class="table-wrapper"><table class="pdf-table">']
    
    for row_idx, row in enumerate(valid_rows):
        if not row:
            continue
        
        tag = 'th' if row_idx == 0 and is_header_row else 'td'
        
        html_parts.append('<tr>')
        # 确保每行有相同的列数
        for col_idx in range(max_cols):
            cell = row[col_idx] if col_idx < len(row) else ''
            cell_content = str(cell) if cell else ''
            cell_content = cell_content.strip()
            cell_content = re.sub(r'[ \t]+', ' ', cell_content)
            cell_content = cell_content.replace('\n', '<br>')
            html_parts.append(f'<{tag}>{cell_content}</{tag}>')
        html_parts.append('</tr>')
    
    html_parts.append('</table></div>')
    
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


def extract_pdf_structure(pdf_path: str, filename: str) -> ParsedDocument:
    """
    提取 PDF 文档结构
    
    使用临时文件路径而非内存中的字节
    """
    
    # 自适应检测页眉页脚
    print("[DEBUG] 开始自适应页眉页脚检测...")
    header_ratio, footer_ratio = detect_adaptive_header_footer(pdf_path)
    
    # 提取表格（带跨页合并）
    print("[DEBUG] 开始提取表格（含跨页合并）...")
    page_tables, pdfplumber_texts = extract_tables_with_merging(pdf_path, header_ratio, footer_ratio)
    total_tables = sum(len(t) for t in page_tables.values())
    print(f"[DEBUG] 共提取到 {total_tables} 个表格")
    
    # 使用 PyMuPDF 识别章节结构
    doc = fitz.open(pdf_path)
    
    page_texts = []
    page_clean_htmls = []
    chapter_matches = []
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        
        full_text = page.get_text()
        page_texts.append(full_text)
        
        clean_text = pdfplumber_texts.get(page_num, full_text)
        
        # 章节识别
        lines = full_text.split('\n')
        toc_line_count = 0
        
        for line_num, line in enumerate(lines):
            line_stripped = line.strip()
            
            if not line_stripped:
                continue
            
            if TOC_LINE_REGEX.match(line_stripped):
                toc_line_count += 1
                continue
            
            chapter_match = re.match(
                r'^第\s*[一二三四五六七八九十零\d]+\s*[章节篇部]\s*(.{0,40})',
                line_stripped.replace('　', ' ')
            )
            
            if chapter_match:
                clean_title = re.sub(r'[\.·…]+\s*\d*\s*$', '', line_stripped).strip()
                clean_title = clean_title.replace('　', ' ')
                
                if 4 <= len(clean_title) <= 60:
                    if not re.search(r'[""《》]', clean_title):
                        chapter_matches.append({
                            'title': clean_title,
                            'page': page_num,
                            'line': line_num,
                            'is_toc_page': False
                        })
        
        if toc_line_count >= 10:
            for ch in chapter_matches:
                if ch['page'] == page_num:
                    if ch.get('line', 0) < len(lines) // 2:
                        ch['is_toc_page'] = True
        
        # 过滤文本
        clean_text_lines = clean_text.split('\n') if clean_text else []
        filtered_lines = []
        for line in clean_text_lines:
            line_stripped = line.strip()
            if not line_stripped:
                filtered_lines.append('')
                continue
            if re.match(r'^[-—]?\s*\d{1,3}\s*[-—]?$', line_stripped):
                continue
            filtered_lines.append(line)
        
        final_clean_text = '\n'.join(filtered_lines)
        page_clean_htmls.append(format_text_to_html(final_clean_text))
    
    doc.close()
    
    # 处理章节（与之前逻辑相同）
    filtered_chapters = [ch for ch in chapter_matches if not ch.get('is_toc_page', False)]
    
    page_chapter_count = {}
    for ch in filtered_chapters:
        page = ch['page']
        page_chapter_count[page] = page_chapter_count.get(page, 0) + 1
    
    toc_pages = {p for p, count in page_chapter_count.items() if count >= 3}
    
    def extract_chapter_num_str(title: str) -> Optional[str]:
        match = re.search(r'第\s*([一二三四五六七八九十\d]+)\s*[章节篇部]', title)
        return match.group(1) if match else None
    
    sorted_chapters = sorted(filtered_chapters, key=lambda x: (x['page'], x.get('line', 0)))
    
    seen_chapter_nums = set()
    toc_end_index = 0
    
    for i, ch in enumerate(sorted_chapters):
        chapter_num = extract_chapter_num_str(ch['title'])
        if chapter_num:
            if chapter_num in seen_chapter_nums:
                toc_end_index = i
                print(f"[DEBUG] 检测到重复章节编号 '{chapter_num}'，目录在索引 {i} 结束")
                break
            seen_chapter_nums.add(chapter_num)
    
    if toc_end_index > 0:
        filtered_chapters = sorted_chapters[toc_end_index:]
    else:
        filtered_chapters = [ch for ch in sorted_chapters if ch['page'] not in toc_pages]
    
    seen_titles = set()
    unique_chapters = []
    for ch in filtered_chapters:
        normalized = ch['title'].replace(' ', '').lower()
        if normalized not in seen_titles:
            seen_titles.add(normalized)
            unique_chapters.append(ch)
    
    # 章节连续性检查
    continuous_chapters = []
    chapters_with_num = []
    for ch in unique_chapters:
        num = get_chapter_number(ch['title'])
        if num is not None:
            chapters_with_num.append((num, ch))
    
    chapters_with_num.sort(key=lambda x: x[0])
    
    if chapters_with_num:
        expected_num = chapters_with_num[0][0]
        for num, ch in chapters_with_num:
            if expected_num <= num <= expected_num + 2:
                continuous_chapters.append(ch)
                expected_num = num + 1
    
    final_chapters = continuous_chapters if len(continuous_chapters) >= 2 else unique_chapters
    final_chapters.sort(key=lambda x: (x['page'], x.get('line', 0)))
    
    print(f"[DEBUG] 识别到的章节: {[ch['title'] for ch in final_chapters]}")
    
    total_pages = len(page_clean_htmls)
    
    valid_chapters = [ch for ch in final_chapters if 0 <= ch['page'] < total_pages]
    final_chapters = valid_chapters
    
    # 构建章节内容
    chapters = []
    
    if final_chapters:
        first_chapter_page = min(final_chapters[0]['page'], total_pages)
        if first_chapter_page > 0:
            intro_html = "\n".join(page_clean_htmls[:first_chapter_page])
            intro_text = re.sub(r'<[^>]+>', '', intro_html)
            if len(intro_text.strip()) > 100:
                chapters.append(Chapter(
                    id="intro",
                    title="文件封面/前言",
                    content=intro_html
                ))
    
    for i, ch in enumerate(final_chapters):
        start_page = ch['page']
        if i + 1 < len(final_chapters):
            end_page = min(final_chapters[i + 1]['page'], total_pages)
        else:
            end_page = total_pages
        
        start_page = max(0, min(start_page, total_pages - 1))
        end_page = max(start_page + 1, min(end_page, total_pages))
        
        chapter_html_parts = []
        
        for page_idx in range(start_page, end_page):
            if page_idx < len(page_clean_htmls):
                chapter_html_parts.append(page_clean_htmls[page_idx])
            
            if page_idx in page_tables and page_tables[page_idx]:
                for table_html in page_tables[page_idx]:
                    chapter_html_parts.append(f'<div class="extracted-table">{table_html}</div>')
        
        chapter_html = "\n".join(chapter_html_parts)
        chapter_text = re.sub(r'<[^>]+>', '', chapter_html)
        
        if len(chapter_text.strip()) > 50:
            chapters.append(Chapter(
                id=f"chapter-{i}",
                title=ch['title'],
                content=chapter_html
            ))
    
    if not chapters:
        full_html = "\n".join(page_clean_htmls)
        chapters.append(Chapter(
            id="full",
            title="完整文档",
            content=full_html
        ))
    
    raw_html = "\n".join(
        f"<h2>{ch.title}</h2>\n{ch.content}"
        for ch in chapters
    )
    
    return ParsedDocument(
        name=filename,
        chapters=chapters,
        rawHtml=raw_html
    )


def format_text_to_html(text: str) -> str:
    """将纯文本转换为 HTML，保留段落结构"""
    blank_pattern = re.compile(r'(_{2,}|\[\s*\]|（\s*）)')
    
    lines = text.split('\n')
    html_parts = []
    current_para = []
    
    for line in lines:
        line_stripped = line.strip()
        
        if not line_stripped:
            if current_para:
                para_text = ' '.join(current_para)
                para_text = blank_pattern.sub(r'<span class="highlight-blank">\1</span>', para_text)
                html_parts.append(f'<p class="pdf-para">{para_text}</p>')
                current_para = []
        else:
            is_new_para = (
                re.match(r'^[\d一二三四五六七八九十]+[、.．）\)]\s*', line_stripped) or
                re.match(r'^[（\(][\d一二三四五六七八九十]+[）\)]\s*', line_stripped) or
                re.match(r'^第\s*[一二三四五六七八九十\d]+\s*[条章节]', line_stripped) or
                len(line_stripped) < 20
            )
            
            if is_new_para and current_para:
                para_text = ' '.join(current_para)
                para_text = blank_pattern.sub(r'<span class="highlight-blank">\1</span>', para_text)
                html_parts.append(f'<p class="pdf-para">{para_text}</p>')
                current_para = []
            
            current_para.append(line_stripped)
    
    if current_para:
        para_text = ' '.join(current_para)
        para_text = blank_pattern.sub(r'<span class="highlight-blank">\1</span>', para_text)
        html_parts.append(f'<p class="pdf-para">{para_text}</p>')
    
    return "\n".join(html_parts)


# ==================== API 路由 ====================

@app.get("/")
async def root():
    return {"message": "PDF Parser API is running", "version": "2.0.0"}


@app.post("/api/parse-pdf", response_model=ParsedDocument)
async def parse_pdf(file: UploadFile = File(...)):
    """
    解析 PDF 文件
    
    使用 tempfile 流式处理，支持大型 PDF
    """
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="只支持 PDF 文件")
    
    # 使用临时文件而非全部读入内存
    temp_file = None
    try:
        # 创建临时文件
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix='.pdf')
        temp_path = temp_file.name
        
        # 流式写入临时文件（分块读取，避免大文件内存溢出）
        print(f"[DEBUG] 开始接收文件: {file.filename}")
        chunk_size = 1024 * 1024  # 1MB chunks
        total_size = 0
        
        while True:
            chunk = await file.read(chunk_size)
            if not chunk:
                break
            temp_file.write(chunk)
            total_size += len(chunk)
        
        temp_file.close()
        print(f"[DEBUG] 文件接收完成: {total_size / 1024 / 1024:.2f} MB")
        
        # 解析 PDF
        result = extract_pdf_structure(temp_path, file.filename)
        
        return result
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"PDF 解析失败: {str(e)}")
    
    finally:
        # 清理临时文件
        if temp_file:
            try:
                os.unlink(temp_file.name)
            except:
                pass


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


# ==================== 启动服务 ====================

if __name__ == "__main__":
    import uvicorn
    print("=" * 50)
    print("  PDF Parser API Server v2.0.0")
    print("  http://localhost:8000")
    print("  API Docs: http://localhost:8000/docs")
    print("  ")
    print("  优化功能:")
    print("  - 流式处理大型 PDF (tempfile)")
    print("  - 自适应页眉页脚检测")
    print("  - 跨页表格自动合并")
    print("=" * 50)
    uvicorn.run(app, host="0.0.0.0", port=8000)
