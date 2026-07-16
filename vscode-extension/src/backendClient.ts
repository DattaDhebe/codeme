import * as vscode from 'vscode';

export interface BackendSettings {
  get<T>(section: string, defaultValue: T): T;
}

interface HealthResponse {
  status: string;
}

interface CreateConversationResponse {
  id: number;
}

interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

const LOCALHOST_URLS = ['http://127.0.0.1', 'http://localhost'];

export class BackendClient {
  private controller?: AbortController;

  constructor(private readonly config: BackendSettings) {}

  private get backendUrl(): string {
    return this.config.get('personalCodex.backendUrl', 'http://127.0.0.1:8000');
  }

  private get defaultModel(): string {
    return this.config.get('personalCodex.defaultModel', 'qwen2.5-coder:7b');
  }

  private get showNotifications(): boolean {
    return this.config.get('personalCodex.showNotifications', true);
  }

  public async checkConnection(userTriggered: boolean): Promise<void> {
    if (!LOCALHOST_URLS.some((host) => this.backendUrl.startsWith(host))) {
      vscode.window.showWarningMessage('Personal Codex is configured to use a non-local backend URL.');
    }

    try {
      const response = await this.request<HealthResponse>('/health', undefined, 3000, 3);
      if (response?.status === 'ok' && this.showNotifications && userTriggered) {
        vscode.window.showInformationMessage('Personal Codex backend is available.');
      }
    } catch (error) {
      if (userTriggered) {
        vscode.window.showErrorMessage('Unable to connect to Personal Codex backend.');
      }
      throw error;
    }
  }

  public async registerWorkspace(path: string, displayName: string): Promise<number> {
    const response = await this.post<CreateConversationResponse>('/workspaces', {
      path,
      display_name: displayName,
    });
    return response.id;
  }

  public async createConversation(title?: string): Promise<number> {
    const response = await this.post<CreateConversationResponse>('/conversations', { title: title || 'Personal Codex' });
    return response.id;
  }

  public async streamChat(
    conversationId: number,
    messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void,
    onComplete: () => void,
    onError: (error: Error) => void
  ): Promise<void> {
    const url = this.getUrl(`/conversations/${conversationId}/chat`);

    this.controller = new AbortController();
    const signal = this.controller.signal;
    const requestInit: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model: this.defaultModel, messages }),
      signal,
    };

    try {
      const response = await fetch(url, requestInit);
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Backend request failed: ${response.status} ${body}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Stream is not available from backend');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          onComplete();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (!line) {
            continue;
          }
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              onComplete();
              return;
            }
            onChunk(payload);
          }
        }
      }
    } catch (error: unknown) {
      if ((error as Error)?.name === 'AbortError') {
        onError(new Error('Chat request cancelled'));
      } else {
        onError(error as Error);
      }
    }
  }

  public cancel(): void {
    this.controller?.abort();
  }

  public async updateSettings(config: vscode.WorkspaceConfiguration): Promise<void> {
    // Keep preferences local; no backend write.
  }

  private getUrl(path: string): string {
    return `${this.backendUrl.replace(/\/+$/, '')}/api${path}`;
  }

  private async request<T>(path: string, init?: RequestInit, timeout = 5000, retries = 1): Promise<T> {
    const url = this.getUrl(path);
    const attempt = async (count: number): Promise<T> => {
      const controller = new AbortController();
      const signal = controller.signal;
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { signal, ...init });
        clearTimeout(timer);
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Backend request failed: ${response.status} ${body}`);
        }
        return response.json();
      } catch (error) {
        clearTimeout(timer);
        if (count < retries && (error as Error).name !== 'AbortError') {
          await new Promise((resolve) => setTimeout(resolve, 200 * count));
          return attempt(count + 1);
        }
        throw error;
      }
    };
    return attempt(1);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}
