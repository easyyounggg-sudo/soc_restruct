
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