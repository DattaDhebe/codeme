import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import {
  ChatRequest,
  ConversationSummary,
  FileEntry,
  FileRead,
  GitStatusResponse,
  MessageRead,
  SearchResult,
  WorkspaceRead,
} from './models';

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private readonly baseUrl = 'http://127.0.0.1:8000/api';

  constructor(private readonly http: HttpClient) {}

  listConversations(query?: string): Observable<ConversationSummary[]> {
    return this.http.get<ConversationSummary[]>(`${this.baseUrl}/conversations`, {
      params: query ? { query } : undefined,
    });
  }

  createConversation(): Observable<ConversationSummary> {
    return this.http.post<ConversationSummary>(`${this.baseUrl}/conversations`, { title: 'New conversation' });
  }

  renameConversation(id: number, title: string): Observable<ConversationSummary> {
    return this.http.patch<ConversationSummary>(`${this.baseUrl}/conversations/${id}`, { title });
  }

  deleteConversation(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/conversations/${id}`);
  }

  getMessages(conversationId: number): Observable<MessageRead[]> {
    return this.http.get<MessageRead[]>(`${this.baseUrl}/conversations/${conversationId}/messages`);
  }

  listWorkspaces(): Observable<WorkspaceRead[]> {
    return this.http.get<WorkspaceRead[]>(`${this.baseUrl}/workspaces`);
  }

  createWorkspace(path?: string, displayName?: string): Observable<WorkspaceRead> {
    return this.http.post<WorkspaceRead>(`${this.baseUrl}/workspaces`, {
      path,
      display_name: displayName,
    });
  }

  deleteWorkspace(workspaceId: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/workspaces/${workspaceId}`);
  }

  listFiles(workspaceId: number, path?: string, page = 1, pageSize = 50): Observable<{ entries: FileEntry[]; page: number; page_size: number; has_more: boolean }> {
    return this.http.get<{ entries: FileEntry[]; page: number; page_size: number; has_more: boolean }>(`${this.baseUrl}/workspaces/${workspaceId}/files`, {
      params: path ? { path, page: String(page), page_size: String(pageSize) } : { page: String(page), page_size: String(pageSize) },
    });
  }

  readFile(workspaceId: number, path: string): Observable<FileRead> {
    return this.http.get<FileRead>(`${this.baseUrl}/workspaces/${workspaceId}/files/content`, {
      params: { path },
    });
  }

  searchWorkspace(workspaceId: number, query: string, page = 1, pageSize = 50): Observable<{ results: SearchResult[]; page: number; page_size: number; has_more: boolean }> {
    return this.http.get<{ results: SearchResult[]; page: number; page_size: number; has_more: boolean }>(`${this.baseUrl}/workspaces/${workspaceId}/search`, {
      params: { query, page: String(page), page_size: String(pageSize) },
    });
  }

  getGitStatus(workspaceId: number): Observable<GitStatusResponse> {
    return this.http.get<GitStatusResponse>(`${this.baseUrl}/workspaces/${workspaceId}/git/status`);
  }

  getGitDiff(workspaceId: number, path: string): Observable<{ path: string | null; diff: string }> {
    return this.http.get<{ path: string | null; diff: string }>(`${this.baseUrl}/workspaces/${workspaceId}/git/diff`, {
      params: { path },
    });
  }

  getAgentInstructions(workspaceId: number, path?: string): Observable<{ instructions: { path: string; content: string }[] }> {
    return this.http.get<{ instructions: { path: string; content: string }[] }>(`${this.baseUrl}/workspaces/${workspaceId}/agents`, {
      params: path ? { path } : undefined,
    });
  }

  chat(conversationId: number, request: ChatRequest): Observable<string> {
    const headers = new HttpHeaders({ Accept: 'text/event-stream' });
    return this.http.post(`${this.baseUrl}/conversations/${conversationId}/chat`, request, {
      headers,
      responseType: 'text',
    });
  }
}
