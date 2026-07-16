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

export interface WorkspaceRead {
  id: number;
  display_name: string;
  root_path: string;
  created_at: string;
  updated_at: string;
}

export interface FileEntry {
  path: string;
  name: string;
  is_dir: boolean;
  size: number | null;
  modified_at: string | null;
}

export interface FileMetadata {
  path: string;
  is_dir: boolean;
  size: number;
  modified_at: string;
}

export interface FileRead {
  path: string;
  content: string;
  metadata: FileMetadata;
}

export interface SearchResult {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface GitStatusEntry {
  path: string;
  status: string;
}

export interface GitStatusResponse {
  is_git: boolean;
  status: GitStatusEntry[];
}
