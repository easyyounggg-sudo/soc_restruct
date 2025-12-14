import React, { useState, useEffect } from 'react';
import { X, Key, Eye, EyeOff, CheckCircle, AlertTriangle, Sparkles } from 'lucide-react';
import { ApiKeyConfig } from '../types';

const API_KEY_STORAGE_KEY = 'gemini_api_key_config';

interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (apiKey: string) => void;
  currentApiKey: string | null;
}

export const getStoredApiKey = (): string | null => {
  try {
    const stored = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (stored) {
      const config: ApiKeyConfig = JSON.parse(stored);
      return config.apiKey;
    }
  } catch (e) {
    console.error('Failed to read API key from storage:', e);
  }
  return null;
};

export const saveApiKey = (apiKey: string): void => {
  const config: ApiKeyConfig = {
    provider: 'gemini',
    apiKey,
    savedAt: Date.now()
  };
  localStorage.setItem(API_KEY_STORAGE_KEY, JSON.stringify(config));
};

export const clearApiKey = (): void => {
  localStorage.removeItem(API_KEY_STORAGE_KEY);
};

export const ApiKeyModal: React.FC<ApiKeyModalProps> = ({ 
  isOpen, 
  onClose, 
  onSave,
  currentApiKey 
}) => {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen && currentApiKey) {
      setApiKey(currentApiKey);
    }
  }, [isOpen, currentApiKey]);

  const handleSave = () => {
    const trimmedKey = apiKey.trim();
    
    if (!trimmedKey) {
      setError('请输入 API Key');
      return;
    }
    
    // Gemini API keys typically start with "AIza"
    if (!trimmedKey.startsWith('AIza')) {
      setError('API Key 格式不正确，Gemini API Key 通常以 "AIza" 开头');
      return;
    }

    saveApiKey(trimmedKey);
    onSave(trimmedKey);
    setError('');
    onClose();
  };

  const handleClear = () => {
    clearApiKey();
    setApiKey('');
    onSave('');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                <Key className="text-white" size={20} />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">API Key 设置</h2>
                <p className="text-blue-100 text-sm">配置您的 Gemini API Key</p>
              </div>
            </div>
            <button 
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors"
            >
              <X className="text-white" size={20} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Info Box */}
          <div className="mb-5 p-4 bg-amber-50 border border-amber-100 rounded-xl">
            <div className="flex gap-3">
              <AlertTriangle className="text-amber-500 shrink-0 mt-0.5" size={18} />
              <div className="text-sm text-amber-800">
                <p className="font-medium mb-1">安全提示</p>
                <p className="text-amber-700">
                  API Key 将保存在浏览器本地存储中，仅在您的设备上使用。请勿在公共设备上保存 API Key。
                </p>
              </div>
            </div>
          </div>

          {/* Provider Badge */}
          <div className="mb-4">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium">
              <Sparkles size={14} />
              Google Gemini
            </span>
          </div>

          {/* Input */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Gemini API Key
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setError('');
                }}
                placeholder="AIza..."
                className={`w-full px-4 py-3 pr-12 border rounded-xl text-sm transition-all focus:outline-none focus:ring-2 ${
                  error 
                    ? 'border-red-300 focus:ring-red-500 bg-red-50' 
                    : 'border-slate-200 focus:ring-blue-500 bg-slate-50'
                }`}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 hover:bg-slate-200 rounded-md text-slate-500"
              >
                {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {error && (
              <p className="mt-2 text-sm text-red-600 flex items-center gap-1">
                <AlertTriangle size={14} />
                {error}
              </p>
            )}
          </div>

          {/* Help Link */}
          <div className="mb-6">
            <a 
              href="https://aistudio.google.com/app/apikey" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:text-blue-700 hover:underline"
            >
              → 前往 Google AI Studio 获取 API Key
            </a>
          </div>

          {/* Current Status */}
          {currentApiKey && (
            <div className="mb-6 p-3 bg-green-50 border border-green-100 rounded-xl flex items-center gap-2">
              <CheckCircle className="text-green-500" size={18} />
              <span className="text-sm text-green-700">当前已配置 API Key</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            {currentApiKey && (
              <button
                onClick={handleClear}
                className="px-4 py-2.5 text-red-600 hover:bg-red-50 rounded-xl text-sm font-medium transition-colors"
              >
                清除 Key
              </button>
            )}
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors shadow-lg shadow-blue-200"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ApiKeyModal;



