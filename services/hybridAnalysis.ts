import { GoogleGenAI } from "@google/genai";
import { 
  ParsedDocument, 
  KeyInformation, 
  ConflictField, 
  BasicInfo,
  InvalidationRisk,
  RawRiskCandidate,
  AuditLogic
} from '../types';

// ==================== 常量定义 ====================

// 高风险关键词（用于 Regex 撒网）
const RISK_KEYWORDS = [
  '废标', '无效', '拒绝', '必须', '★', '▲', '☆', '△',
  '资格', '实质性', '否决', '不得', '不允许', '禁止',
  '强制', '应当', '须', '不予受理', '取消资格', '失效'
];

// 章节标题关键词映射
const CHAPTER_KEYWORDS = {
  notice: ['招标公告', '采购公告', '邀请书', '公告'],
  instructions: ['投标人须知', '须知', '投标须知', '说明'],
  scoring: ['评分', '评审', '打分', '评标'],
  technical: ['采购需求', '技术要求', '技术需求', '技术规格', '技术参数', '设备配置', '货物需求', '项目需求', '服务需求'],
  format: ['投标文件格式', '响应文件格式', '文件组成', '投标文件的组成', '响应文件组成', '投标文件编制'],
  qualification: ['资格', '资质', '条件']
};

// 需要排除的章节关键词（避免误匹配）
const EXCLUDE_KEYWORDS = {
  format: ['合同', '协议', '范本', '草案'],
  technical: ['合同', '协议']
};

// ==================== Step A: Regex 撒网（风险候选项）====================

function extractRiskCandidates(doc: ParsedDocument): RawRiskCandidate[] {
  const candidates: RawRiskCandidate[] = [];
  
  for (const chapter of doc.chapters) {
    // 移除 HTML 标签，获取纯文本
    const plainText = chapter.content.replace(/<[^>]*>/g, '');
    
    // 按段落分割（以句号、换行等为界）
    const paragraphs = plainText.split(/[。\n\r]+/).filter(p => p.trim().length > 10);
    
    for (const para of paragraphs) {
      for (const keyword of RISK_KEYWORDS) {
        if (para.includes(keyword)) {
          // 避免重复添加同一段落
          if (!candidates.some(c => c.text === para.trim())) {
            candidates.push({
              text: para.trim(),
              chapterTitle: chapter.title,
              matchedKeyword: keyword
            });
          }
          break; // 一个段落匹配一个关键词即可
        }
      }
    }
  }
  
  return candidates;
}

// ==================== Step B: 基本信息 Regex 扫描 ====================

interface RegexInfo {
  projectName: string | null;
  projectCode: string | null;
  purchaser: string | null;
  agency: string | null;
  deadline: string | null;
  budget: string | null;
  location: string | null;
  validity: string | null;
  bond: string | null;
}

function extractBasicInfoByRegex(rawHtml: string): RegexInfo {
  // 移除 HTML 标签
  const text = rawHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  
  const extract = (patterns: RegExp[]): string | null => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    return null;
  };
  
  return {
    // 项目名称
    projectName: extract([
      /项目名称[：:]\s*([^，。\n]{5,100})/,
      /采购项目[：:]\s*([^，。\n]{5,100})/,
      /工程名称[：:]\s*([^，。\n]{5,100})/
    ]),
    
    // 项目编号
    projectCode: extract([
      /项目编号[：:]\s*([A-Za-z0-9\-_]{5,50})/,
      /采购编号[：:]\s*([A-Za-z0-9\-_]{5,50})/,
      /招标编号[：:]\s*([A-Za-z0-9\-_]{5,50})/
    ]),
    
    // 采购人
    purchaser: extract([
      /采购人[：:]\s*([^，。\n]{2,50})/,
      /招标人[：:]\s*([^，。\n]{2,50})/,
      /业主单位[：:]\s*([^，。\n]{2,50})/
    ]),
    
    // 代理机构
    agency: extract([
      /代理机构[：:]\s*([^，。\n]{2,80})/,
      /招标代理[：:]\s*([^，。\n]{2,80})/,
      /采购代理[：:]\s*([^，。\n]{2,80})/
    ]),
    
    // 投标截止时间
    deadline: extract([
      /投标截止时间[：:]\s*([\d年月日时分秒\s:：\-]+)/,
      /截止时间[：:]\s*([\d年月日时分秒\s:：\-]+)/,
      /开标时间[：:]\s*([\d年月日时分秒\s:：\-]+)/,
      /(\d{4}[\-\/年]\d{1,2}[\-\/月]\d{1,2}日?\s*\d{1,2}[：:]\d{2})/
    ]),
    
    // 预算金额（处理万元、元等单位）
    budget: extract([
      /预算金额[：:]\s*([\d,，.]+\s*万?元)/,
      /最高限价[：:]\s*([\d,，.]+\s*万?元)/,
      /采购预算[：:]\s*([\d,，.]+\s*万?元)/,
      /预算[：:]\s*([\d,，.]+\s*万?元)/,
      /控制价[：:]\s*([\d,，.]+\s*万?元)/
    ]),
    
    // 开标地点
    location: extract([
      /开标地点[：:]\s*([^，。\n]{5,100})/,
      /投标地点[：:]\s*([^，。\n]{5,100})/,
      /会议室[：:]\s*([^，。\n]{5,100})/
    ]),
    
    // 投标有效期
    validity: extract([
      /投标有效期[：:]\s*([\d]+\s*[天日个月年]+)/,
      /有效期[：:]\s*([\d]+\s*[天日个月年]+)/
    ]),
    
    // 保证金
    bond: extract([
      /投标保证金[：:]\s*([\d,，.]+\s*万?元|不[需提交要求]+)/,
      /保证金[：:]\s*([\d,，.]+\s*万?元|不[需提交要求]+)/
    ])
  };
}

// ==================== Step C: HTML 切片提取 ====================

interface HtmlSlices {
  scoringTableHtml: string | null;
  technicalChapterHtml: string | null;
  formatChapterHtml: string | null;
  // 记录是否通过关键词匹配成功
  matchStatus: {
    scoring: boolean;
    technical: boolean;
    format: boolean;
  };
}

function extractHtmlSlices(doc: ParsedDocument): HtmlSlices {
  // 带排除逻辑的章节查找
  const findChapterHtml = (
    keywords: string[], 
    excludeKeywords: string[] = []
  ): string | null => {
    for (const chapter of doc.chapters) {
      // 检查是否包含排除关键词
      const shouldExclude = excludeKeywords.some(ek => chapter.title.includes(ek));
      if (shouldExclude) continue;
      
      // 检查是否匹配目标关键词
      for (const kw of keywords) {
        if (chapter.title.includes(kw)) {
          return chapter.content;
        }
      }
    }
    return null;
  };
  
  const scoringTableHtml = findChapterHtml(CHAPTER_KEYWORDS.scoring);
  const technicalChapterHtml = findChapterHtml(
    CHAPTER_KEYWORDS.technical, 
    EXCLUDE_KEYWORDS.technical
  );
  const formatChapterHtml = findChapterHtml(
    CHAPTER_KEYWORDS.format, 
    EXCLUDE_KEYWORDS.format
  );
  
  return {
    scoringTableHtml,
    technicalChapterHtml,
    formatChapterHtml,
    matchStatus: {
      scoring: scoringTableHtml !== null,
      technical: technicalChapterHtml !== null,
      format: formatChapterHtml !== null
    }
  };
}

// 根据章节标题查找章节内容
function findChapterByTitle(doc: ParsedDocument, title: string | null | undefined): string | null {
  if (!title) return null;
  
  // 精确匹配
  const exactMatch = doc.chapters.find(c => c.title === title);
  if (exactMatch) return exactMatch.content;
  
  // 模糊匹配（包含关系）
  const fuzzyMatch = doc.chapters.find(c => 
    c.title.includes(title) || title.includes(c.title)
  );
  if (fuzzyMatch) return fuzzyMatch.content;
  
  return null;
}

// ==================== Step D: AI 审计分析 ====================

// AI 推荐的章节映射
interface ChapterMapping {
  technical: string | null;   // 技术/采购需求章节标题
  scoring: string | null;     // 评分标准章节标题
  format: string | null;      // 格式要求章节标题
}

interface AIAnalysisResult {
  basicInfo: Partial<RegexInfo>;
  filteredRisks: Array<{
    originalText: string;
    chapterTitle: string;
    analysis: string;
    severity: 'high' | 'medium';
    category: 'qualification' | 'commercial' | 'technical' | 'document' | 'timeline' | 'other';
  }>;
  auditLogic: AuditLogic;
  chapterMapping?: ChapterMapping;  // AI 推荐的章节映射
}

async function performAIAnalysis(
  doc: ParsedDocument,
  rawRiskCandidates: RawRiskCandidate[],
  apiKey: string
): Promise<AIAnalysisResult | null> {
  try {
    const ai = new GoogleGenAI({ apiKey });
    
    // 获取招标公告和投标须知章节的内容
    const noticeChapter = doc.chapters.find(c => 
      CHAPTER_KEYWORDS.notice.some(kw => c.title.includes(kw))
    );
    const instructionsChapter = doc.chapters.find(c => 
      CHAPTER_KEYWORDS.instructions.some(kw => c.title.includes(kw))
    );
    
    const noticeText = noticeChapter 
      ? noticeChapter.content.replace(/<[^>]*>/g, '').substring(0, 8000)
      : '';
    const instructionsText = instructionsChapter 
      ? instructionsChapter.content.replace(/<[^>]*>/g, '').substring(0, 8000)
      : '';
    
    // 构建风险候选项列表（限制数量避免超出 token）
    const riskList = rawRiskCandidates.slice(0, 50).map((r, i) => 
      `[${i + 1}] 章节「${r.chapterTitle}」: ${r.text.substring(0, 200)}`
    ).join('\n');
    
    const systemPrompt = `# Role: 资深标书合规审计师 (Senior Bid Compliance Auditor)

## Core Objective
你是"防御体系"的构建者。请基于提供的【候选条款列表】(rawRiskCandidates)，输出一份能够直接用于"封标检查"的深度审计报告。
你的思维模式是"零容忍"、"穷尽风险"和"拒绝歧义"。

## Audit Workflow (深度审计工作流):
1. **显性废标项 (Explicit Disqualification)**:
   - 重点识别带"★"或"▲"的参数（必须保留具体参数值，如"吞吐量≥20G"，不能只写"满足技术参数"）。
   - 识别明确含有"无效投标"、"拒绝"、"否决"、"未按要求"字样的条款。
2. **隐性通用风险 (Implicit General Risks)**:
   - 基于法律常识检查：签字盖章要求、包装密封要求、联合体限制、报价唯一性、必须提供的资质证书（审计单/社保/纳税）。
   - 即使是通用常识（如"未按规定签字"），只要原文提及后果为废标，必须列出。

## ⚠️ Negative Constraints (关键降噪规则):
- **忽略纯操作指引**：如"如何登录平台"、"CA解密步骤"、"上传文件格式"等常规电子标流程，除非明确提及"做不到即废标"。
- **忽略无意义复读**：如"不得行贿"等法律条文复述。

## Risk Categories (风险分类):
每条风险必须归入以下分类之一：
- **qualification**: 资格要求（资质证书、营业执照、审计报告、信用中国、联合体限制、许可证）
- **commercial**: 商务条款（报价要求、付款条件、保证金、业绩合同、人员要求）
- **technical**: 技术参数（★/▲ 标记参数、实质性响应要求、技术偏离）
- **document**: 文件规范（签字盖章、密封包装、文件格式、装订要求）
- **timeline**: 时间要求（投标有效期、交货期、响应时间、工期要求）
- **other**: 其他要求

## Chapter Mapping (章节智能识别):
请根据章节列表，识别出以下类型的章节（返回完整的章节标题）：
- **technical**: 技术要求/采购需求/货物需求等章节
- **scoring**: 评分标准/评标办法/评审办法等章节
- **format**: 投标文件格式/响应文件格式等章节

## Output Format (JSON Only):
必须返回严格的 JSON 格式（不要有任何其他文字）：
{
  "basicInfo": {
    "projectName": "项目名称或null",
    "projectCode": "项目编号或null",
    "purchaser": "采购人或null",
    "agency": "代理机构或null",
    "deadline": "投标截止时间或null",
    "budget": "预算金额或null",
    "location": "开标地点或null",
    "validity": "投标有效期或null",
    "bond": "保证金或null"
  },
  "filteredRisks": [
    {
      "originalText": "完整的原始条款文本（保留具体参数值）",
      "chapterTitle": "来源章节标题（如：第三章 投标人须知）",
      "analysis": "简要说明为什么这是废标风险（如：显性★条款 或 隐性签章要求）",
      "severity": "high 或 medium",
      "category": "qualification/commercial/technical/document/timeline/other"
    }
  ],
  "auditLogic": {
    "symbolDef": "★/▲符号在文档中的定义说明",
    "chapterRef": "定义废标条款的章节名称",
    "rejectKeywords": ["关键废标词汇数组"]
  },
  "chapterMapping": {
    "technical": "技术/采购需求章节的完整标题或null",
    "scoring": "评分标准章节的完整标题或null",
    "format": "格式要求章节的完整标题或null"
  }
}`;

    // 构建章节列表供 AI 识别
    const chapterList = doc.chapters.map(c => c.title).join('\n- ');

    const userPrompt = `请分析以下招标文件内容：

## 文档章节列表（请识别各章节类型）
- ${chapterList}

## 招标公告内容
${noticeText || '（未找到招标公告章节）'}

## 投标人须知内容
${instructionsText || '（未找到投标须知章节）'}

## 风险候选条款（请过滤并分析）
${riskList || '（未发现风险候选条款）'}

请严格按照 JSON 格式返回分析结果，包括 chapterMapping 字段。`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
      },
    });
    
    const responseText = response.text || '';
    
    // 尝试提取 JSON
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed as AIAnalysisResult;
    }
    
    return null;
  } catch (error) {
    console.error('AI Analysis Error:', error);
    return null;
  }
}

// ==================== Step E: 合成与冲突解决 ====================

function createConflictField(
  regexValue: string | null,
  aiValue: string | null | undefined,
  regexSource: string,
  aiSource: string
): ConflictField {
  const candidates: Array<{ value: string; source: string }> = [];
  
  if (regexValue) {
    candidates.push({ value: regexValue, source: regexSource });
  }
  if (aiValue && aiValue !== regexValue) {
    candidates.push({ value: aiValue, source: aiSource });
  }
  
  // 标准化比较
  const normalizedRegex = regexValue?.replace(/\s+/g, '').toLowerCase() || '';
  const normalizedAI = aiValue?.replace(/\s+/g, '').toLowerCase() || '';
  
  const isConflict = !!(regexValue && aiValue && normalizedRegex !== normalizedAI);
  
  return {
    value: regexValue || aiValue || '未识别',
    isConflict,
    candidates
  };
}

function synthesizeResults(
  doc: ParsedDocument,
  regexInfo: RegexInfo,
  aiResult: AIAnalysisResult | null,
  rawRiskCandidates: RawRiskCandidate[],
  htmlSlices: HtmlSlices
): KeyInformation {
  const aiInfo = aiResult?.basicInfo || {};
  
  const basicInfo: BasicInfo = {
    projectName: createConflictField(regexInfo.projectName, aiInfo.projectName, 'Regex(全文扫描)', 'AI(智能识别)'),
    projectCode: createConflictField(regexInfo.projectCode, aiInfo.projectCode, 'Regex(全文扫描)', 'AI(智能识别)'),
    purchaser: createConflictField(regexInfo.purchaser, aiInfo.purchaser, 'Regex(全文扫描)', 'AI(智能识别)'),
    agency: createConflictField(regexInfo.agency, aiInfo.agency, 'Regex(全文扫描)', 'AI(智能识别)'),
    deadline: createConflictField(regexInfo.deadline, aiInfo.deadline, 'Regex(全文扫描)', 'AI(智能识别)'),
    budget: createConflictField(regexInfo.budget, aiInfo.budget, 'Regex(全文扫描)', 'AI(智能识别)'),
    location: createConflictField(regexInfo.location, aiInfo.location, 'Regex(全文扫描)', 'AI(智能识别)'),
    validity: createConflictField(regexInfo.validity, aiInfo.validity, 'Regex(全文扫描)', 'AI(智能识别)'),
    bond: createConflictField(regexInfo.bond, aiInfo.bond, 'Regex(全文扫描)', 'AI(智能识别)')
  };
  
  // 处理废标风险项
  let invalidationRisks: InvalidationRisk[] = [];
  
  if (aiResult?.filteredRisks && aiResult.filteredRisks.length > 0) {
    // 使用 AI 过滤后的结果（直接使用 AI 返回的分类和章节信息）
    invalidationRisks = aiResult.filteredRisks.map(r => ({
      originalText: r.originalText,
      chapterTitle: r.chapterTitle || rawRiskCandidates.find(c => 
        c.text.includes(r.originalText.substring(0, 20))
      )?.chapterTitle || '未知章节',
      aiAnalysis: r.analysis,
      severity: r.severity,
      category: r.category || 'other'
    }));
  } else {
    // AI 失败时，回退到原始 Regex 结果（标记为需人工审核）
    invalidationRisks = rawRiskCandidates.slice(0, 20).map(r => ({
      originalText: r.text,
      chapterTitle: r.chapterTitle,
      aiAnalysis: `[AI分析失败] 匹配关键词: ${r.matchedKeyword}，请人工审核`,
      severity: 'medium' as const,
      category: 'other' as const
    }));
  }
  
  // 审计逻辑
  const auditLogic: AuditLogic = aiResult?.auditLogic || {
    symbolDef: '未能识别符号定义',
    chapterRef: '未能识别相关章节',
    rejectKeywords: RISK_KEYWORDS.slice(0, 5)
  };
  
  // === 组合方案：优先关键词匹配，失败时用 AI 推荐 ===
  const aiMapping = aiResult?.chapterMapping;
  
  // 评分标准
  let scoringTableHtml = htmlSlices.scoringTableHtml;
  if (!scoringTableHtml && aiMapping?.scoring) {
    console.log(`   📌 评分标准：关键词未匹配，使用 AI 推荐: ${aiMapping.scoring}`);
    scoringTableHtml = findChapterByTitle(doc, aiMapping.scoring);
  }
  
  // 技术要求
  let technicalChapterHtml = htmlSlices.technicalChapterHtml;
  if (!technicalChapterHtml && aiMapping?.technical) {
    console.log(`   📌 技术要求：关键词未匹配，使用 AI 推荐: ${aiMapping.technical}`);
    technicalChapterHtml = findChapterByTitle(doc, aiMapping.technical);
  }
  
  // 格式要求
  let formatChapterHtml = htmlSlices.formatChapterHtml;
  if (!formatChapterHtml && aiMapping?.format) {
    console.log(`   📌 格式要求：关键词未匹配，使用 AI 推荐: ${aiMapping.format}`);
    formatChapterHtml = findChapterByTitle(doc, aiMapping.format);
  }

  return {
    basicInfo,
    invalidationRisks,
    auditLogic,
    scoringTableHtml,
    technicalChapterHtml,
    formatChapterHtml
  };
}

// ==================== 主函数：混合分析 ====================

export async function analyzeBidDocument(
  doc: ParsedDocument,
  apiKey: string
): Promise<KeyInformation> {
  console.log('🔍 Step A: Regex 撒网 - 提取风险候选项...');
  const rawRiskCandidates = extractRiskCandidates(doc);
  console.log(`   找到 ${rawRiskCandidates.length} 个风险候选项`);
  
  console.log('📋 Step B: Regex 扫描 - 提取基本信息...');
  const regexInfo = extractBasicInfoByRegex(doc.rawHtml);
  console.log('   基本信息提取完成');
  
  console.log('✂️ Step C: HTML 切片 - 提取关键章节...');
  const htmlSlices = extractHtmlSlices(doc);
  console.log('   HTML 切片完成');
  
  console.log('🤖 Step D: AI 审计分析...');
  const aiResult = await performAIAnalysis(doc, rawRiskCandidates, apiKey);
  console.log(aiResult ? '   AI 分析成功' : '   AI 分析失败，使用回退方案');
  
  console.log('🔗 Step E: 合成与冲突解决...');
  const result = synthesizeResults(doc, regexInfo, aiResult, rawRiskCandidates, htmlSlices);
  console.log('   分析完成！');
  
  return result;
}

export { extractRiskCandidates, extractBasicInfoByRegex };

