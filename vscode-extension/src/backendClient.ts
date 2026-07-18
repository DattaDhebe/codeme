import * as vscode from 'vscode';

export interface BackendSettings {
  get<T>(section: string, defaultValue: T): T;
}

export interface HealthResponse {
  status: string;
  ollama?: string;
  model?: string;
  models?: string[];
}

export interface ConversationSummary {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
}

interface WorkspaceResponse {
  id: number;
}

export type AgentEvent =
  | { type: 'status'; label: string; detail?: string }
  | { type: 'tool'; name: string; summary: string; status: 'running' | 'complete' }
  | { type: 'proposal'; kind: 'file_change'; path: string; content: string; explanation: string }
  | { type: 'proposal'; kind: 'command'; command: string; explanation: string }
  | { type: 'message'; content: string };

const LOCALHOST_URLS = ['http://127.0.0.1', 'http://localhost'];

export class BackendClient {
  private controller?: AbortController;

  constructor(private config: BackendSettings) {}

  public get configuredModel(): string {
    return this.config.get('personalCodex.defaultModel', 'qwen2.5-coder:7b');
  }

  private get backendUrl(): string {
    return this.config.get('personalCodex.backendUrl', 'http://127.0.0.1:8000');
  }

  private get showNotifications(): boolean {
    return this.config.get('personalCodex.showNotifications', true);
  }

  public async checkConnection(userTriggered: boolean): Promise<HealthResponse> {
    if (!LOCALHOST_URLS.some((host) => this.backendUrl.startsWith(host))) {
      void vscode.window.showWarningMessage('Personal Codeme is configured to use a non-local backend URL.');
    }

    try {
      const response = await this.request<HealthResponse>('/health', undefined, 3000, 3);
      if (response.status === 'ok' && this.showNotifications && userTriggered) {
        const target = response.model ? `${response.model} through Ollama` : 'the local backend';
        void vscode.window.showInformationMessage(`Personal Codeme is connected to ${target}.`);
      }
      return response;
    } catch (error) {
      if (userTriggered) {
        void vscode.window.showErrorMessage('Unable to connect to the Personal Codeme backend.');
      }
      throw error;
    }
  }

  public async registerWorkspace(path: string, displayName: string): Promise<number> {
    const response = await this.post<WorkspaceResponse>('/workspaces', {
      path,
      display_name: displayName,
    });
    return response.id;
  }

  public async listConversations(query?: string): Promise<ConversationSummary[]> {
    const suffix = query ? `?query=${encodeURIComponent(query)}` : '';
    return this.request<ConversationSummary[]>(`/conversations${suffix}`);
  }

  public async createConversation(title?: string): Promise<ConversationSummary> {
    return this.post<ConversationSummary>('/conversations', { title: title || 'New chat' });
  }

  public async getConversationMessages(conversationId: number): Promise<ConversationMessage[]> {
    return this.request<ConversationMessage[]>(`/conversations/${conversationId}/messages`);
  }

  public async renameConversation(conversationId: number, title: string): Promise<ConversationSummary> {
    return this.request<ConversationSummary>(`/conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
  }

  public async deleteConversation(conversationId: number): Promise<void> {
    await this.request<void>(`/conversations/${conversationId}`, { method: 'DELETE' });
  }

  public async streamChat(
    conversationId: number,
    messages: Array<{ role: string; content: string }>,
    model: string | undefined,
    onChunk: (chunk: string) => void,
    onComplete: () => void,
    onError: (error: Error) => void
  ): Promise<void> {
    const url = this.getUrl(`/conversations/${conversationId}/chat`);
    this.controller = new AbortController();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model: model || this.configuredModel, messages }),
        signal: this.controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Backend request failed: ${response.status} ${await response.text()}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('The backend response stream is unavailable.');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      while (!completed) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            completed = true;
            break;
          }
          try {
            const decoded = JSON.parse(payload) as string | { error?: string };
            if (typeof decoded === 'string') {
              onChunk(decoded);
            } else if (decoded.error) {
              throw new Error(decoded.error);
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              onChunk(payload);
            } else {
              throw error;
            }
          }
        }
      }
      onComplete();
    } catch (error: unknown) {
      if ((error as Error)?.name === 'AbortError') {
        onError(new Error('Generation stopped.'));
      } else {
        onError(error as Error);
      }
    } finally {
      this.controller = undefined;
    }
  }

  public async streamAgent(
    conversationId: number,
    prompt: string,
    workspaceId: number,
    context: string | undefined,
    model: string | undefined,
    onEvent: (event: AgentEvent) => void,
    onComplete: () => void,
    onError: (error: Error) => void
  ): Promise<void> {
    const url = this.getUrl(`/conversations/${conversationId}/agent`);
    this.controller = new AbortController();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model: model || this.configuredModel, prompt, workspace_id: workspaceId, context }),
        signal: this.controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Backend request failed: ${response.status} ${await response.text()}`);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('The backend response stream is unavailable.');
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      while (!completed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          let eventName = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (eventName === 'done' || data === '[DONE]') {
            completed = true;
            break;
          }
          if (!data) continue;
          const decoded = JSON.parse(data) as AgentEvent | { error?: string };
          if (eventName === 'error' || 'error' in decoded) {
            throw new Error('error' in decoded ? decoded.error : 'Agent request failed.');
          }
          onEvent(decoded as AgentEvent);
        }
      }
      onComplete();
    } catch (error: unknown) {
      onError((error as Error)?.name === 'AbortError' ? new Error('Generation stopped.') : error as Error);
    } finally {
      this.controller = undefined;
    }
  }

  public cancel(): void {
    this.controller?.abort();
  }

  public updateSettings(config: vscode.WorkspaceConfiguration): void {
    this.config = config;
  }

  private getUrl(path: string): string {
    return `${this.backendUrl.replace(/\/+$/, '')}/api${path}`;
  }

  private async request<T>(path: string, init?: RequestInit, timeout = 5000, retries = 1): Promise<T> {
    const url = this.getUrl(path);
    const attempt = async (count: number): Promise<T> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { signal: controller.signal, ...init });
        if (!response.ok) {
          throw new Error(`Backend request failed: ${response.status} ${await response.text()}`);
        }
        if (response.status === 204) {
          return undefined as T;
        }
        return await response.json() as T;
      } catch (error) {
        if (count < retries && (error as Error).name !== 'AbortError') {
          await new Promise((resolve) => setTimeout(resolve, 200 * count));
          return attempt(count + 1);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };
    return attempt(1);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}
