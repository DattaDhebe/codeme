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
import { SseEvent, SseParser } from './sse-parser';

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
  model = '';
  models: string[] = [];
  streaming = false;
  error: string | null = null;
  private abortController: AbortController | null = null;

  constructor(private readonly api: ApiService) {
    this.model = api.defaultModel;
    this.models = [api.defaultModel];
  }

  ngOnInit(): void {
    this.loadConversations();
    if (this.api.isBrowser) {
      this.api.getHealth().subscribe({
        next: (health) => {
          this.models = health.models?.length ? health.models : this.models;
          if (!this.models.includes(this.model)) this.model = health.model || this.models[0] || this.api.defaultModel;
        },
      });
    }
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

    const streamUrl = this.api.chatStreamUrl(this.activeConversation.id);

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
        const parser = new SseParser();
        let completed = false;

        const handleEvent = (event: SseEvent): void => {
          if (event.event === 'done' || event.data === '[DONE]') {
            completed = true;
            return;
          }
          if (event.event === 'error') {
            const decoded = JSON.parse(event.data) as { error?: string };
            throw new Error(decoded.error || 'Backend stream error');
          }
          const decoded = JSON.parse(event.data) as string | { error?: string };
          if (typeof decoded !== 'string') {
            throw new Error(decoded.error || 'Unexpected backend stream payload');
          }
          assistantMessage = { ...assistantMessage, content: assistantMessage.content + decoded };
          this.messages = [...this.messages.filter((msg) => msg.id !== assistantMessage.id), assistantMessage];
        };

        while (!completed) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          parser.feed(decoder.decode(value, { stream: true })).forEach(handleEvent);
        }
        const finalText = decoder.decode();
        if (finalText) parser.feed(finalText).forEach(handleEvent);
        parser.finish().forEach(handleEvent);
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
