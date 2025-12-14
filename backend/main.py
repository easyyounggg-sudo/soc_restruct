"""
PDF 文档解析后端服务 - V6.0 AI 代理版
核心改进：两阶段表格提取、伪表格过滤、AI 代理（避免跨域）
"""

from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any, Tuple
import fitz  # PyMuPDF
import pdfplumber
import re
import io
import os
import httpx
import json

app = FastAPI(title="PDF Parser API", version="6.0.0")

# ==================== AI 配置 ====================

# API Key（优先从环境变量读取，否则使用默认值）
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "AIzaSyCcdgAV9UQ7qnwAvHkX8GLCAjtaEd5xH8A")
GEMINI_MODEL = "gemini-2.0-flash-lite"
GEMINI_API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

# CORS 配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==================== 配置参数（可调） ====================

class TableExtractionConfig:
    """表格提取配置 - 所有参数可调"""
    
    # 策略参数
    vertical_strategy: str = "lines_strict"
    horizontal_strategy: str = "lines_strict"
    snap_tolerance: int = 4
    join_tolerance: int = 4
    intersection_tolerance: int = 4
    edge_min_length: int = 50  # 重要：提高阈值，过滤短线/装饰线
    
    # 伪表格过滤阈值（进一步提高严格度）
    min_rows: int = 3  # 最少行数
    min_cols: int = 3  # 最少列数（提高到3，过滤掉2列的伪表格）
    min_non_empty_ratio: float = 0.45  # 非空单元格比例下限
    min_width_ratio: float = 0.55  # bbox 宽度占页面宽度的下限
    min_height_px: float = 100  # bbox 最小高度
    min_area_px: float = 15000  # bbox 最小面积
    
    # 表头关键词检查
    min_header_keywords: int = 1  # 至少命中几个关键词
    
    # 强表头关键词（这些词命中1个就够）
    strong_header_keywords: List[str] = [
        "序号", "编号", "单价", "总价", "金额", "数量", "单位",
        "评分", "分值", "得分", "权重", "满分",
        "规格", "型号", "品牌", "报价", "清单", "明细", "汇总",
        "响应", "偏离", "符合性", "资格性"  # 招标文件特有的表格标识
    ]
    
    # 弱表头关键词（需要命中2个以上才算）
    weak_header_keywords: List[str] = [
        "名称", "参数", "配置", "备注", "说明", "要求", "内容", "项目"
    ]
    
    # 合并（兼容旧代码）
    header_keywords: List[str] = strong_header_keywords + weak_header_keywords
    
    # 疑似表格页关键词
    table_page_keywords: List[str] = [
        "一览表", "明细表", "评分", "序号", "清单", "参数", "偏离", "报价",
        "汇总表", "需求表", "配置表", "规格表", "价格表", "分项", "技术参数"
    ]
    
    # 功能开关
    enable_table_page_filter: bool = False  # 是否启用疑似表格页快速判定
    table_page_sample_chars: int = 1500  # 快速判定采样字符数
    
    # Debug 模式（可通过环境变量或请求参数开启）
    debug_mode: bool = os.getenv("PDF_DEBUG", "false").lower() == "true"


# 全局配置实例
config = TableExtractionConfig()


# ==================== 数据模型 ====================

class TableInfo(BaseModel):
    """单个表格的结构化信息"""
    page_number: int
    bbox: List[float]
    rows: List[List[str]]
    headers: List[str]
    row_count: int
    col_count: int
    non_empty_ratio: float
    html: str


class TableDebugInfo(BaseModel):
    """Debug 信息"""
    page_number: int
    bbox: List[float]
    rows: int
    cols: int
    non_empty_ratio: float
    matched_keywords: List[str]
    rejected_reason: Optional[str] = None
    accepted: bool


class Chapter(BaseModel):
    id: str
    title: str
    content: str


class ParsedDocument(BaseModel):
    name: str
    chapters: List[Chapter]
    rawHtml: str
    tables: Optional[List[TableInfo]] = None
    debug_tables: Optional[List[TableDebugInfo]] = None


# ==================== 核心：两阶段表格提取 ====================

def is_table_page_candidate(page, sample_chars: int = 1500) -> bool:
    """
    快速判定：页面是否可能包含表格
    只抽取前 N 个字符检查关键词
    """
    try:
        text = page.extract_text() or ""
        sample = text[:sample_chars]
        
        for keyword in config.table_page_keywords:
            if keyword in sample:
                return True
        return False
    except:
        return True  # 出错时默认进行完整扫描


def clean_cell(cell: Any, preserve_newlines: bool = False) -> str:
    """
    单元格清洗：
    - None -> ""
    - strip() 去首尾空白
    - 规范化多空格
    - 可选保留换行
    """
    if cell is None:
        return ""
    
    text = str(cell).strip()
    
    if preserve_newlines:
        # 保留换行，但规范化空格
        lines = text.split('\n')
        lines = [re.sub(r'[ \t]+', ' ', line.strip()) for line in lines]
        return '\n'.join(lines)
    else:
        # 换行转空格，规范化多空格
        text = text.replace('\n', ' ')
        text = re.sub(r'\s+', ' ', text)
        return text.strip()


def clean_table_data(table_data: List[List]) -> List[List[str]]:
    """清洗整个表格数据"""
    if not table_data:
        return []
    
    cleaned = []
    for row in table_data:
        if row is None:
            continue
        cleaned_row = [clean_cell(cell) for cell in row]
        cleaned.append(cleaned_row)
    
    return cleaned


def calculate_non_empty_ratio(rows: List[List[str]]) -> float:
    """计算非空单元格比例"""
    if not rows:
        return 0.0
    
    total_cells = 0
    non_empty = 0
    
    for row in rows:
        for cell in row:
            total_cells += 1
            if cell and cell.strip():
                non_empty += 1
    
    return non_empty / total_cells if total_cells > 0 else 0.0


def is_header_like_row(row: List[str]) -> bool:
    """
    检查一行是否看起来像表头
    表头特征：单元格内容短，不是完整句子
    注意：放宽条件以适应各种表头格式
    """
    if not row:
        return False
    
    non_empty_cells = [cell for cell in row if cell.strip()]
    if not non_empty_cells:
        return False
    
    # 表头单元格通常较短（放宽阈值）
    avg_length = sum(len(cell) for cell in non_empty_cells) / len(non_empty_cells)
    max_length = max(len(cell) for cell in non_empty_cells)
    
    # 放宽条件：平均长度>25或最大长度>50才认为不是表头
    if avg_length > 25 or max_length > 50:
        return False
    
    # 表头不应该包含句号（完整句子的标志）
    sentence_end_count = 0
    for cell in non_empty_cells:
        if '。' in cell:  # 包含句号，可能不是表头
            sentence_end_count += 1
    
    # 如果超过一半的单元格包含句号，不是表头
    if sentence_end_count > len(non_empty_cells) * 0.5:
        return False
    
    return True


def find_matched_header_keywords(rows: List[List[str]]) -> Tuple[List[str], bool]:
    """
    检查前两行是否命中表头关键词
    返回: (匹配的关键词列表, 是否通过检查)
    """
    matched_strong = []
    matched_weak = []
    
    # 只检查第一行（表头）
    check_rows = rows[:1] if rows else []
    
    for row in check_rows:
        for cell in row:
            cell_text = str(cell).strip()
            # 检查强关键词
            for keyword in config.strong_header_keywords:
                if keyword in cell_text and keyword not in matched_strong:
                    matched_strong.append(keyword)
            # 检查弱关键词
            for keyword in config.weak_header_keywords:
                if keyword in cell_text and keyword not in matched_weak:
                    matched_weak.append(keyword)
    
    all_matched = matched_strong + matched_weak
    
    # 判断逻辑：
    # 1. 有强关键词 -> 通过
    # 2. 弱关键词 >= 2 个 -> 通过
    # 3. 其他 -> 不通过
    is_valid = len(matched_strong) >= 1 or len(matched_weak) >= 2
    
    return all_matched, is_valid


def is_likely_continuation_table(rows: List[List[str]]) -> bool:
    """
    检测是否可能是跨页表格的续页
    
    核心思路：续页的特征是"结构规整但第一行是数据而非表头"
    """
    if not rows or len(rows) < 2:
        return False
    
    first_row = rows[0]
    if not first_row or len(first_row) < 3:
        return False
    
    col_count = len(first_row)
    
    # 检查1：列数一致性（续页通常列数固定）
    consistent_cols = sum(1 for row in rows if len(row) == col_count)
    if consistent_cols < len(rows) * 0.8:
        return False  # 列数不一致，不像表格
    
    # 检查2：第一列是否像序号（数字、中文数字、或递增）
    first_col_values = [row[0] if row else "" for row in rows]
    numeric_count = 0
    for val in first_col_values:
        val_clean = str(val).strip()
        # 检查是否是数字或序号格式
        if re.match(r'^[\d]+\.?$', val_clean):
            numeric_count += 1
        elif re.match(r'^[一二三四五六七八九十]+$', val_clean):
            numeric_count += 1
        elif re.match(r'^[（\(]?\d+[）\)]?$', val_clean):  # (1) 格式
            numeric_count += 1
    
    # 如果大部分第一列是序号，很可能是续页表格
    if numeric_count >= len(rows) * 0.4:
        return True
    
    # 检查3：第一行内容长度（表头通常短，数据行通常长）
    first_row_non_empty = [cell for cell in first_row if cell.strip()]
    if first_row_non_empty:
        avg_len = sum(len(cell) for cell in first_row_non_empty) / len(first_row_non_empty)
        # 如果第一行平均内容长度>15，可能是数据行
        if avg_len > 15:
            return True
    
    # 检查4：第一行包含数字/金额/日期等数据特征
    data_pattern_count = 0
    for cell in first_row:
        cell_clean = str(cell).strip()
        # 数字、金额、百分比、日期等
        if re.search(r'\d+\.?\d*[万元%]?', cell_clean):
            data_pattern_count += 1
        if re.search(r'\d{4}[-/年]\d{1,2}[-/月]', cell_clean):
            data_pattern_count += 1
    
    if data_pattern_count >= len(first_row) * 0.3:
        return True
    
    return False


def is_good_table(
    data: List[List[str]], 
    bbox: Tuple[float, float, float, float], 
    page_width: float,
    page_height: float
) -> Tuple[bool, str, List[str]]:
    """
    质量校验：判断是否为真实表格
    
    返回: (是否通过, 拒绝原因, 命中的表头关键词)
    """
    if not data:
        return False, "empty_data", []
    
    # 清洗数据
    rows = clean_table_data(data)
    
    # 过滤完全空的行
    rows = [r for r in rows if any(cell.strip() for cell in r)]
    
    if not rows:
        return False, "all_empty_rows", []
    
    # 1. 行列下限检查
    row_count = len(rows)
    col_count = max(len(r) for r in rows) if rows else 0
    
    if row_count < config.min_rows:
        return False, f"too_few_rows({row_count}<{config.min_rows})", []
    
    if col_count < config.min_cols:
        return False, f"too_few_cols({col_count}<{config.min_cols})", []
    
    # 2. 非空单元格比例检查
    non_empty_ratio = calculate_non_empty_ratio(rows)
    if non_empty_ratio < config.min_non_empty_ratio:
        return False, f"low_density({non_empty_ratio:.2f}<{config.min_non_empty_ratio})", []
    
    # 3. bbox 形状检查
    x0, top, x1, bottom = bbox
    width = x1 - x0
    height = bottom - top
    area = width * height
    width_ratio = width / page_width if page_width > 0 else 0
    
    if width_ratio < config.min_width_ratio:
        return False, f"bbox_too_narrow({width_ratio:.2f}<{config.min_width_ratio})", []
    
    if height < config.min_height_px:
        return False, f"bbox_too_short({height:.0f}<{config.min_height_px})", []
    
    if area < config.min_area_px:
        return False, f"bbox_too_small({area:.0f}<{config.min_area_px})", []
    
    # 4. 表头格式检查 + 跨页表格检测
    header_like = is_header_like_row(rows[0]) if rows else False
    
    if not header_like:
        # 第一行不像表头，检查是否是跨页表格的续页
        if is_likely_continuation_table(rows):
            print(f"[TABLE] 检测到跨页表格续页（第一行非表头但结构合理），放行")
            return True, "", ["[跨页表格]"]
        else:
            return False, "first_row_not_header_like", []
    
    # 5. 表头关键词检查（区分强弱关键词）
    matched_keywords, keywords_valid = find_matched_header_keywords(rows)
    
    if not keywords_valid:
        # 关键词不够，但可能是跨页表格
        if is_likely_continuation_table(rows):
            print(f"[TABLE] 检测到跨页表格续页（关键词不足但结构合理），放行")
            return True, "", ["[跨页表格]"]
        
        if matched_keywords:
            return False, f"weak_keywords_only({matched_keywords})", matched_keywords
        else:
            return False, "no_header_keywords", []
    
    return True, "", matched_keywords


def extract_tables_two_phase(
    page, 
    page_num: int,
    page_width: float,
    page_height: float,
    debug_mode: bool = False
) -> Tuple[List[TableInfo], List[TableDebugInfo], List[Tuple]]:
    """
    两阶段表格提取（核心逻辑）
    
    阶段 1: 使用 find_tables() 找到候选表格的 bbox
    阶段 2: 对每个 bbox crop 页面后提取表格数据
    
    返回: (有效表格列表, Debug信息列表, bbox列表)
    """
    valid_tables: List[TableInfo] = []
    debug_infos: List[TableDebugInfo] = []
    all_bboxes: List[Tuple] = []
    
    # 主策略：lines_strict
    primary_settings = {
        "vertical_strategy": config.vertical_strategy,
        "horizontal_strategy": config.horizontal_strategy,
        "snap_tolerance": config.snap_tolerance,
        "join_tolerance": config.join_tolerance,
        "intersection_tolerance": config.intersection_tolerance,
        "edge_min_length": config.edge_min_length,
    }
    
    # 回退策略：lines（更宽松）
    fallback_settings = {
        "vertical_strategy": "lines",
        "horizontal_strategy": "lines",
        "snap_tolerance": 6,
        "join_tolerance": 6,
        "edge_min_length": 20,
    }
    
    # 最后回退：text（最宽松，但容易误识别）
    last_fallback_settings = {
        "vertical_strategy": "text",
        "horizontal_strategy": "text",
        "snap_tolerance": 8,
    }
    
    try:
        # 阶段 1: 找候选表格
        table_objects = page.find_tables(table_settings=primary_settings)
        
        # 如果主策略没找到，尝试回退
        if not table_objects:
            table_objects = page.find_tables(table_settings=fallback_settings)
        
        if not table_objects:
            return valid_tables, debug_infos, all_bboxes
        
        # 阶段 2: 对每个候选表格提取数据
        for table_obj in table_objects:
            bbox = table_obj.bbox
            all_bboxes.append(bbox)
            
            try:
                # Crop 页面到表格区域
                # 稍微扩大一点边界以确保完整提取
                x0, top, x1, bottom = bbox
                margin = 2
                crop_bbox = (
                    max(0, x0 - margin),
                    max(0, top - margin),
                    min(page_width, x1 + margin),
                    min(page_height, bottom + margin)
                )
                
                cropped = page.crop(crop_bbox)
                
                # 在 cropped 区域内提取表格
                table_data = cropped.extract_table(primary_settings)
                
                if not table_data:
                    table_data = cropped.extract_table(fallback_settings)
                
                if not table_data:
                    # 记录 debug 信息
                    if debug_mode:
                        debug_infos.append(TableDebugInfo(
                            page_number=page_num,
                            bbox=list(bbox),
                            rows=0,
                            cols=0,
                            non_empty_ratio=0,
                            matched_keywords=[],
                            rejected_reason="extraction_failed",
                            accepted=False
                        ))
                    continue
                
                # 清洗数据
                cleaned_data = clean_table_data(table_data)
                cleaned_data = [r for r in cleaned_data if any(cell.strip() for cell in r)]
                
                if not cleaned_data:
                    if debug_mode:
                        debug_infos.append(TableDebugInfo(
                            page_number=page_num,
                            bbox=list(bbox),
                            rows=0,
                            cols=0,
                            non_empty_ratio=0,
                            matched_keywords=[],
                            rejected_reason="empty_after_clean",
                            accepted=False
                        ))
                    continue
                
                # 质量校验
                is_valid, reject_reason, matched_kw = is_good_table(
                    cleaned_data, bbox, page_width, page_height
                )
                
                row_count = len(cleaned_data)
                col_count = max(len(r) for r in cleaned_data) if cleaned_data else 0
                non_empty_ratio = calculate_non_empty_ratio(cleaned_data)
                
                # 记录 debug 信息
                if debug_mode:
                    debug_infos.append(TableDebugInfo(
                        page_number=page_num,
                        bbox=list(bbox),
                        rows=row_count,
                        cols=col_count,
                        non_empty_ratio=round(non_empty_ratio, 3),
                        matched_keywords=matched_kw,
                        rejected_reason=reject_reason if not is_valid else None,
                        accepted=is_valid
                    ))
                
                if not is_valid:
                    print(f"[TABLE] 第{page_num}页表格被过滤: {reject_reason}")
                    continue
                
                # 提取表头（默认第一行，可配置）
                headers = cleaned_data[0] if cleaned_data else []
                
                # 生成 HTML
                html = generate_table_html(cleaned_data, page_num)
                
                # 构建 TableInfo
                table_info = TableInfo(
                    page_number=page_num,
                    bbox=list(bbox),
                    rows=cleaned_data,
                    headers=headers,
                    row_count=row_count,
                    col_count=col_count,
                    non_empty_ratio=round(non_empty_ratio, 3),
                    html=html
                )
                valid_tables.append(table_info)
                
                print(f"[TABLE] ✅ 第{page_num}页提取表格: {row_count}行x{col_count}列, 关键词={matched_kw}")
                
            except Exception as e:
                print(f"[TABLE] 第{page_num}页表格提取异常: {e}")
                if debug_mode:
                    debug_infos.append(TableDebugInfo(
                        page_number=page_num,
                        bbox=list(bbox),
                        rows=0,
                        cols=0,
                        non_empty_ratio=0,
                        matched_keywords=[],
                        rejected_reason=f"exception: {str(e)[:50]}",
                        accepted=False
                    ))
                continue
    
    except Exception as e:
        print(f"[TABLE] 第{page_num}页 find_tables 异常: {e}")
    
    return valid_tables, debug_infos, all_bboxes


def generate_table_html(rows: List[List[str]], page_num: int = -1) -> str:
    """生成表格 HTML"""
    if not rows:
        return ""
    
    # 检测表头
    first_row = rows[0] if rows else []
    is_header_row = all(len(cell) < 40 for cell in first_row) if first_row else False
    
    html_parts = ['<table class="pdf-table">']
    
    for row_idx, row in enumerate(rows):
        tag = 'th' if row_idx == 0 and is_header_row else 'td'
        
        html_parts.append('<tr>')
        for cell in row:
            # 清理单元格内容：去除多余换行，规范化空白
            cell_clean = cell.strip()
            # 将多个连续换行替换为单个换行
            cell_clean = re.sub(r'\n{2,}', '\n', cell_clean)
            # 换行转为 <br>，但不要在结尾添加
            cell_html = cell_clean.replace('\n', '<br>') if '\n' in cell_clean else cell_clean
            # 去除结尾的 <br>
            cell_html = re.sub(r'(<br>)+$', '', cell_html)
            html_parts.append(f'<{tag}>{cell_html}</{tag}>')
        html_parts.append('</tr>')
    
    html_parts.append('</table>')
    
    return '\n'.join(html_parts)


# ==================== 主提取函数 ====================

def extract_tables_and_text_from_pdf(
    pdf_bytes: bytes,
    debug_mode: bool = False
) -> Tuple[Dict[int, List[str]], Dict[int, str], List[TableInfo], List[TableDebugInfo]]:
    """
    使用优化的两阶段方法提取 PDF 中的表格和文本
    
    返回:
        - page_tables: {页码: [表格HTML列表]}
        - page_texts_clean: {页码: 过滤掉表格后的文本}
        - all_tables: 所有有效表格的结构化信息
        - all_debug: Debug 信息
    """
    page_tables: Dict[int, List[str]] = {}
    page_texts_clean: Dict[int, str] = {}
    all_tables: List[TableInfo] = []
    all_debug: List[TableDebugInfo] = []
    
    HEADER_RATIO = 0.08
    FOOTER_RATIO = 0.08
    
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page_num, page in enumerate(pdf.pages):
                page_width = page.width
                page_height = page.height
                header_threshold = page_height * HEADER_RATIO
                footer_threshold = page_height * (1 - FOOTER_RATIO)
                
                # 可选：疑似表格页快速判定
                if config.enable_table_page_filter:
                    if not is_table_page_candidate(page, config.table_page_sample_chars):
                        # 不是表格页，只提取文本
                        page_texts_clean[page_num] = page.extract_text() or ""
                        continue
                
                # 两阶段表格提取
                tables, debug_infos, table_bboxes = extract_tables_two_phase(
                    page, page_num, page_width, page_height, debug_mode
                )
                
                # 收集结果
                if tables:
                    page_tables[page_num] = [t.html for t in tables]
                    all_tables.extend(tables)
                
                if debug_infos:
                    all_debug.extend(debug_infos)
                
                # 提取文本（排除表格区域和页眉页脚）
                def should_keep(obj):
                    if 'top' not in obj:
                        return True
                    
                    obj_top = obj.get('top', 0)
                    obj_bottom = obj.get('bottom', obj_top)
                    obj_center_y = (obj_top + obj_bottom) / 2
                    
                    # 排除页眉页脚
                    if obj_center_y < header_threshold:
                        return False
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
                
                try:
                    filtered_page = page.filter(should_keep)
                    page_texts_clean[page_num] = filtered_page.extract_text() or ""
                except:
                    page_texts_clean[page_num] = page.extract_text() or ""
    
    except Exception as e:
        print(f"[ERROR] pdfplumber 提取失败: {e}")
        import traceback
        traceback.print_exc()
    
    print(f"[TABLE] 共提取 {len(all_tables)} 个有效表格")
    
    return page_tables, page_texts_clean, all_tables, all_debug


# ==================== 章节识别逻辑 ====================

CHINESE_NUM_MAP = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
    '十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15,
    '十六': 16, '十七': 17, '十八': 18, '十九': 19, '二十': 20
}


def get_chapter_number(title: str) -> Optional[int]:
    """提取章节编号"""
    match = re.search(r'第\s*([一二三四五六七八九十]+|\d+)\s*[章节篇部]', title)
    if not match:
        return None
    
    num_str = match.group(1)
    if num_str.isdigit():
        return int(num_str)
    return CHINESE_NUM_MAP.get(num_str)


def format_text_to_html(text: str) -> str:
    """将纯文本转换为 HTML"""
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


def extract_pdf_structure(
    pdf_bytes: bytes, 
    filename: str,
    debug_mode: bool = False
) -> ParsedDocument:
    """提取 PDF 文档结构"""
    
    # 使用优化的表格提取
    print("[DEBUG] 开始两阶段表格提取...")
    page_tables, pdfplumber_texts, all_tables, all_debug = extract_tables_and_text_from_pdf(
        pdf_bytes, debug_mode
    )
    
    # 打开 PDF（使用 PyMuPDF 识别章节结构）
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    
    page_texts = []
    page_clean_htmls = []
    chapter_matches = []
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        full_text = page.get_text()
        page_texts.append(full_text)
        
        clean_text = pdfplumber_texts.get(page_num, full_text)
        
        # 识别章节
        lines = full_text.split('\n')
        for line_num, line in enumerate(lines):
            line_stripped = line.strip()
            if not line_stripped:
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
        
        # 过滤页码
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
    
    # 章节处理逻辑
    def extract_chapter_num_str(title: str) -> Optional[str]:
        match = re.search(r'第\s*([一二三四五六七八九十\d]+)\s*[章节篇部]', title)
        return match.group(1) if match else None
    
    sorted_chapters = sorted(chapter_matches, key=lambda x: (x['page'], x.get('line', 0)))
    
    # 检测目录结束
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
        page_chapter_count = {}
        for ch in sorted_chapters:
            p = ch['page']
            page_chapter_count[p] = page_chapter_count.get(p, 0) + 1
        toc_pages = {p for p, count in page_chapter_count.items() if count >= 3}
        filtered_chapters = [ch for ch in sorted_chapters if ch['page'] not in toc_pages]
    
    # 去重
    seen_titles = set()
    unique_chapters = []
    for ch in filtered_chapters:
        normalized = ch['title'].replace(' ', '').lower()
        if normalized not in seen_titles:
            seen_titles.add(normalized)
            unique_chapters.append(ch)
    
    # 连续性检查
    chapters_with_num = []
    for ch in unique_chapters:
        num = get_chapter_number(ch['title'])
        if num is not None:
            chapters_with_num.append((num, ch))
    
    chapters_with_num.sort(key=lambda x: x[0])
    
    continuous_chapters = []
    if chapters_with_num:
        expected_num = chapters_with_num[0][0]
        for num, ch in chapters_with_num:
            if expected_num <= num <= expected_num + 2:
                continuous_chapters.append(ch)
                expected_num = num + 1
    
    final_chapters = continuous_chapters if len(continuous_chapters) >= 2 else unique_chapters
    final_chapters.sort(key=lambda x: (x['page'], x.get('line', 0)))
    
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
        rawHtml=raw_html,
        tables=all_tables if debug_mode else None,
        debug_tables=all_debug if debug_mode else None
    )


# ==================== API 路由 ====================

@app.get("/")
async def root():
    return {
        "message": "PDF Parser API v5.0.0",
        "features": [
            "两阶段表格提取",
            "伪表格过滤",
            "Debug 模式",
            "可调参数"
        ]
    }


@app.post("/api/parse-pdf", response_model=ParsedDocument)
async def parse_pdf(
    file: UploadFile = File(...),
    debug: bool = Query(False, description="开启 Debug 模式，返回表格提取详情")
):
    """
    解析 PDF 文件
    
    - **file**: PDF 文件
    - **debug**: 是否开启 Debug 模式（返回表格提取详情）
    """
    if not file.filename.lower().endswith('.pdf'):
        raise HTTPException(status_code=400, detail="只支持 PDF 文件")
    
    try:
        pdf_bytes = await file.read()
        
        # 合并 debug 参数
        use_debug = debug or config.debug_mode
        
        result = extract_pdf_structure(pdf_bytes, file.filename, use_debug)
        
        return result
    
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"PDF 解析失败: {str(e)}")


@app.get("/api/config")
async def get_config():
    """获取当前表格提取配置"""
    return {
        "vertical_strategy": config.vertical_strategy,
        "horizontal_strategy": config.horizontal_strategy,
        "snap_tolerance": config.snap_tolerance,
        "join_tolerance": config.join_tolerance,
        "edge_min_length": config.edge_min_length,
        "min_rows": config.min_rows,
        "min_cols": config.min_cols,
        "min_non_empty_ratio": config.min_non_empty_ratio,
        "min_width_ratio": config.min_width_ratio,
        "min_height_px": config.min_height_px,
        "header_keywords": config.header_keywords[:10],  # 只返回前10个
        "enable_table_page_filter": config.enable_table_page_filter,
        "debug_mode": config.debug_mode
    }


@app.post("/api/config")
async def update_config(
    edge_min_length: Optional[int] = None,
    min_rows: Optional[int] = None,
    min_cols: Optional[int] = None,
    min_non_empty_ratio: Optional[float] = None,
    min_width_ratio: Optional[float] = None,
    enable_table_page_filter: Optional[bool] = None,
    debug_mode: Optional[bool] = None
):
    """动态更新配置参数（用于调试）"""
    if edge_min_length is not None:
        config.edge_min_length = edge_min_length
    if min_rows is not None:
        config.min_rows = min_rows
    if min_cols is not None:
        config.min_cols = min_cols
    if min_non_empty_ratio is not None:
        config.min_non_empty_ratio = min_non_empty_ratio
    if min_width_ratio is not None:
        config.min_width_ratio = min_width_ratio
    if enable_table_page_filter is not None:
        config.enable_table_page_filter = enable_table_page_filter
    if debug_mode is not None:
        config.debug_mode = debug_mode
    
    return {"message": "配置已更新", "config": await get_config()}


@app.get("/health")
async def health_check():
    return {"status": "healthy", "version": "6.0.0"}


# ==================== AI 代理接口 ====================

class AIAnalyzeRequest(BaseModel):
    """AI 分析请求"""
    systemPrompt: str
    userPrompt: str
    maxRetries: int = 3


class AIAnalyzeResponse(BaseModel):
    """AI 分析响应"""
    success: bool
    text: Optional[str] = None
    error: Optional[str] = None
    model: str = GEMINI_MODEL


@app.post("/api/ai-analyze", response_model=AIAnalyzeResponse)
async def ai_analyze(request: AIAnalyzeRequest):
    """
    AI 分析代理接口 - 避免前端跨域问题
    
    - **systemPrompt**: 系统提示词
    - **userPrompt**: 用户提示词
    - **maxRetries**: 最大重试次数（默认3次）
    """
    headers = {
        "Content-Type": "application/json",
        "X-goog-api-key": GEMINI_API_KEY
    }
    
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": request.userPrompt}
                ]
            }
        ],
        "systemInstruction": {
            "parts": [
                {"text": request.systemPrompt}
            ]
        },
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 8192
        }
    }
    
    last_error = None
    
    for attempt in range(request.maxRetries):
        try:
            print(f"[AI] Calling Gemini API (attempt {attempt + 1})...")
            print(f"[AI] Request size: {len(request.systemPrompt) + len(request.userPrompt)} chars")
            
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    GEMINI_API_URL,
                    headers=headers,
                    json=payload
                )
                
                if response.status_code == 200:
                    result = response.json()
                    
                    # 提取文本响应
                    candidates = result.get("candidates", [])
                    if candidates:
                        content = candidates[0].get("content", {})
                        parts = content.get("parts", [])
                        if parts:
                            text = parts[0].get("text", "")
                            print(f"[AI] SUCCESS - Response length: {len(text)} chars")
                            return AIAnalyzeResponse(
                                success=True,
                                text=text,
                                model=GEMINI_MODEL
                            )
                    
                    print(f"[AI] WARNING - Unexpected response format: {result}")
                    last_error = "响应格式异常"
                    
                else:
                    error_msg = f"HTTP {response.status_code}: {response.text[:500]}"
                    print(f"[AI] ERROR - Request failed: {error_msg}")
                    last_error = error_msg
                    
                    # 429 (限流) 或 5xx 错误可以重试
                    if response.status_code in [429, 500, 502, 503, 504]:
                        delay = (attempt + 1) * 2
                        print(f"[AI] Waiting {delay}s before retry...")
                        import asyncio
                        await asyncio.sleep(delay)
                        continue
                    else:
                        # 其他错误不重试
                        break
                        
        except httpx.TimeoutException:
            last_error = "请求超时"
            print(f"[AI] TIMEOUT - Attempt {attempt + 1}")
            continue
            
        except Exception as e:
            last_error = str(e)
            print(f"[AI] EXCEPTION: {e}")
            continue
    
    print(f"[AI] FAILED: {last_error}")
    return AIAnalyzeResponse(
        success=False,
        error=last_error,
        model=GEMINI_MODEL
    )


# ==================== 启动服务 ====================

if __name__ == "__main__":
    import uvicorn
    print("=" * 60)
    print("  PDF Parser API v5.0.0 - 优化版")
    print("  核心改进：")
    print("  - 两阶段表格提取（find_tables -> crop -> extract）")
    print("  - 伪表格过滤（行列/密度/bbox/关键词）")
    print("  - Debug 模式（?debug=true）")
    print("  - 可调参数（/api/config）")
    print("=" * 60)
    print("  http://localhost:8000")
    print("  API Docs: http://localhost:8000/docs")
    print("=" * 60)
    uvicorn.run(app, host="0.0.0.0", port=8000)
