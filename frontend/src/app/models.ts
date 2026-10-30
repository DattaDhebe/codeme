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

export interface HealthRead {
  status: string;
  provider?: 'ollama' | 'openai_compatible';
  ollama?: string;
  model?: string;
  models?: string[];
  detail?: string;
}

export interface ModelSetupStatus {
  state: 'idle' | 'checking' | 'runtime_missing' | 'server_unavailable' | 'downloading' | 'loading' | 'ready' | 'error' | 'cancelled';
  provider: 'ollama' | 'openai_compatible';
  model: string | null;
  available_models: string[];
  message: string;
  completed_bytes: number;
  total_bytes: number;
  percent: number | null;
  progress_scope?: string;
  error: string | null;
  can_retry: boolean;
  auto_setup_enabled: boolean;
}
