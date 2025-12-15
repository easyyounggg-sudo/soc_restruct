
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { 
  FileUp, 
  FileJson, 
  Menu, 
  ChevronRight, 
  Loader2, 
  Download,
  Search,
  BookOpen,
  Info,
  MessageSquare,
  Send,
  User,
  Bot,
  X,
  Sparkles,
  AlertCircle,
  Settings,
  Key,
  Shield,
  AlertTriangle,
  CheckCircle,
  FileText,
  Table,
  ClipboardList,
  ChevronDown,
  ChevronUp,
  Zap,
  Clock
} from 'lucide-react';
import { AppState, ParsedDocument, Chapter, Message, KeyInformation, AnalysisState, ConflictField, RiskCategory, RISK_CATEGORY_LABELS, RISK_CATEGORY_DESC, InvalidationRisk } from './types';
import { parseDocument, downloadJson } from './services/docxParser';
import { GoogleGenAI } from "@google/genai";
import { ApiKeyModal, getStoredApiKey } from './components/ApiKeyModal';
import { analyzeBidDocument } from './services/hybridAnalysis';

// 简单的 Markdown 解析函数
const parseMarkdown = (text: string): string => {
  return text
    // 代码块
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="bg-slate-800 text-slate-100 p-3 rounded-lg overflow-x-auto my-2 text-xs"><code>$2</code></pre>')
    // 行内代码
    .replace(/`([^`]+)`/g, '<code class="bg-slate-200 text-slate-800 px-1.5 py-0.5 rounded text-xs">$1</code>')
    // 加粗
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold">$1</strong>')
    // 斜体
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // 标题 (h1-h3)
    .replace(/^### (.+)$/gm, '<h3 class="font-bold text-sm mt-3 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="font-bold text-base mt-3 mb-1">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="font-bold text-lg mt-3 mb-2">$1</h1>')
    // 无序列表
    .replace(/^\* (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    // 有序列表
    .replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal">$1</li>')
    // 包裹连续的 li 元素
    .replace(/(<li[^>]*>.*<\/li>\n?)+/g, '<ul class="my-2 space-y-1">$&</ul>')
    // 分隔线
    .replace(/^---$/gm, '<hr class="my-3 border-slate-200">')
    // 换行
    .replace(/\n/g, '<br>');
};

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(AppState.IDLE);
  const [doc, setDoc] = useState<ParsedDocument | null>(null);
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  
  // AI Chat State
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // API Key State
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(false);
  const [userApiKey, setUserApiKey] = useState<string | null>(null);

  // 深度分析状态
  const [analysisState, setAnalysisState] = useState<AnalysisState>(AnalysisState.IDLE);
  const [keyInfo, setKeyInfo] = useState<KeyInformation | null>(null);
  const [showAnalysisPanel, setShowAnalysisPanel] = useState(false);
  const [activeAnalysisTab, setActiveAnalysisTab] = useState<'basic' | 'risks' | 'scoring' | 'technical' | 'format'>('basic');
  
  // 风险定位状态
  const [locatingRisk, setLocatingRisk] = useState<{
    text: string;
    chapterTitle: string;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  
  // 深度分析取消控制
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // 文档指纹（用于缓存）
  const [docFingerprint, setDocFingerprint] = useState<string | null>(null);

  // Load API Key from localStorage on mount
  useEffect(() => {
    const storedKey = getStoredApiKey();
    if (storedKey) {
      setUserApiKey(storedKey);
    }
  }, []);

  // Get the active API key (only from user configuration)
  const getActiveApiKey = (): string | null => {
    // 只返回有效的非空字符串 Key
    if (userApiKey && userApiKey.trim().length > 0 && userApiKey.startsWith('AIza')) {
      return userApiKey.trim();
    }
    return null;
  };

  const hasApiKey = !!getActiveApiKey();

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isAiLoading]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const fileName = file.name.toLowerCase();
    
    // 检查文件格式
    if (fileName.endsWith('.doc')) {
      alert('抱歉，不支持旧版 .doc 格式。请将文件另存为 .docx 后再试。');
      return;
    }
    
    if (!fileName.endsWith('.docx')) {
      alert('请上传 .docx 格式的文件');
      return;
    }

    try {
      setState(AppState.PARSING);
      // 重置分析状态
      setKeyInfo(null);
      setShowAnalysisPanel(false);
      setAnalysisState(AnalysisState.IDLE);
      
      const parsed = await parseDocument(file);
      setDoc(parsed);
      if (parsed.chapters.length > 0) {
        setActiveChapterId(parsed.chapters[0].id);
      }
      setState(AppState.VIEWING);
      setMessages([]);
    } catch (error: any) {
      console.error('Parsing failed:', error);
      alert(error.message || '文件解析失败');
      setState(AppState.ERROR);
    }
  };

  const handleExportAnalysis = () => {
    if (!keyInfo) {
      alert('请先进行深度分析后再导出报告');
      return;
    }
    
    // 构建精炼的分析报告
    const report = {
      exportTime: new Date().toISOString(),
      documentName: doc?.name || '未知文档',
      
      // 基本信息（转换为简单对象）
      basicInfo: {
        projectName: keyInfo.basicInfo.projectName.value,
        projectCode: keyInfo.basicInfo.projectCode.value,
        purchaser: keyInfo.basicInfo.purchaser.value,
        agency: keyInfo.basicInfo.agency.value,
        deadline: keyInfo.basicInfo.deadline.value,
        budget: keyInfo.basicInfo.budget.value,
        location: keyInfo.basicInfo.location.value,
        validity: keyInfo.basicInfo.validity.value,
        bond: keyInfo.basicInfo.bond.value,
        biddingMethod: keyInfo.basicInfo.biddingMethod.value,
      },
      
      // 废标风险项
      invalidationRisks: keyInfo.invalidationRisks.map(r => ({
        category: r.category,
        severity: r.severity,
        originalText: r.originalText,
        chapterTitle: r.chapterTitle,
        aiAnalysis: r.aiAnalysis
      })),
      
      // 风险统计
      riskSummary: {
        total: keyInfo.invalidationRisks.length,
        highRisk: keyInfo.invalidationRisks.filter(r => r.severity === 'high').length,
        mediumRisk: keyInfo.invalidationRisks.filter(r => r.severity === 'medium').length,
        byCategory: {
          qualification: keyInfo.invalidationRisks.filter(r => r.category === 'qualification').length,
          commercial: keyInfo.invalidationRisks.filter(r => r.category === 'commercial').length,
          technical: keyInfo.invalidationRisks.filter(r => r.category === 'technical').length,
          document: keyInfo.invalidationRisks.filter(r => r.category === 'document').length,
          timeline: keyInfo.invalidationRisks.filter(r => r.category === 'timeline').length,
          other: keyInfo.invalidationRisks.filter(r => r.category === 'other').length,
        }
      },
      
      // 审计逻辑
      auditLogic: keyInfo.auditLogic
    };
    
    downloadJson(report, `${doc?.name.replace('.docx', '') || 'analysis'}_分析报告.json`);
  };

  // 生成文档指纹（用于缓存）
  const generateDocFingerprint = (document: ParsedDocument): string => {
    const content = document.chapters.map(c => c.title).join('|');
    // 简单的哈希函数
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `doc_${document.name}_${hash}`;
  };

  // 获取缓存的分析结果
  const getCachedAnalysis = (fingerprint: string): KeyInformation | null => {
    try {
      const cached = localStorage.getItem(`analysis_cache_${fingerprint}`);
      if (cached) {
        return JSON.parse(cached);
    }
    } catch (e) {
      console.error('Failed to read cache:', e);
    }
    return null;
  };

  // 保存分析结果到缓存
  const saveAnalysisToCache = (fingerprint: string, result: KeyInformation) => {
    try {
      localStorage.setItem(`analysis_cache_${fingerprint}`, JSON.stringify(result));
    } catch (e) {
      console.error('Failed to save cache:', e);
    }
  };

  // 取消深度分析（保存之前的有效结果引用）
  const previousKeyInfoRef = useRef<KeyInformation | null>(null);
  
  const cancelDeepAnalysis = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    // 如果有之前的有效结果，恢复它
    if (previousKeyInfoRef.current) {
      setKeyInfo(previousKeyInfoRef.current);
      setAnalysisState(AnalysisState.COMPLETED);
      console.log('已恢复之前的分析结果');
    } else {
      setAnalysisState(AnalysisState.IDLE);
    }
    
    setShowAnalysisPanel(false);  // 关闭分析面板，显示文档内容
  };

  // 关闭分析面板
  const closeAnalysisPanel = () => {
    setShowAnalysisPanel(false);
    // 保持 analysisState 为 COMPLETED（如果已完成），这样再次打开时不会重新分析
    // 但如果是 ANALYZING 状态（不应该发生），重置为 IDLE
    if (analysisState === AnalysisState.ANALYZING) {
      setAnalysisState(AnalysisState.IDLE);
    }
  };

  // 深度分析处理函数
  const handleDeepAnalysis = async (forceRefresh: boolean = false) => {
    if (!doc) return;
    
    // 如果正在分析中，忽略点击
    if (analysisState === AnalysisState.ANALYZING) {
      console.log('正在分析中，忽略重复点击');
      return;
    }
    
    // 如果当前会话已有分析结果，直接显示（不消耗 Token）
    if (keyInfo && !forceRefresh) {
      console.log('已有分析结果，直接显示');
      // 确保清除任何可能的分析中状态
      abortControllerRef.current = null;
      // 确保状态为 COMPLETED，然后显示面板
      setAnalysisState(AnalysisState.COMPLETED);
      setShowAnalysisPanel(true);
      // 重置风险定位状态
      setLocatingRisk(null);
      return;
    }
    
    const activeKey = getActiveApiKey();
    if (!activeKey) {
      alert('请先配置 API Key 后再使用深度分析功能。');
      setIsApiKeyModalOpen(true);
      return;
    }

    // 生成文档指纹
    const fingerprint = generateDocFingerprint(doc);
    setDocFingerprint(fingerprint);

    // 检查 localStorage 缓存（非强制刷新时）
    if (!forceRefresh) {
      const cached = getCachedAnalysis(fingerprint);
      if (cached) {
        const useCache = window.confirm(
          '检测到该文档已有分析结果缓存。\n\n点击"确定"使用缓存结果（免费）\n点击"取消"重新分析（消耗 Token）'
        );
        if (useCache) {
          setKeyInfo(cached);
          setAnalysisState(AnalysisState.COMPLETED);
          setShowAnalysisPanel(true);
          return;
        }
      }
    }

    // 保存之前的有效结果（用于取消时恢复）
    if (keyInfo) {
      previousKeyInfoRef.current = keyInfo;
    }
    
    // 创建新的 AbortController
    abortControllerRef.current = new AbortController();

    setAnalysisState(AnalysisState.ANALYZING);
    setShowAnalysisPanel(true);

    try {
      const result = await analyzeBidDocument(doc, activeKey, abortControllerRef.current.signal);
      
      // 检查是否被取消
      if (abortControllerRef.current?.signal.aborted) {
        console.log('Analysis was aborted, not updating state');
        return;
      }
      
      setKeyInfo(result);
      setAnalysisState(AnalysisState.COMPLETED);
      
      // 分析成功后，清空之前的结果引用
      previousKeyInfoRef.current = null;
      
      // 保存到缓存
      saveAnalysisToCache(fingerprint, result);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Analysis cancelled by user');
        // 恢复之前的结果（如果有）
        if (previousKeyInfoRef.current) {
          setKeyInfo(previousKeyInfoRef.current);
          setAnalysisState(AnalysisState.COMPLETED);
        }
        return;
      }
      console.error('Deep analysis failed:', error);
      setAnalysisState(AnalysisState.ERROR);
    } finally {
      abortControllerRef.current = null;
    }
  };

  // 处理冲突字段的值选择
  const handleConflictResolve = (fieldKey: keyof KeyInformation['basicInfo'], selectedValue: string) => {
    if (!keyInfo) return;
    
    setKeyInfo({
      ...keyInfo,
      basicInfo: {
        ...keyInfo.basicInfo,
        [fieldKey]: {
          ...keyInfo.basicInfo[fieldKey],
          value: selectedValue,
          isConflict: false
        }
      }
    });
  };

  const activeChapter = doc?.chapters.find(c => c.id === activeChapterId);
  
  // 处理风险来源点击 - 定位并高亮
  const handleRiskLocate = useCallback((risk: { text: string; chapterTitle: string }) => {
    if (!doc) return;
    
    // 如果点击的是同一个风险，则取消定位
    if (locatingRisk && locatingRisk.text === risk.text) {
      setLocatingRisk(null);
      return;
    }
    
    // 提取搜索关键词（取风险文本中的核心部分）
    const getSearchKeywords = (text: string): string[] => {
      // 清理文本，取多个片段用于匹配
      const cleanText = text.replace(/[★▲☆△※\*]/g, '').trim();
      const keywords: string[] = [];
      
      // 取前20个字符
      if (cleanText.length >= 10) {
        keywords.push(cleanText.substring(0, 20));
      }
      // 取中间部分
      if (cleanText.length >= 30) {
        keywords.push(cleanText.substring(10, 30));
      }
      // 完整文本（用于精确匹配）
      if (cleanText.length <= 50) {
        keywords.push(cleanText);
      }
      
      return keywords.filter(k => k.length >= 5);
    };
    
    const searchKeywords = getSearchKeywords(risk.text);
    
    // 查找包含该风险文本的章节
    let targetChapter = doc.chapters.find(c => {
      const plainContent = c.content.replace(/<[^>]*>/g, '');
      // 任意一个关键词匹配即可
      return searchKeywords.some(keyword => plainContent.includes(keyword));
    });
    
    // 如果内容匹配失败，尝试按章节标题匹配
    if (!targetChapter) {
      const titleKeyword = risk.chapterTitle.replace(/第[一二三四五六七八九十\d]+[章节篇部]\s*/, '').trim();
      if (titleKeyword) {
        targetChapter = doc.chapters.find(c => 
          c.title.includes(titleKeyword) || titleKeyword.includes(c.title.replace(/第[一二三四五六七八九十\d]+[章节篇部]\s*/, ''))
        );
      }
    }
    
    if (targetChapter) {
      // 切换到该章节
      setActiveChapterId(targetChapter.id);
      // 设置定位状态
      setLocatingRisk(risk);
      
      // 延迟滚动到高亮位置
      setTimeout(() => {
        const highlightEl = document.querySelector('.risk-highlight');
        if (highlightEl) {
          highlightEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 150);
    } else {
      // 未找到章节，提示用户
      console.warn('未能定位到章节:', risk.chapterTitle);
      // 仍然设置定位状态（会在当前章节尝试高亮）
      setLocatingRisk(risk);
    }
  }, [doc, locatingRisk]);
  
  // 高亮风险文本的函数
  const highlightRiskText = useCallback((html: string): string => {
    if (!locatingRisk) return html;
    
    // 清理风险文本，移除特殊符号
    const cleanText = locatingRisk.text.replace(/[★▲☆△※\*]/g, '').trim();
    
    // 尝试多个长度的匹配（从长到短）
    const tryLengths = [60, 40, 25, 15];
    
    for (const len of tryLengths) {
      if (cleanText.length < len) continue;
      
      const searchText = cleanText.substring(0, len).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      try {
        const regex = new RegExp(`(${searchText})`, 'gi');
        if (regex.test(html)) {
          return html.replace(regex, '<mark class="risk-highlight bg-red-200 text-red-900 px-1 rounded animate-pulse">$1</mark>');
        }
      } catch {
        continue;
      }
    }
    
    // 如果上述都匹配失败，尝试匹配任意包含的关键词
    const keywords = cleanText.split(/[，。、；：\s]+/).filter(k => k.length >= 4).slice(0, 3);
    for (const keyword of keywords) {
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        const regex = new RegExp(`(${escapedKeyword})`, 'gi');
        if (regex.test(html)) {
          return html.replace(regex, '<mark class="risk-highlight bg-yellow-200 text-yellow-900 px-1 rounded">$1</mark>');
        }
      } catch {
        continue;
      }
    }
    
    return html;
  }, [locatingRisk]);
  
  // 搜索支持：标题 + 内容
  const filteredChapters = doc?.chapters.filter(c => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    const titleMatch = c.title.toLowerCase().includes(query);
    // 搜索内容时，先去除 HTML 标签
    const plainContent = c.content.replace(/<[^>]*>/g, '').toLowerCase();
    const contentMatch = plainContent.includes(query);
    return titleMatch || contentMatch;
  }) || [];
  
  // 判断搜索结果是标题匹配还是内容匹配，并返回匹配片段
  const getMatchInfo = (chapter: Chapter): { type: 'title' | 'content' | null; snippet: string | null } => {
    if (!searchQuery.trim()) return { type: null, snippet: null };
    const query = searchQuery.toLowerCase();
    
    // 标题匹配
    if (chapter.title.toLowerCase().includes(query)) {
      return { type: 'title', snippet: null };
    }
    
    // 内容匹配 - 提取匹配片段
    const plainContent = chapter.content.replace(/<[^>]*>/g, '');
    const lowerContent = plainContent.toLowerCase();
    const matchIndex = lowerContent.indexOf(query);
    
    if (matchIndex !== -1) {
      // 提取匹配位置前后的文本作为片段
      const start = Math.max(0, matchIndex - 20);
      const end = Math.min(plainContent.length, matchIndex + query.length + 40);
      let snippet = plainContent.substring(start, end).trim();
      
      // 添加省略号
      if (start > 0) snippet = '...' + snippet;
      if (end < plainContent.length) snippet = snippet + '...';
      
      return { type: 'content', snippet };
    }
    
    return { type: null, snippet: null };
  };
  
  // 高亮搜索关键词
  const highlightSearchTerm = (text: string): string => {
    if (!searchQuery.trim()) return text;
    const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<mark class="bg-yellow-200 text-yellow-900 px-0.5 rounded">$1</mark>');
  };

  const handleSendMessage = async () => {
    if (!inputText.trim() || !doc || isAiLoading) return;

    const activeKey = getActiveApiKey();
    if (!activeKey) {
      setMessages(prev => [...prev, {
        role: 'model',
        text: "请先配置 API Key 后再使用 AI 助手功能。点击右上角的设置按钮进行配置。",
        timestamp: Date.now()
      }]);
      return;
    }

    const userMessage: Message = {
      role: 'user',
      text: inputText,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setIsAiLoading(true);

    try {
      const ai = new GoogleGenAI({ apiKey: activeKey });
      
      // 构建全文档上下文
      const fullContent = doc.chapters.map((chapter, index) => {
        const cleanContent = chapter.content.replace(/<[^>]*>?/gm, '').trim();
        return `【章节 ${index + 1}: ${chapter.title}】\n${cleanContent}`;
      }).join('\n\n---\n\n');
      const context = `完整招标文件内容（共 ${doc.chapters.length} 个章节）:\n\n${fullContent}`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `基于以下招标文件内容回答我的问题：\n\n【文档上下文】\n${context}\n\n【用户问题】\n${inputText}`,
        config: {
          systemInstruction: "你是一个专业的招标文件分析助手。请根据提供的招标文件内容回答用户的问题。回答要准确、客观、专业。如果文档中没有相关信息，请如实告知。请始终使用中文回答。",
        },
      });

      const aiResponse: Message = {
        role: 'model',
        text: response.text || "抱歉，我无法生成回复。",
        timestamp: Date.now()
      };
      setMessages(prev => [...prev, aiResponse]);
    } catch (error: any) {
      console.error('AI Error:', error);
      
      // 直接显示原始错误信息，便于调试
      const rawMessage = error?.message || String(error);
      console.error('Full error details:', JSON.stringify(error, null, 2));
      
      setMessages(prev => [...prev, {
        role: 'model',
        text: `❌ AI 请求失败:\n\n${rawMessage}`,
        timestamp: Date.now()
      }]);
    } finally {
      setIsAiLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900 overflow-hidden relative">
      {/* 分析进行中遮罩 - 只在真正分析中且有 AbortController 时显示 */}
      {analysisState === AnalysisState.ANALYZING && abortControllerRef.current && (
        <AnalyzingOverlay onCancel={cancelDeepAnalysis} />
      )}

      {/* API Key Modal */}
      <ApiKeyModal
        isOpen={isApiKeyModalOpen}
        onClose={() => setIsApiKeyModalOpen(false)}
        onSave={(key) => setUserApiKey(key || null)}
        currentApiKey={userApiKey}
      />
      {/* Sidebar */}
      {state === AppState.VIEWING && isSidebarOpen && (
        <aside className="w-80 border-r border-slate-200 bg-white flex flex-col shadow-sm z-20">
          <div className="p-6 border-b border-slate-100">
            <h2 className="text-xl font-bold text-blue-600 flex items-center gap-2">
              <BookOpen size={24} />
              章节目录
            </h2>
            <div className="mt-4 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <input 
                type="text"
                placeholder="搜索标题或内容..."
                className="w-full pl-10 pr-4 py-2 bg-slate-100 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>
          
          <nav className="flex-1 overflow-y-auto p-4 space-y-1">
            {filteredChapters.map((chapter) => {
              const matchInfo = getMatchInfo(chapter);
              return (
              <button
                key={chapter.id}
                onClick={() => setActiveChapterId(chapter.id)}
                className={`w-full text-left px-4 py-3 rounded-xl transition-all flex items-center justify-between group ${
                  activeChapterId === chapter.id 
                    ? 'bg-blue-50 text-blue-700 shadow-sm border border-blue-100' 
                    : 'hover:bg-slate-50 text-slate-600'
                }`}
              >
                  <div className="flex-1 min-w-0">
                    {/* 标题 - 高亮搜索词 */}
                    <span 
                      className="text-sm font-medium line-clamp-2"
                      dangerouslySetInnerHTML={{ 
                        __html: searchQuery.trim() ? highlightSearchTerm(chapter.title) : chapter.title 
                      }}
                    />
                    {/* 内容匹配时显示片段预览 */}
                    {matchInfo.type === 'content' && matchInfo.snippet && (
                      <div className="mt-1.5 p-2 bg-green-50 rounded-lg border border-green-100">
                        <div className="text-xs text-green-600 flex items-center gap-1 mb-1">
                          <Search size={10} />
                          内容匹配
                        </div>
                        <p 
                          className="text-xs text-slate-600 line-clamp-2"
                          dangerouslySetInnerHTML={{ __html: highlightSearchTerm(matchInfo.snippet) }}
                        />
                      </div>
                    )}
                  </div>
                  {activeChapterId === chapter.id && <ChevronRight size={16} className="shrink-0 ml-2" />}
              </button>
              );
            })}
            {filteredChapters.length === 0 && (
              <div className="text-center py-10 text-slate-400 text-sm">
                未找到匹配结果
              </div>
            )}
            {filteredChapters.length > 0 && searchQuery.trim() && (
              <div className="text-center py-2 text-slate-400 text-xs">
                找到 {filteredChapters.length} 个匹配章节
              </div>
            )}
          </nav>

          <div className="p-4 border-t border-slate-100 bg-slate-50 space-y-2">
            <button 
              onClick={handleDeepAnalysis}
              disabled={analysisState === AnalysisState.ANALYZING}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg text-sm font-medium hover:from-purple-700 hover:to-indigo-700 transition-all shadow-lg shadow-purple-200 disabled:opacity-50"
            >
              {analysisState === AnalysisState.ANALYZING ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  分析中...
                </>
              ) : (
                <>
                  <Zap size={16} />
                  深度分析
                </>
              )}
            </button>
            <button 
              onClick={handleExportAnalysis}
              disabled={!keyInfo}
              className={`w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg text-sm font-medium transition-colors shadow-sm ${
                keyInfo 
                  ? 'bg-white border border-slate-200 hover:bg-slate-50' 
                  : 'bg-slate-100 border border-slate-200 text-slate-400 cursor-not-allowed'
              }`}
            >
              <Download size={16} />
              导出分析报告
            </button>
          </div>
        </aside>
      )}

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Header */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 z-10">
          <div className="flex items-center gap-4">
            {state === AppState.VIEWING && (
              <button 
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
              >
                <Menu size={20} />
              </button>
            )}
            <h1 className="font-bold text-lg text-slate-800">
              {doc ? doc.name : '招标文件结构化解析器'}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {/* API Key 设置按钮 - 始终显示 */}
            <button
              onClick={() => setIsApiKeyModalOpen(true)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-all shadow-sm ${
                hasApiKey
                  ? 'bg-green-50 text-green-700 border border-green-200 hover:bg-green-100'
                  : 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 animate-pulse'
              }`}
              title={hasApiKey ? 'API Key 已配置' : '请配置 API Key'}
            >
              <Key size={14} />
              <span className="hidden sm:inline">{hasApiKey ? 'API Key 已配置' : '设置 API Key'}</span>
            </button>

            {state === AppState.VIEWING && (
              <>
                <div className="hidden md:flex items-center gap-2 px-3 py-1 bg-yellow-50 text-yellow-700 border border-yellow-100 rounded-full text-xs font-medium">
                  <Info size={14} />
                  <span>已识别填空项高亮显示</span>
                </div>
                <button 
                  onClick={() => setIsChatOpen(!isChatOpen)}
                  className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-sm font-medium transition-all shadow-sm ${
                    isChatOpen 
                      ? 'bg-blue-600 text-white shadow-blue-200' 
                      : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Sparkles size={16} className={isChatOpen ? 'animate-pulse' : ''} />
                  AI 助手互动
                </button>
              </>
            )}
            {state !== AppState.VIEWING && (
              <div className="flex flex-col items-end">
                <label className="cursor-pointer bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 shadow-lg shadow-blue-200">
                  <FileUp size={18} />
                  上传招标文件
                  <input 
                    type="file" 
                    accept=".docx" 
                    className="hidden" 
                    onChange={handleFileUpload} 
                  />
                </label>
                <span className="text-[10px] text-slate-400 mt-1 mr-1">支持 .docx 格式</span>
              </div>
            )}
          </div>
        </header>

        {/* Content Area */}
        <div className={`flex-1 overflow-y-auto p-8 bg-[#fdfdfd] transition-all duration-300 ${isChatOpen ? 'mr-0 lg:mr-4' : ''}`}>
          {state === AppState.IDLE && (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-2xl mx-auto">
              <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-3xl flex items-center justify-center mb-6 shadow-inner">
                <FileUp size={40} />
              </div>
              <h2 className="text-3xl font-bold text-slate-800 mb-4">开始结构化解析</h2>
              <p className="text-slate-500 mb-6 leading-relaxed text-lg">
                上传您的招标文件 (<b>.docx</b>)，系统将自动过滤目录干扰、智能提取章节结构，并高亮标注填空项。
              </p>
              
              <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 border border-blue-100 rounded-xl text-blue-800 text-sm mb-10">
                <Info size={18} className="shrink-0" />
                <span><b>支持格式：</b> .docx | 不支持旧版 .doc 格式</span>
              </div>

              <div className="grid grid-cols-2 gap-4 w-full text-left">
                <FeatureCard 
                  icon={<Menu className="text-blue-500" />}
                  title="多级标题识别"
                  desc="自动识别符合 '第一篇'、'第1章' 或 '第一部分' 规范的标题。"
                />
                <FeatureCard 
                  icon={<Loader2 className="text-emerald-500" />}
                  title="智能去噪"
                  desc="自动识别并移除目录页页码及引导线干扰。"
                />
                <FeatureCard 
                  icon={<Info className="text-yellow-500" />}
                  title="填空项标注"
                  desc="自动识别 [ ]、____ 或 ( ) 并在文档中醒目高亮。"
                />
                <FeatureCard 
                  icon={<FileJson className="text-purple-500" />}
                  title="结构化输出"
                  desc="支持将解析结果一键导出为标准 JSON 格式。"
                />
              </div>
            </div>
          )}

          {state === AppState.PARSING && (
            <div className="h-full flex flex-col items-center justify-center">
              <Loader2 size={48} className="text-blue-600 animate-spin mb-4" />
              <p className="text-slate-600 font-medium text-lg">正在深度解析文档结构，请稍候...</p>
              <p className="text-slate-400 text-sm mt-2">正在处理样式转换与去噪过滤...</p>
            </div>
          )}

          {state === AppState.VIEWING && showAnalysisPanel && keyInfo && !locatingRisk && analysisState === AnalysisState.COMPLETED && (
            <div className="max-w-5xl mx-auto">
              <AnalysisDashboard
                keyInfo={keyInfo}
                activeTab={activeAnalysisTab}
                onTabChange={setActiveAnalysisTab}
                onConflictResolve={(key, value) => handleConflictResolve(key as keyof KeyInformation['basicInfo'], value)}
                onClose={closeAnalysisPanel}
                onRiskLocate={handleRiskLocate}
              />
            </div>
          )}

          {/* 风险定位模式：左右分栏布局 */}
          {state === AppState.VIEWING && showAnalysisPanel && keyInfo && locatingRisk && activeChapter && analysisState === AnalysisState.COMPLETED && (
            <div className="flex gap-4 h-full">
              {/* 左侧：原文内容 */}
              <div className="flex-1 bg-white border border-slate-100 rounded-2xl shadow-sm p-6 overflow-auto" ref={contentRef}>
                <div className="mb-4 pb-3 border-b border-slate-100">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="inline-block px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs font-bold uppercase tracking-wider mb-1">
                        风险定位
                      </span>
                      <h2 className="text-xl font-bold text-slate-900">{activeChapter.title}</h2>
                    </div>
                    <button
                      onClick={() => setLocatingRisk(null)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-sm hover:bg-slate-200 transition-colors"
                    >
                      <X size={14} />
                      取消定位
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 mt-2">
                    已高亮显示风险条款，点击右侧"来源"列可切换其他风险
                  </p>
                </div>
                <div 
                  className="prose prose-slate max-w-none text-slate-700 leading-7 text-sm"
                  dangerouslySetInnerHTML={{ __html: highlightRiskText(activeChapter.content) }} 
                />
              </div>
              
              {/* 右侧：分析面板（紧凑模式） */}
              <div className="w-[420px] flex-shrink-0">
                <AnalysisDashboard
                  keyInfo={keyInfo}
                  activeTab="risks"
                  onTabChange={setActiveAnalysisTab}
                  onConflictResolve={(key, value) => handleConflictResolve(key as keyof KeyInformation['basicInfo'], value)}
                  onClose={() => {
                    setLocatingRisk(null);
                    closeAnalysisPanel();
                  }}
                  onRiskLocate={handleRiskLocate}
                  compact={true}
                  locatingRiskText={locatingRisk.text}
                />
              </div>
            </div>
          )}

          {state === AppState.VIEWING && !showAnalysisPanel && activeChapter && (
            <div className="max-w-4xl mx-auto bg-white border border-slate-100 rounded-2xl shadow-sm p-10 min-h-full transition-all duration-500">
              <div className="mb-8 pb-4 border-b border-slate-100">
                <div className="flex items-center justify-between">
                  <div>
                <span className="inline-block px-3 py-1 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold uppercase tracking-wider mb-2">
                  当前章节
                </span>
                    <h2 
                      className="text-3xl font-bold text-slate-900"
                      dangerouslySetInnerHTML={{ 
                        __html: searchQuery.trim() ? highlightSearchTerm(activeChapter.title) : activeChapter.title 
                      }}
                    />
                  </div>
                  {keyInfo && (
                    <button
                      onClick={() => setShowAnalysisPanel(true)}
                      className="flex items-center gap-2 px-4 py-2 bg-purple-100 text-purple-700 rounded-lg text-sm font-medium hover:bg-purple-200 transition-colors"
                    >
                      <Shield size={16} />
                      查看分析报告
                    </button>
                  )}
                </div>
                {/* 搜索提示 */}
                {searchQuery.trim() && (
                  <div className="mt-4 flex items-center gap-2 text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
                    <Search size={14} />
                    <span>正在高亮显示: <strong>"{searchQuery}"</strong></span>
                    <button 
                      onClick={() => setSearchQuery('')}
                      className="ml-auto text-amber-600 hover:text-amber-800"
                    >
                      清除搜索
                    </button>
                  </div>
                )}
              </div>
              
              <div 
                className="prose prose-slate max-w-none text-slate-700 leading-8"
                dangerouslySetInnerHTML={{ 
                  __html: searchQuery.trim() 
                    ? highlightSearchTerm(activeChapter.content) 
                    : activeChapter.content 
                }} 
              />
            </div>
          )}

          {state === AppState.ERROR && (
            <div className="h-full flex flex-col items-center justify-center">
              <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mb-4">
                <AlertCircle size={32} />
              </div>
              <h3 className="text-xl font-bold text-slate-800">解析失败</h3>
              <p className="text-slate-500 mt-2 max-w-sm text-center">
                无法读取该文件。请确保它不是损坏的文件，且<b>不是旧版 .doc 格式</b>。
              </p>
              <button 
                onClick={() => setState(AppState.IDLE)}
                className="mt-6 px-6 py-2 bg-slate-800 text-white rounded-lg hover:bg-slate-900 transition-colors"
              >
                返回重试
              </button>
            </div>
          )}
        </div>

        {/* AI Chat Drawer */}
        <div 
          className={`fixed top-16 right-0 bottom-0 w-96 bg-white border-l border-slate-200 shadow-2xl transition-transform duration-300 transform z-30 flex flex-col ${
            isChatOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
        >
          <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-blue-50/30">
            <div className="flex items-center gap-2">
              <Sparkles size={18} className="text-blue-600" />
              <h3 className="font-bold text-slate-800">AI 文档助手</h3>
            </div>
            <button 
              onClick={() => setIsChatOpen(false)}
              className="p-1 hover:bg-slate-200 rounded-md text-slate-500"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/50">
            {messages.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center px-6">
                <Bot size={48} className="text-blue-200 mb-4" />
                <p className="text-slate-500 text-sm mb-4">
                  我已阅读完整文档，可以回答关于整份招标文件的任何问题：
                </p>
                <div className="space-y-2 w-full">
                  {["请总结这份招标文件的主要内容", "投标的资质要求有哪些？", "有哪些关键的时间节点？", "合同签署需要哪些材料？"].map((q, i) => (
                    <button 
                      key={i}
                      onClick={() => setInputText(q)}
                      className="w-full p-2 bg-white border border-slate-200 rounded-lg text-xs text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-all text-left"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 shadow-sm ${
                  msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white text-blue-600 border border-blue-100'
                }`}>
                  {msg.role === 'user' ? <User size={16} /> : <Bot size={16} />}
                </div>
                {msg.role === 'user' ? (
                  <div className="max-w-[80%] p-3 rounded-2xl rounded-tr-none text-sm shadow-sm bg-blue-600 text-white">
                  {msg.text}
                </div>
                ) : (
                  <div 
                    className="max-w-[85%] p-4 rounded-2xl rounded-tl-none text-sm shadow-sm bg-white text-slate-800 border border-slate-100 prose prose-sm prose-slate"
                    dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.text) }}
                  />
                )}
              </div>
            ))}
            {isAiLoading && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-white text-blue-600 border border-blue-100 flex items-center justify-center shrink-0 animate-pulse">
                  <Bot size={16} />
                </div>
                <div className="bg-white border border-slate-100 p-3 rounded-2xl rounded-tl-none shadow-sm">
                  <Loader2 size={16} className="animate-spin text-blue-500" />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="p-4 border-t border-slate-100 bg-white">
            <div className="flex gap-2">
              <input 
                type="text"
                placeholder="在此输入您的问题..."
                className="flex-1 bg-slate-100 border-none rounded-xl px-4 py-2 text-sm focus:ring-2 focus:ring-blue-500 transition-all"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              />
              <button 
                onClick={handleSendMessage}
                disabled={!inputText.trim() || isAiLoading}
                className="bg-blue-600 text-white p-2 rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:hover:bg-blue-600 shadow-lg shadow-blue-100 transition-all"
              >
                <Send size={18} />
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

// ==================== 深度分析仪表板组件 ====================

// 冲突字段显示组件
const ConflictFieldDisplay: React.FC<{
  label: string;
  field: ConflictField;
  fieldKey: string;
  onResolve: (key: string, value: string) => void;
}> = ({ label, field, fieldKey, onResolve }) => {
  const [expanded, setExpanded] = useState(false);
  
  return (
    <div className={`p-4 rounded-xl border ${field.isConflict ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-slate-600">{label}</span>
        {field.isConflict && (
          <span className="flex items-center gap-1 text-xs text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full">
            <AlertTriangle size={12} />
            存在冲突
          </span>
        )}
      </div>
      <div className="text-base font-semibold text-slate-900">{field.value}</div>
      
      {field.isConflict && field.candidates.length > 1 && (
        <div className="mt-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-amber-700 hover:text-amber-800"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            查看候选值 ({field.candidates.length})
          </button>
          
          {expanded && (
            <div className="mt-2 space-y-2">
              {field.candidates.map((c, i) => (
                <button
                  key={i}
                  onClick={() => onResolve(fieldKey, c.value)}
                  className={`w-full flex items-center gap-2 p-2 rounded-lg border transition-colors text-left ${
                    field.value === c.value 
                      ? 'border-green-300 bg-green-50 ring-1 ring-green-200' 
                      : 'border-amber-200 bg-white hover:bg-amber-50'
                  }`}
                >
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                    field.value === c.value ? 'border-green-500 bg-green-500' : 'border-slate-300'
                  }`}>
                    {field.value === c.value && (
                      <div className="w-2 h-2 rounded-full bg-white"></div>
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-slate-800">{c.value}</div>
                    <div className="text-xs text-slate-500">{c.source}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// 风险项表格组件
const RiskTable: React.FC<{
  risks: InvalidationRisk[];
  startIndex: number;
  onRiskLocate?: (risk: { text: string; chapterTitle: string }) => void;
  compact?: boolean;
  locatingRiskText?: string;
}> = ({ risks, startIndex, onRiskLocate, compact, locatingRiskText }) => (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse">
      <thead>
        <tr className="bg-slate-100">
          <th className={`w-[5%] ${compact ? 'px-2 py-2' : 'px-3 py-3'} text-left text-xs font-semibold text-slate-600 border-b border-slate-200`}>#</th>
          <th className={`${compact ? 'w-[50%] px-2 py-2' : 'w-[40%] px-3 py-3'} text-left text-xs font-semibold text-slate-600 border-b border-slate-200`}>原文</th>
          {!compact && (
            <th className="w-[40%] px-3 py-3 text-left text-xs font-semibold text-slate-600 border-b border-slate-200">AI 分析</th>
          )}
          <th className={`${compact ? 'w-[30%] px-2 py-2' : 'w-[15%] px-3 py-3'} text-left text-xs font-semibold text-slate-600 border-b border-slate-200`}>来源</th>
        </tr>
      </thead>
      <tbody>
        {risks.map((risk, i) => {
          const isLocating = locatingRiskText === risk.originalText;
          return (
            <tr 
              key={i} 
              className={`transition-colors ${isLocating ? 'bg-red-50 ring-2 ring-red-300 ring-inset' : 'hover:bg-slate-50'}`}
            >
              <td className={`${compact ? 'px-2 py-2' : 'px-3 py-4'} align-top border-b border-slate-100`}>
                <span className={`inline-flex items-center justify-center ${compact ? 'w-5 h-5 text-xs' : 'w-7 h-7 text-sm'} rounded-lg ${isLocating ? 'bg-red-200 text-red-800' : 'bg-slate-200 text-slate-700'} font-medium`}>
                  {startIndex + i}
                </span>
              </td>
              <td className={`${compact ? 'px-2 py-2' : 'px-3 py-4'} align-top border-b border-slate-100`}>
                <p className={`${compact ? 'text-xs' : 'text-sm'} text-slate-800 leading-relaxed ${compact ? 'line-clamp-3' : ''}`}>
                  {risk.originalText}
                </p>
                {compact && (
                  <p className="text-xs text-slate-500 mt-1 line-clamp-2">{risk.aiAnalysis}</p>
                )}
              </td>
              {!compact && (
                <td className="px-3 py-4 align-top border-b border-slate-100">
                  <p className="text-sm text-slate-600 leading-relaxed">{risk.aiAnalysis}</p>
                </td>
              )}
              <td className={`${compact ? 'px-2 py-2' : 'px-3 py-4'} align-top border-b border-slate-100`}>
                <button
                  onClick={() => onRiskLocate?.({ text: risk.originalText, chapterTitle: risk.chapterTitle })}
                  className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg transition-colors cursor-pointer ${
                    isLocating 
                      ? 'bg-red-100 text-red-700 ring-1 ring-red-300' 
                      : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                  }`}
                  title={isLocating ? '点击取消定位' : '点击定位到原文'}
                >
                  <FileText size={10} />
                  <span className={compact ? 'max-w-[80px] truncate' : ''}>{risk.chapterTitle}</span>
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

// 分类风险组组件
const RiskCategoryGroup: React.FC<{
  category: RiskCategory;
  risks: InvalidationRisk[];
  startIndex: number;
  onRiskLocate?: (risk: { text: string; chapterTitle: string }) => void;
  compact?: boolean;
  locatingRiskText?: string;
}> = ({ category, risks, startIndex, onRiskLocate, compact, locatingRiskText }) => {
  const [expanded, setExpanded] = useState(true);
  
  const highCount = risks.filter(r => r.severity === 'high').length;
  const mediumCount = risks.filter(r => r.severity === 'medium').length;
  
  // 分类图标映射
  const categoryIcons: Record<RiskCategory, React.ReactNode> = {
    qualification: <Shield size={18} />,
    commercial: <FileJson size={18} />,
    technical: <Zap size={18} />,
    document: <ClipboardList size={18} />,
    timeline: <Clock size={18} />,
    other: <AlertTriangle size={18} />
  };
  
  // 分类颜色映射
  const categoryColors: Record<RiskCategory, string> = {
    qualification: 'from-blue-500 to-blue-600',
    commercial: 'from-emerald-500 to-emerald-600',
    technical: 'from-purple-500 to-purple-600',
    document: 'from-orange-500 to-orange-600',
    timeline: 'from-cyan-500 to-cyan-600',
    other: 'from-slate-500 to-slate-600'
  };

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden bg-white shadow-sm">
      {/* 分类标题栏 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${categoryColors[category]} text-white flex items-center justify-center shadow-sm`}>
            {categoryIcons[category]}
          </div>
          <div className="text-left">
            <h4 className="font-semibold text-slate-800">{RISK_CATEGORY_LABELS[category]}</h4>
            <p className="text-xs text-slate-500">{RISK_CATEGORY_DESC[category]}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            {highCount > 0 && (
              <span className="px-2 py-1 bg-red-100 text-red-700 rounded-full text-xs font-medium">
                {highCount} 高风险
              </span>
            )}
            {mediumCount > 0 && (
              <span className="px-2 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-medium">
                {mediumCount} 中风险
              </span>
            )}
          </div>
          {expanded ? <ChevronUp size={20} className="text-slate-400" /> : <ChevronDown size={20} className="text-slate-400" />}
        </div>
      </button>
      
      {/* 风险项表格 */}
      {expanded && (
        <div className={compact ? "p-2 pt-0" : "p-4 pt-0"}>
          <RiskTable 
            risks={risks} 
            startIndex={startIndex} 
            onRiskLocate={onRiskLocate}
            compact={compact}
            locatingRiskText={locatingRiskText}
          />
        </div>
      )}
    </div>
  );
};

// 分析仪表板组件
const AnalysisDashboard: React.FC<{
  keyInfo: KeyInformation;
  activeTab: 'basic' | 'risks' | 'scoring' | 'technical' | 'format';
  onTabChange: (tab: 'basic' | 'risks' | 'scoring' | 'technical' | 'format') => void;
  onConflictResolve: (key: string, value: string) => void;
  onClose: () => void;
  onRiskLocate?: (risk: { text: string; chapterTitle: string }) => void;
  compact?: boolean;  // 紧凑模式（用于左右分栏）
  locatingRiskText?: string;  // 当前定位的风险文本
}> = ({ keyInfo, activeTab, onTabChange, onConflictResolve, onClose, onRiskLocate, compact, locatingRiskText }) => {
  const tabs = [
    { id: 'basic', label: '基本信息', icon: <ClipboardList size={16} /> },
    { id: 'risks', label: '废标风险', icon: <AlertTriangle size={16} />, count: keyInfo.invalidationRisks.length },
    { id: 'scoring', label: '评分标准', icon: <Table size={16} /> },
    { id: 'technical', label: '技术要求', icon: <FileText size={16} /> },
    { id: 'format', label: '格式要求', icon: <FileJson size={16} /> },
  ];

  const conflictCount = Object.values(keyInfo.basicInfo).filter((f: any) => f.isConflict).length;
  const highRiskCount = keyInfo.invalidationRisks.filter(r => r.severity === 'high').length;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-purple-600 to-indigo-600 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-white/20 rounded-xl flex items-center justify-center">
              <Shield className="text-white" size={24} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">深度分析报告</h2>
              <p className="text-purple-100 text-sm">Regex + AI 混合分析结果</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/20 rounded-lg text-white transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* 统计摘要 */}
        <div className="mt-4 grid grid-cols-3 gap-4">
          <div className="bg-white/10 rounded-xl p-3">
            <div className="text-2xl font-bold text-white">{keyInfo.invalidationRisks.length}</div>
            <div className="text-purple-100 text-xs">废标风险项</div>
          </div>
          <div className="bg-white/10 rounded-xl p-3">
            <div className="text-2xl font-bold text-white">{highRiskCount}</div>
            <div className="text-purple-100 text-xs">高风险项</div>
          </div>
          <div className="bg-white/10 rounded-xl p-3">
            <div className="text-2xl font-bold text-white">{conflictCount}</div>
            <div className="text-purple-100 text-xs">信息冲突</div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-slate-50 overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id as any)}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === tab.id
                ? 'text-purple-600 border-b-2 border-purple-600 bg-white'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            {tab.icon}
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className={`ml-1 px-1.5 py-0.5 rounded-full text-xs ${
                tab.id === 'risks' ? 'bg-red-100 text-red-700' : 'bg-slate-200 text-slate-600'
              }`}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="p-6 max-h-[60vh] overflow-y-auto">
        {activeTab === 'basic' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <ConflictFieldDisplay label="项目名称" field={keyInfo.basicInfo.projectName} fieldKey="projectName" onResolve={onConflictResolve} />
              <ConflictFieldDisplay label="项目编号" field={keyInfo.basicInfo.projectCode} fieldKey="projectCode" onResolve={onConflictResolve} />
              <ConflictFieldDisplay label="采购人" field={keyInfo.basicInfo.purchaser} fieldKey="purchaser" onResolve={onConflictResolve} />
              <ConflictFieldDisplay label="代理机构" field={keyInfo.basicInfo.agency} fieldKey="agency" onResolve={onConflictResolve} />
              <ConflictFieldDisplay label="招标方式" field={keyInfo.basicInfo.biddingMethod} fieldKey="biddingMethod" onResolve={onConflictResolve} />
              <ConflictFieldDisplay label="投标截止时间" field={keyInfo.basicInfo.deadline} fieldKey="deadline" onResolve={onConflictResolve} />
              <ConflictFieldDisplay label="预算金额" field={keyInfo.basicInfo.budget} fieldKey="budget" onResolve={onConflictResolve} />
              <ConflictFieldDisplay label="开标地点" field={keyInfo.basicInfo.location} fieldKey="location" onResolve={onConflictResolve} />
              <ConflictFieldDisplay label="投标有效期" field={keyInfo.basicInfo.validity} fieldKey="validity" onResolve={onConflictResolve} />
              <ConflictFieldDisplay label="保证金" field={keyInfo.basicInfo.bond} fieldKey="bond" onResolve={onConflictResolve} />
            </div>

            {/* 审计逻辑 */}
            <div className="mt-6 p-4 bg-slate-50 rounded-xl border border-slate-200">
              <h4 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
                <Info size={16} className="text-slate-500" />
                审计逻辑说明
              </h4>
              <div className="space-y-2 text-sm">
                <p><span className="font-medium text-slate-600">符号定义:</span> {keyInfo.auditLogic.symbolDef}</p>
                <p><span className="font-medium text-slate-600">参考章节:</span> {keyInfo.auditLogic.chapterRef}</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {keyInfo.auditLogic.rejectKeywords.map((kw, i) => (
                    <span key={i} className="px-2 py-1 bg-red-100 text-red-700 rounded text-xs">{kw}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'risks' && (
          <div className="space-y-4">
            {keyInfo.invalidationRisks.length === 0 ? (
              <div className="text-center py-10">
                <CheckCircle size={48} className="text-green-500 mx-auto mb-3" />
                <p className="text-slate-600">未发现明显的废标风险项</p>
              </div>
            ) : (
              (() => {
                // 按分类分组
                const groupedRisks = keyInfo.invalidationRisks.reduce((acc, risk) => {
                  const cat = risk.category || 'other';
                  if (!acc[cat]) acc[cat] = [];
                  acc[cat].push(risk);
                  return acc;
                }, {} as Record<RiskCategory, typeof keyInfo.invalidationRisks>);
                
                // 分类排序顺序
                const categoryOrder: RiskCategory[] = ['qualification', 'commercial', 'technical', 'document', 'timeline', 'other'];
                
                let globalIndex = 0;
                
                return categoryOrder
                  .filter(cat => groupedRisks[cat]?.length > 0)
                  .map(cat => {
                    const risks = groupedRisks[cat];
                    const startIdx = globalIndex;
                    globalIndex += risks.length;
                    return (
                      <RiskCategoryGroup 
                        key={cat} 
                        category={cat} 
                        risks={risks} 
                        startIndex={startIdx + 1}
                        onRiskLocate={onRiskLocate}
                        compact={compact}
                        locatingRiskText={locatingRiskText}
                      />
                    );
                  });
              })()
            )}
          </div>
        )}

        {activeTab === 'scoring' && (
          <div>
            {keyInfo.scoringTableHtml ? (
              <div 
                className="prose prose-slate max-w-none"
                dangerouslySetInnerHTML={{ __html: keyInfo.scoringTableHtml }}
              />
            ) : (
              <div className="text-center py-10 text-slate-500">
                <Table size={48} className="mx-auto mb-3 text-slate-300" />
                <p>未找到评分标准章节</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'technical' && (
          <div>
            {keyInfo.technicalChapterHtml ? (
              <div 
                className="prose prose-slate max-w-none"
                dangerouslySetInnerHTML={{ __html: keyInfo.technicalChapterHtml }}
              />
            ) : (
              <div className="text-center py-10 text-slate-500">
                <FileText size={48} className="mx-auto mb-3 text-slate-300" />
                <p>未找到技术要求章节</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'format' && (
          <div>
            {keyInfo.formatChapterHtml ? (
              <div 
                className="prose prose-slate max-w-none"
                dangerouslySetInnerHTML={{ __html: keyInfo.formatChapterHtml }}
              />
            ) : (
              <div className="text-center py-10 text-slate-500">
                <FileJson size={48} className="mx-auto mb-3 text-slate-300" />
                <p>未找到格式要求章节</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// 分析进行中组件
const AnalyzingOverlay: React.FC<{ onCancel: () => void }> = ({ onCancel }) => (
  <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center">
    <div className="bg-white rounded-2xl p-8 shadow-2xl max-w-md text-center">
      <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <Loader2 size={32} className="text-purple-600 animate-spin" />
      </div>
      <h3 className="text-xl font-bold text-slate-800 mb-2">正在深度分析...</h3>
      <p className="text-slate-500 text-sm mb-4">
        正在执行 Regex 撒网 + AI 智能审计
      </p>
      <div className="space-y-2 text-left text-sm mb-6">
        <div className="flex items-center gap-2 text-slate-600">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
          <span>Step A: Regex 提取风险候选项...</span>
        </div>
        <div className="flex items-center gap-2 text-slate-600">
          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
          <span>Step B: Regex 扫描基本信息...</span>
        </div>
        <div className="flex items-center gap-2 text-slate-600">
          <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
          <span>Step C: HTML 切片提取关键章节...</span>
        </div>
        <div className="flex items-center gap-2 text-slate-600">
          <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse"></div>
          <span>Step D: AI 审计分析中...</span>
        </div>
      </div>
      <button
        onClick={onCancel}
        className="px-6 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors"
      >
        取消分析
      </button>
    </div>
  </div>
);

const FeatureCard: React.FC<{ icon: React.ReactNode, title: string, desc: string }> = ({ icon, title, desc }) => (
  <div className="p-5 bg-white border border-slate-200 rounded-xl shadow-sm hover:shadow-md transition-shadow">
    <div className="mb-3">{icon}</div>
    <h4 className="font-bold text-slate-800 mb-1">{title}</h4>
    <p className="text-slate-500 text-sm">{desc}</p>
  </div>
);

export default App;
