import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatDialogModule } from '@angular/material/dialog';
import { MatCardModule } from '@angular/material/card';

import { ApiService } from './api.service';
import { ConversationSummary, MessageRead, MessageCreate, ChatRequest } from './models';
import { MarkdownPipe } from './markdown.pipe';

@Component({
  selector: 'app-chat-shell',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatListModule,
    MatToolbarModule,
    MatSidenavModule,
    MatDialogModule,
    MatCardModule,
    MarkdownPipe,
  ],
  templateUrl: './chat-shell.component.html',
  styleUrls: ['./chat-shell.component.scss'],
})
export class ChatShellComponent implements OnInit {
  conversations: ConversationSummary[] = [];
  activeConversation: ConversationSummary | null = null;
  messages: MessageRead[] = [];
  inputText = '';
  model = 'qwen2.5-coder:7b';
  streaming = false;
  error: string | null = null;
  private abortController: AbortController | null = null;

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    this.loadConversations();
  }

  loadConversations(): void {
    this.api.listConversations().subscribe({
      next: (conversations) => {
        this.conversations = conversations;
        if (!this.activeConversation && conversations.length > 0) {
          this.selectConversation(conversations[0]);
        }
      },
      error: () => {
        this.error = 'Unable to load conversations.';
      },
    });
  }

  createConversation(): void {
    this.api.createConversation().subscribe({
      next: (conversation) => {
        this.conversations = [conversation, ...this.conversations];
        this.selectConversation(conversation);
      },
      error: () => (this.error = 'Unable to create conversation.'),
    });
  }

  selectConversation(conversation: ConversationSummary): void {
    this.activeConversation = conversation;
    this.error = null;
    this.api.getMessages(conversation.id).subscribe({
      next: (messages) => (this.messages = messages),
      error: () => (this.error = 'Unable to load messages.'),
    });
  }

  stopGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.streaming = false;
    }
  }

  sendMessage(): void {
    if (!this.activeConversation || !this.inputText.trim()) {
      return;
    }

    const message: MessageCreate = { role: 'user', content: this.inputText.trim() };
    this.messages = [...this.messages, { id: Date.now(), role: 'user', content: this.inputText.trim(), created_at: new Date().toISOString() }];
    this.inputText = '';
    this.streaming = true;

    const request: ChatRequest = { model: this.model, messages: [message] };
    const controller = new AbortController();
    this.abortController = controller;
    let assistantMessage: MessageRead = {
      id: Date.now() + 1,
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
    };

    this.messages = [...this.messages, assistantMessage];
    this.streaming = true;

    const streamUrl = `http://127.0.0.1:8000/api/conversations/${this.activeConversation.id}/chat`;

    fetch(streamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Server error');
        }
        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response stream');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
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
                this.streaming = false;
                return;
              }
              assistantMessage = {
                ...assistantMessage,
                content: assistantMessage.content + payload,
              };
              this.messages = [
                ...this.messages.filter((msg) => msg.id !== assistantMessage.id),
                assistantMessage,
              ];
            }
          }
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          this.error = 'Generation cancelled.';
        } else {
          this.error = 'Stream error from backend.';
        }
      })
      .finally(() => {
        this.streaming = false;
      });
  }
}
