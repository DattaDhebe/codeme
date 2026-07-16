import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ChatRequest, ConversationSummary, MessageRead } from './models';

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

  chat(conversationId: number, request: ChatRequest): Observable<string> {
    const headers = new HttpHeaders({ Accept: 'text/event-stream' });
    return this.http.post(`${this.baseUrl}/conversations/${conversationId}/chat`, request, {
      headers,
      responseType: 'text',
    });
  }
}
