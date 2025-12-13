import { ParsedDocument } from '../types';

// 后端 API 地址
const PDF_API_URL = (import.meta as any).env?.VITE_PDF_API_URL || 'http://localhost:8000';

/**
 * PDF 文档解析器 - 调用 Python 后端
 * 
 * 后端使用 PyMuPDF 提取 PDF 结构化内容
 */
export async function extractPdfStructure(file: File): Promise<ParsedDocument> {
  console.log('📤 [PDF Parser] 调用后端 API:', PDF_API_URL);
  
  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch(`${PDF_API_URL}/api/parse-pdf`, {
      method: 'POST',
      body: formData,
    });

    console.log('📥 [PDF Parser] 后端响应状态:', response.status);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: '未知错误' }));
      throw new Error(error.detail || `HTTP ${response.status}`);
    }

    const result: ParsedDocument = await response.json();
    console.log('✅ [PDF Parser] 解析成功，章节数:', result.chapters.length);
    console.log('📑 [PDF Parser] 章节列表:', result.chapters.map(c => c.title));
    return result;

  } catch (error: any) {
    // 如果后端不可用，给出友好提示
    if (error.message?.includes('fetch') || error.message?.includes('network')) {
      throw new Error('PDF 解析服务未启动，请先运行后端服务：\n\ncd backend && python main.py');
    }
    throw error;
  }
}
