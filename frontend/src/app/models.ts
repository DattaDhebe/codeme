export interface ConversationSummary {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRead {
  id: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
}

export interface MessageCreate {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

export interface ChatRequest {
  model?: string;
  messages: MessageCreate[];
}
