
export interface Chapter {
  id: string;
  title: string;
  content: string; // HTML string
}

export interface ParsedDocument {
  name: string;
  chapters: Chapter[];
  rawHtml: string;
}

export enum AppState {
  IDLE = 'IDLE',
  PARSING = 'PARSING',
  VIEWING = 'VIEWING',
  ERROR = 'ERROR'
}

export interface Message {
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export interface ApiKeyConfig {
  provider: 'gemini';
  apiKey: string;
  savedAt: number;
}

// ==================== 深度分析相关类型 ====================

// 带冲突检测的字段（例如：Regex 找到 "10:00"，AI 找到 "09:30"）
export interface ConflictField {
  value: string;                    // 最可信的值（优先使用 Regex 匹配结果）
  isConflict: boolean;              // 是否存在冲突
  candidates: Array<{               // 候选值列表
    value: string;
    source: string;                 // 来源，如 "Regex(招标公告)" 或 "AI(投标须知)"
  }>;
}

// 废标风险分类
export type RiskCategory = 
  | 'qualification'  // 资格要求
  | 'commercial'     // 商务条款
  | 'technical'      // 技术参数
  | 'document'       // 文件规范
  | 'timeline'       // 时间要求
  | 'other';         // 其他要求

// 分类显示名称映射
export const RISK_CATEGORY_LABELS: Record<RiskCategory, string> = {
  qualification: '资格要求',
  commercial: '商务条款',
  technical: '技术参数',
  document: '文件规范',
  timeline: '时间要求',
  other: '其他要求'
};

// 分类描述
export const RISK_CATEGORY_DESC: Record<RiskCategory, string> = {
  qualification: '资质证书、营业执照、审计报告、信用中国、联合体限制、许可证',
  commercial: '报价要求、付款条件、保证金、业绩合同、人员要求',
  technical: '★/▲ 标记参数、实质性响应要求、技术偏离',
  document: '签字盖章、密封包装、文件格式、装订要求',
  timeline: '投标有效期、交货期、响应时间、工期要求',
  other: '其他无法归类的废标条款'
};

// 废标风险项
export interface InvalidationRisk {
  originalText: string;             // Regex 捕获的原始文本
  chapterTitle: string;             // 来源章节
  aiAnalysis: string;               // AI 的分析确认
  severity: 'high' | 'medium';      // 严重程度
  category: RiskCategory;           // 风险分类
}

// 审计逻辑说明
export interface AuditLogic {
  symbolDef: string;                // ★/▲ 符号的定义
  chapterRef: string;               // 定义废标条款的章节
  rejectKeywords: string[];         // 关键废标词汇
}

// 基本信息（多源冲突检测）
export interface BasicInfo {
  projectName: ConflictField;       // 项目名称
  projectCode: ConflictField;       // 项目编号
  purchaser: ConflictField;         // 采购人
  agency: ConflictField;            // 代理机构
  deadline: ConflictField;          // 投标截止时间
  budget: ConflictField;            // 预算金额
  location: ConflictField;          // 开标地点
  validity: ConflictField;          // 投标有效期
  bond: ConflictField;              // 保证金
  biddingMethod: ConflictField;     // 招标方式
}

// 关键信息提取结果
export interface KeyInformation {
  // 1. 基本信息：多源冲突检测
  basicInfo: BasicInfo;

  // 2. 废标风险项：Regex 撒网 -> AI 过滤的结果
  invalidationRisks: InvalidationRisk[];

  // 3. 审计逻辑：AI 的解释
  auditLogic: AuditLogic;

  // 4. 原始 HTML 切片（用于保持显示保真度，不经过 AI 生成）
  scoringTableHtml: string | null;      // 评分标准表格
  technicalChapterHtml: string | null;  // 技术需求章节
  formatChapterHtml: string | null;     // 格式要求章节
}

// 分析状态
export enum AnalysisState {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR'
}

// 原始风险候选项（Regex 撒网结果）
export interface RawRiskCandidate {
  text: string;
  chapterTitle: string;
  matchedKeyword: string;
}