import { 
  ParsedDocument, 
  KeyInformation, 
  ConflictField, 
  BasicInfo,
  InvalidationRisk,
  RawRiskCandidate,
  AuditLogic
} from '../types';

// ==================== 后端 AI 代理配置 ====================
const AI_PROXY_URL = 'http://localhost:8000/api/ai-analyze';

// ==================== 常量定义 ====================

// 高风险关键词（用于 Regex 撒网）
const RISK_KEYWORDS = [
  '废标', '无效', '拒绝', '★', '▲', '☆', '△', '*', '※',
  '实质性', '否决', '不得', '不允许', '禁止',
  '不予受理', '取消资格', '失效'
];

// 章节标题关键词映射
const CHAPTER_KEYWORDS = {
  notice: ['招标公告', '采购公告', '邀请书', '公告'],
  instructions: ['投标人须知', '须知', '投标须知', '说明'],
  scoring: ['评分', '评审', '打分', '评标'],
  technical: ['技术要求', '技术需求', '技术规格', '技术参数', '设备配置', '货物需求'],
  format: ['投标文件格式', '响应文件格式', '文件组成', '投标文件的组成', '响应文件组成', '投标文件编制'],
  qualification: ['资格', '资质', '条件']
};

// 需要排除的章节关键词（避免误匹配）
const EXCLUDE_KEYWORDS = {
  format: ['合同', '协议', '范本', '草案'],
  technical: ['合同', '协议']
};

// ==================== Step A: Regex 撒网（风险候选项）====================

// ★/▲ 符号的正则模式（匹配包含这些符号的完整条款）
const STAR_PATTERN = /[★▲☆△※\*][^\n]*(?:[\n][^\n★▲☆△※\*]*)?/g;

function extractRiskCandidates(doc: ParsedDocument): RawRiskCandidate[] {
  const candidates: RawRiskCandidate[] = [];
  const seenTexts = new Set<string>();
  
  for (const chapter of doc.chapters) {
    // 移除 HTML 标签，获取纯文本
    const plainText = chapter.content.replace(/<[^>]*>/g, '');
    
    // === 专门提取 ★/▲ 符号条款 ===
    // 这些符号通常标记关键参数，需要完整提取
    const starMatches = plainText.match(STAR_PATTERN) || [];
    for (const match of starMatches) {
      const text = match.trim();
      if (text.length > 5 && text.length < 500 && !seenTexts.has(text)) {
        seenTexts.add(text);
        // 判断具体匹配到哪个符号
        const matchedSymbol = ['★', '▲', '☆', '△', '※', '*'].find(s => text.includes(s)) || '★';
        candidates.push({
          text: text,
          chapterTitle: chapter.title,
          matchedKeyword: matchedSymbol
        });
      }
    }
    
    // === 按段落分割提取其他风险关键词 ===
    // 使用更灵活的分割：句号、分号、换行
    const paragraphs = plainText.split(/[。；\n\r]+/).filter(p => p.trim().length > 10);
    
    for (const para of paragraphs) {
      const trimmedPara = para.trim();
      
      // 跳过已通过★模式提取的内容
      if (seenTexts.has(trimmedPara)) continue;
      
      for (const keyword of RISK_KEYWORDS) {
        if (trimmedPara.includes(keyword)) {
          if (!seenTexts.has(trimmedPara)) {
            seenTexts.add(trimmedPara);
            candidates.push({
              text: trimmedPara,
              chapterTitle: chapter.title,
              matchedKeyword: keyword
            });
          }
          break; // 一个段落匹配一个关键词即可
        }
      }
    }
  }
  
  console.log(`[Step A] 提取到 ${candidates.filter(c => ['★','▲','☆','△','※','*'].includes(c.matchedKeyword)).length} 条 ★/▲ 符号条款`);
  
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
  biddingMethod: string | null;  // 新增：招标方式
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
  
  // 组织机构专用提取：智能识别组织名称边界
  const extractOrganization = (patterns: RegExp[]): string | null => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        let value = match[1].trim();
        
        // 策略1：在遇到这些关键词时截断
        const stopKeywords = [
          '地址', '联系人', '电话', '传真', '邮编', '邮箱', 
          '网址', '账号', '开户', '账户', '法定代表人',
          '联系方式', '通讯地址', '办公地址', '负责人',
          '项目经理', '技术负责', '售后'
        ];
        
        for (const keyword of stopKeywords) {
          const idx = value.indexOf(keyword);
          if (idx > 0) {
            value = value.substring(0, idx).trim();
          }
        }
        
        // 策略2：查找组织名称的典型结尾词，在其后截断
        const orgSuffixes = [
          '有限公司', '股份公司', '有限责任公司', '集团公司',
          '公司', '集团', '中心', '研究院', '研究所', '事务所',
          '管理局', '管理处', '管理中心', '服务中心',
          '委员会', '办公室', '局', '院', '所', '站', '队', '部'
        ];
        
        for (const suffix of orgSuffixes) {
          const idx = value.indexOf(suffix);
          if (idx > 0) {
            // 在结尾词之后截断
            const cutPoint = idx + suffix.length;
            if (cutPoint < value.length) {
              value = value.substring(0, cutPoint);
            }
            break;  // 只匹配第一个找到的结尾词
          }
        }
        
        // 去除尾部可能的冗余字符
        value = value.replace(/[：:,，\s]+$/, '');
        
        // 验证：长度合理
        if (value.length >= 4 && value.length <= 50) {
          return value;
        }
      }
    }
    return null;
  };
  
  // 智能提取：遇到常见字段名或特殊符号时停止
  const extractUntilNextField = (patterns: RegExp[]): string | null => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        let value = match[1].trim();
        // 在遇到下一个字段标识时截断
        const stopPatterns = [
          /[（\(][一二三四五六七八九十\d]+[）\)]/,  // (一) (1)
          /[一二三四五六七八九十\d]+[、．.]/,  // 一、 1.
          /项目编号|采购编号|招标编号/,
          /项目内容|服务名称|服务期限|包号|分包/,
          /采购人|招标人|代理机构/
        ];
        for (const stopPattern of stopPatterns) {
          const stopMatch = value.match(stopPattern);
          if (stopMatch && stopMatch.index !== undefined && stopMatch.index > 0) {
            value = value.substring(0, stopMatch.index).trim();
          }
        }
        // 去除尾部可能的冗余字符
        value = value.replace(/[：:,，\s]+$/, '');
        if (value.length >= 5 && value.length <= 80) {
          return value;
        }
      }
    }
    return null;
  };
  
  return {
    // 项目名称（使用智能提取，遇到字段标识时停止）
    projectName: extractUntilNextField([
      /项目名称[：:]\s*([^。\n]{5,150})/,
      /采购项目[：:]\s*([^。\n]{5,150})/,
      /工程名称[：:]\s*([^。\n]{5,150})/
    ]),
    
    // 项目编号（更精确的匹配）
    projectCode: extract([
      /项目编号[：:]\s*([A-Za-z0-9\-_]+(?:\s*[\-_]\s*[A-Za-z0-9]+)*)/,
      /采购编号[：:]\s*([A-Za-z0-9\-_]+(?:\s*[\-_]\s*[A-Za-z0-9]+)*)/,
      /招标编号[：:]\s*([A-Za-z0-9\-_]+(?:\s*[\-_]\s*[A-Za-z0-9]+)*)/
    ]),
    
    // 采购人（智能提取，遇到地址/联系人等时停止）
    purchaser: extractOrganization([
      /采购人[（\(]?甲方[）\)]?[：:]\s*([^，。\n]{2,80})/,
      /采购人[：:]\s*([^，。\n]{2,80})/,
      /招标人[：:]\s*([^，。\n]{2,80})/,
      /业主单位[：:]\s*([^，。\n]{2,80})/
    ]),
    
    // 代理机构（智能提取，遇到地址/联系人等时停止）
    agency: extractOrganization([
      /代理机构[：:]\s*([^，。\n]{2,80})/,
      /招标代理[：:]\s*([^，。\n]{2,80})/,
      /采购代理[机构]*[：:]\s*([^，。\n]{2,80})/
    ]),
    
    // 投标截止时间
    deadline: extract([
      /投标截止时间[：:]\s*([\d年月日时分秒\s:：\-\/]+)/,
      /截止时间[：:]\s*([\d年月日时分秒\s:：\-\/]+)/,
      /开标时间[：:]\s*([\d年月日时分秒\s:：\-\/]+)/,
      /(\d{4}[\-\/年]\d{1,2}[\-\/月]\d{1,2}日?\s*\d{1,2}[：:]\d{2})/
    ]),
    
    // 预算金额（处理万元、元等单位）
    budget: extract([
      /预算金额[：:]\s*([\d,，.]+\s*万?元)/,
      /最高限价[：:]\s*([\d,，.]+\s*万?元)/,
      /采购预算[：:]\s*([\d,，.]+\s*万?元)/,
      /项目预算[：:]\s*([\d,，.]+\s*万?元)/,
      /控制价[：:]\s*([\d,，.]+\s*万?元)/
    ]),
    
    // 开标地点
    location: extract([
      /开标地点[：:]\s*([^，。\n]{5,80})/,
      /投标地点[：:]\s*([^，。\n]{5,80})/,
      /评标地点[：:]\s*([^，。\n]{5,80})/
    ]),
    
    // 投标有效期
    validity: extract([
      /投标有效期[：:]\s*([\d]+\s*[天日个月年]+)/,
      /投标有效期[为]*([\d]+\s*[天日个月年]+)/,
      /有效期[：:]\s*([\d]+\s*[天日个月年]+)/
    ]),
    
    // 保证金
    bond: extract([
      /投标保证金[：:]\s*([\d,，.]+\s*万?元)/,
      /保证金金额[：:]\s*([\d,，.]+\s*万?元)/,
      /保证金[：:]\s*([\d,，.]+\s*万?元|不[需要求提交]+|免[收交缴]+)/
    ]),
    
    // 招标方式（新增）
    biddingMethod: extract([
      /采购方式[：:]\s*(公开招标|邀请招标|竞争性谈判|竞争性磋商|单一来源|询价采购|框架协议)/,
      /招标方式[：:]\s*(公开招标|邀请招标|竞争性谈判|竞争性磋商|单一来源|询价采购|框架协议)/,
      /本项目采用\s*(公开招标|邀请招标|竞争性谈判|竞争性磋商|单一来源|询价采购)/,
      /(公开招标|邀请招标|竞争性谈判|竞争性磋商|单一来源采购|询价采购)[方式]*进行采购/
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
  // 智能关键词匹配：支持分词匹配（如 "格式" 匹配 "投标文件的格式"）
  const smartMatch = (title: string, keywords: string[]): boolean => {
    const normalizedTitle = title.replace(/\s+/g, '');
    
    for (const kw of keywords) {
      // 完整匹配
      if (normalizedTitle.includes(kw)) {
        return true;
      }
      
      // 分词匹配：关键词的每个核心词都在标题中
      // 例如 "投标文件格式" -> ["投标", "文件", "格式"]
      const coreWords = kw.match(/[\u4e00-\u9fa5]{2,}/g) || [];
      if (coreWords.length >= 2) {
        const allMatch = coreWords.every(word => normalizedTitle.includes(word));
        if (allMatch) {
          return true;
        }
      }
    }
    return false;
  };

  // 带排除逻辑的章节查找
  const findChapterHtml = (
    keywords: string[], 
    excludeKeywords: string[] = []
  ): string | null => {
    for (const chapter of doc.chapters) {
      // 检查是否包含排除关键词
      const shouldExclude = excludeKeywords.some(ek => chapter.title.includes(ek));
      if (shouldExclude) continue;
      
      // 使用智能匹配
      if (smartMatch(chapter.title, keywords)) {
        return chapter.content;
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

// 根据章节标题查找章节内容（智能匹配）
function findChapterByTitle(doc: ParsedDocument, title: string | null | undefined): string | null {
  if (!title) return null;
  
  const normalizedTarget = title.replace(/\s+/g, '').replace(/第[一二三四五六七八九十\d]+[章节篇部]\s*/, '');
  
  // 1. 精确匹配
  const exactMatch = doc.chapters.find(c => c.title === title);
  if (exactMatch) return exactMatch.content;
  
  // 2. 去除章节号后匹配
  const noNumMatch = doc.chapters.find(c => {
    const normalizedChapter = c.title.replace(/\s+/g, '').replace(/第[一二三四五六七八九十\d]+[章节篇部]\s*/, '');
    return normalizedChapter === normalizedTarget || 
           normalizedChapter.includes(normalizedTarget) || 
           normalizedTarget.includes(normalizedChapter);
  });
  if (noNumMatch) return noNumMatch.content;
  
  // 3. 核心词匹配（提取2字以上的中文词）
  const targetWords = normalizedTarget.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  if (targetWords.length >= 1) {
    const wordMatch = doc.chapters.find(c => {
      const chapterNormalized = c.title.replace(/\s+/g, '');
      // 至少匹配50%的核心词
      const matchCount = targetWords.filter(w => chapterNormalized.includes(w)).length;
      return matchCount >= Math.ceil(targetWords.length * 0.5);
    });
    if (wordMatch) return wordMatch.content;
  }
  
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
  apiKey: string,  // 用户输入的 API Key，传递给后端
  signal?: AbortSignal  // 用于取消请求
): Promise<AIAnalysisResult | null> {
  
  // 获取招标公告和投标须知章节的内容
  const noticeChapter = doc.chapters.find(c => 
    CHAPTER_KEYWORDS.notice.some(kw => c.title.includes(kw))
  );
  const instructionsChapter = doc.chapters.find(c => 
    CHAPTER_KEYWORDS.instructions.some(kw => c.title.includes(kw))
  );
  
  // 限制内容大小，避免请求过大
  const maxContentLength = 6000;
  const noticeText = noticeChapter 
    ? noticeChapter.content.replace(/<[^>]*>/g, '').substring(0, maxContentLength)
    : '';
  const instructionsText = instructionsChapter 
    ? instructionsChapter.content.replace(/<[^>]*>/g, '').substring(0, maxContentLength)
    : '';
  
  // 构建风险候选项列表（优先 ★/▲ 相关的条款）
  const maxRisks = 80;
  const maxTextLen = 200;
  
  // 分离 ★/▲ 相关和其他风险
  const starRisks = rawRiskCandidates.filter(r => 
    r.text.includes('★') || r.text.includes('▲') || r.text.includes('☆') || r.text.includes('△')
  );
  const otherRisks = rawRiskCandidates.filter(r => 
    !r.text.includes('★') && !r.text.includes('▲') && !r.text.includes('☆') && !r.text.includes('△')
  );
  
  // 优先使用 ★/▲ 相关的，再补充其他的
  const prioritizedRisks = [...starRisks, ...otherRisks].slice(0, maxRisks);
  console.log(`   ★/▲ 相关候选项: ${starRisks.length} 条`);
  
  const riskList = prioritizedRisks.map((r, i) => 
    `[${i + 1}] 章节「${r.chapterTitle}」: ${r.text.substring(0, maxTextLen)}`
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
    "bond": "保证金或null",
    "biddingMethod": "招标方式（如：公开招标/邀请招标/竞争性谈判/竞争性磋商/单一来源/询价采购）或null"
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

  // 计算请求大小
  const requestSize = systemPrompt.length + userPrompt.length;
  console.log('   请求内容大小:', Math.round(requestSize / 1024), 'KB');
  console.log('   风险候选项数量:', rawRiskCandidates.length);
  console.log('   章节数量:', doc.chapters.length);
  
  try {
    // 检查是否已取消
    if (signal?.aborted) {
      console.log('   分析已取消，跳过 AI 请求');
      return null;
    }
    
    console.log('   通过后端代理调用 AI...');
    
    const response = await fetch(AI_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemPrompt,
        userPrompt,
        maxRetries: 3,
        apiKey: apiKey || undefined  // 传递用户输入的 API Key（如果有）
      }),
      signal  // 传递取消信号
    });
    
    if (!response.ok) {
      console.error(`   后端代理返回错误: ${response.status} ${response.statusText}`);
      return null;
    }
    
    const result = await response.json();
    
    if (!result.success) {
      console.error(`   AI 分析失败: ${result.error}`);
      return null;
    }
    
    const responseText = result.text || '';
    console.log('   AI 原始响应长度:', responseText.length);
    console.log('   使用模型:', result.model);
    
    // 尝试提取 JSON（处理可能的 markdown 代码块）
    let jsonStr = responseText;
    
    // 1. 移除 markdown 代码块标记
    const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
      console.log('   检测到 markdown 代码块，已提取内容');
    }
    
    // 2. 尝试匹配最外层的 JSON 对象
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        console.log('   AI JSON 解析成功');
        console.log('   filteredRisks 数量:', parsed.filteredRisks?.length || 0);
        return parsed as AIAnalysisResult;
      } catch (parseError) {
        console.error('   AI JSON 解析失败:', parseError);
        console.log('   尝试解析的内容长度:', jsonMatch[0].length);
        console.log('   AI 返回内容预览:', responseText.substring(0, 800));
        return null;
      }
    }
    
    console.log('   AI 响应中未找到 JSON，内容预览:', responseText.substring(0, 800));
    return null;
    
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    console.error('AI Analysis Error (via proxy):', errorMsg);
    
    // 检查是否是后端连接问题
    if (errorMsg.includes('Failed to fetch') || errorMsg.includes('NetworkError')) {
      console.error('   ⚠️ 无法连接到后端服务，请确保后端已启动: python backend/main.py');
    }
    
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
    bond: createConflictField(regexInfo.bond, aiInfo.bond, 'Regex(全文扫描)', 'AI(智能识别)'),
    biddingMethod: createConflictField(regexInfo.biddingMethod, aiInfo.biddingMethod, 'Regex(全文扫描)', 'AI(智能识别)')
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
  apiKey: string,
  signal?: AbortSignal
): Promise<KeyInformation> {
  // 检查取消信号
  const checkAborted = () => {
    if (signal?.aborted) {
      throw new DOMException('Analysis cancelled', 'AbortError');
    }
  };

  console.log('🔍 Step A: Regex 撒网 - 提取风险候选项...');
  checkAborted();
  const rawRiskCandidates = extractRiskCandidates(doc);
  console.log(`   找到 ${rawRiskCandidates.length} 个风险候选项`);
  
  console.log('📋 Step B: Regex 扫描 - 提取基本信息...');
  checkAborted();
  const regexInfo = extractBasicInfoByRegex(doc.rawHtml);
  console.log('   基本信息提取完成');
  
  console.log('✂️ Step C: HTML 切片 - 提取关键章节...');
  checkAborted();
  const htmlSlices = extractHtmlSlices(doc);
  console.log('   匹配结果:', {
    评分标准: htmlSlices.matchStatus.scoring ? '✅ 已匹配' : '❌ 未匹配',
    技术要求: htmlSlices.matchStatus.technical ? '✅ 已匹配' : '❌ 未匹配',
    格式要求: htmlSlices.matchStatus.format ? '✅ 已匹配' : '❌ 未匹配'
  });
  console.log('   章节列表:', doc.chapters.map(c => c.title));
  
  console.log('🤖 Step D: AI 审计分析...');
  checkAborted();
  const aiResult = await performAIAnalysis(doc, rawRiskCandidates, apiKey, signal);
  
  // 再次检查取消状态（AI 请求可能耗时较长）
  checkAborted();
  console.log(aiResult ? '   AI 分析成功' : '   AI 分析失败，使用回退方案');
  
  console.log('🔗 Step E: 合成与冲突解决...');
  checkAborted();
  const result = synthesizeResults(doc, regexInfo, aiResult, rawRiskCandidates, htmlSlices);
  console.log('   分析完成！');
  
  return result;
}

export { extractRiskCandidates, extractBasicInfoByRegex };

