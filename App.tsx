
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
  Key
} from 'lucide-react';
import { AppState, ParsedDocument, Chapter, Message } from './types';
import { extractPerfectStructure, downloadJson } from './services/docxParser';
import { GoogleGenAI } from "@google/genai";
import { ApiKeyModal, getStoredApiKey } from './components/ApiKeyModal';

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


  // Load API Key from localStorage on mount
  useEffect(() => {
    const storedKey = getStoredApiKey();
    if (storedKey) {
      setUserApiKey(storedKey);
    }
  }, []);

  // Get the active API key (user's key takes priority)
  const getActiveApiKey = (): string | null => {
    return userApiKey || process.env.API_KEY || null;
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

    if (file.name.toLowerCase().endsWith('.doc')) {
      alert('抱歉，本工具仅支持现代 .docx 格式。请将您的 .doc 文件在 Word 中另存为 .docx 后再试。');
      return;
    }

    try {
      setState(AppState.PARSING);
      const parsed = await extractPerfectStructure(file);
      setDoc(parsed);
      if (parsed.chapters.length > 0) {
        setActiveChapterId(parsed.chapters[0].id);
      }
      setState(AppState.VIEWING);
      setMessages([]);
    } catch (error) {
      console.error('Parsing failed:', error);
      setState(AppState.ERROR);
    }
  };

  const handleExportJson = () => {
    if (doc) {
      downloadJson(doc, `${doc.name.replace('.docx', '')}_parsed.json`);
    }
  };

  const activeChapter = doc?.chapters.find(c => c.id === activeChapterId);
  const filteredChapters = doc?.chapters.filter(c => 
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

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
        model: 'gemini-2.5-flash-lite',
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
                placeholder="搜索章节..."
                className="w-full pl-10 pr-4 py-2 bg-slate-100 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>
          
          <nav className="flex-1 overflow-y-auto p-4 space-y-1">
            {filteredChapters.map((chapter) => (
              <button
                key={chapter.id}
                onClick={() => setActiveChapterId(chapter.id)}
                className={`w-full text-left px-4 py-3 rounded-xl transition-all flex items-center justify-between group ${
                  activeChapterId === chapter.id 
                    ? 'bg-blue-50 text-blue-700 shadow-sm border border-blue-100' 
                    : 'hover:bg-slate-50 text-slate-600'
                }`}
              >
                <span className="text-sm font-medium line-clamp-2">{chapter.title}</span>
                {activeChapterId === chapter.id && <ChevronRight size={16} />}
              </button>
            ))}
            {filteredChapters.length === 0 && (
              <div className="text-center py-10 text-slate-400 text-sm">
                未找到匹配章节
              </div>
            )}
          </nav>

          <div className="p-4 border-t border-slate-100 bg-slate-50">
            <button 
              onClick={handleExportJson}
              className="w-full flex items-center justify-center gap-2 py-2 px-4 bg-white border border-slate-200 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors shadow-sm"
            >
              <Download size={16} />
              导出 JSON
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
                  上传招标文件 (.docx)
                  <input 
                    type="file" 
                    accept=".docx" 
                    className="hidden" 
                    onChange={handleFileUpload} 
                  />
                </label>
                <span className="text-[10px] text-slate-400 mt-1 mr-1">※ 不支持旧版 .doc 格式</span>
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
                上传您的现代 Word 文档 (<b>.docx</b>)，系统将自动过滤目录干扰、智能提取章节结构、还原复杂表格，并高亮标注填空项。
              </p>
              
              <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border border-amber-100 rounded-xl text-amber-800 text-sm mb-10">
                <AlertCircle size={18} className="shrink-0" />
                <span><b>注意：</b> 不支持 2003 版及更早的 .doc 二进制格式。请先在 Word 中将其“另存为” .docx 文件。</span>
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

          {state === AppState.VIEWING && activeChapter && (
            <div className="max-w-4xl mx-auto bg-white border border-slate-100 rounded-2xl shadow-sm p-10 min-h-full transition-all duration-500">
              <div className="mb-8 pb-4 border-b border-slate-100">
                <span className="inline-block px-3 py-1 bg-blue-100 text-blue-700 rounded-lg text-xs font-bold uppercase tracking-wider mb-2">
                  当前章节
                </span>
                <h2 className="text-3xl font-bold text-slate-900">{activeChapter.title}</h2>
              </div>
              
              <div 
                className="prose prose-slate max-w-none text-slate-700 leading-8"
                dangerouslySetInnerHTML={{ __html: activeChapter.content }} 
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

const FeatureCard: React.FC<{ icon: React.ReactNode, title: string, desc: string }> = ({ icon, title, desc }) => (
  <div className="p-5 bg-white border border-slate-200 rounded-xl shadow-sm hover:shadow-md transition-shadow">
    <div className="mb-3">{icon}</div>
    <h4 className="font-bold text-slate-800 mb-1">{title}</h4>
    <p className="text-slate-500 text-sm">{desc}</p>
  </div>
);

export default App;
