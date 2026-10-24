import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject } from 'rxjs';
import { ApiService } from './api.service';
import { ChatShellComponent } from './chat-shell.component';
import { ConversationSummary, MessageRead } from './models';

const conversation = (id: number): ConversationSummary => ({ id, title: 'Conversation ' + id, created_at: '', updated_at: '' });
const response = (text = 'Hello'): Response => new Response(new ReadableStream<Uint8Array>({ start(controller) {
  controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(text) + '\n\nevent: done\ndata: {}\n\n'));
  controller.close();
} }));

describe('ChatShellComponent request ownership', () => {
  let fixture: ComponentFixture<ChatShellComponent>;
  let component: ChatShellComponent;
  let api: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj<ApiService>('ApiService', ['listConversations', 'createConversation', 'getMessages', 'getHealth', 'chatStreamUrl', 'renameConversation', 'deleteConversation'], { defaultModel: 'local-model', isBrowser: true });
    api.listConversations.and.returnValue(of([]));
    api.createConversation.and.returnValue(of(conversation(1)));
    api.getMessages.and.returnValue(of([]));
    api.getHealth.and.returnValue(of({ status: 'ok', ollama: 'ok', model: 'local-model', models: ['local-model'] }));
    api.chatStreamUrl.and.returnValue('http://127.0.0.1:8000/chat');
    await TestBed.configureTestingModule({ imports: [ChatShellComponent], providers: [provideRouter([]), { provide: ApiService, useValue: api }] }).compileComponents();
    fixture = TestBed.createComponent(ChatShellComponent);
    component = fixture.componentInstance;
    component.connection = 'ready';
  });

  afterEach(() => fixture.destroy());

  it('creates a conversation on the first send and decodes streamed content', async () => {
    spyOn(window, 'fetch').and.resolveTo(response('A local response 🚀'));
    component.inputText = 'Explain this code';
    await component.sendMessage();
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(component.activeConversation?.id).toBe(1);
    expect(component.messages.map(item => item.content)).toEqual(['Explain this code', 'A local response 🚀']);
    expect(component.streaming).toBeFalse();
    expect(component.inputText).toBe('');
  });

  it('ignores an older history response after another conversation is selected', () => {
    const first = new Subject<MessageRead[]>();
    const second = new Subject<MessageRead[]>();
    api.getMessages.and.callFake(id => id === 1 ? first : second);
    component.selectConversation(conversation(1));
    component.selectConversation(conversation(2));
    second.next([{ id: 2, role: 'assistant', content: 'Current', created_at: '' }]);
    first.next([{ id: 1, role: 'assistant', content: 'Stale', created_at: '' }]);
    expect(component.messages[0].content).toBe('Current');
    expect(component.loadingMessages).toBeFalse();
  });

  it('does not let a stopped request finish a newer stream', async () => {
    let finishFirst!: (value: Response) => void;
    let finishSecond!: (value: Response) => void;
    spyOn(window, 'fetch').and.returnValues(new Promise(resolve => finishFirst = resolve), new Promise(resolve => finishSecond = resolve));
    component.activeConversation = conversation(1);
    component.inputText = 'First';
    const first = component.sendMessage();
    component.stopGeneration();
    expect(component.messages.filter(item => item.role === 'assistant')).toEqual([]);
    component.inputText = 'Second';
    const second = component.sendMessage();
    finishFirst(response('Old response'));
    await first;
    expect(component.streaming).toBeTrue();
    expect(component.messages.some(item => item.content === 'Old response')).toBeFalse();
    finishSecond(response('New response'));
    await second;
    expect(component.streaming).toBeFalse();
    expect(component.messages.at(-1)?.content).toBe('New response');
  });

  it('keeps partial text and reports a stream that closes without completion', async () => {
    spyOn(window, 'fetch').and.resolveTo(new Response('data: "Partial"\n\n'));
    component.activeConversation = conversation(1);
    component.inputText = 'Hello';
    await component.sendMessage();
    expect(component.messages.at(-1)?.content).toBe('Partial');
    expect(component.error).toContain('before completion');
    expect(component.streaming).toBeFalse();
  });

  it('uses an installed alternative when the configured default is missing', () => {
    api.getHealth.and.returnValue(of({ status: 'error', ollama: 'ok', model: 'missing', models: ['installed-local'] }));
    component.refreshHealth();
    expect(component.connection).toBe('ready');
    expect(component.model).toBe('installed-local');
  });

  it('preserves multiline and IME input without sending', () => {
    const send = spyOn(component, 'sendMessage');
    component.inputText = 'Draft';
    component.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    component.onComposerKeydown(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
    expect(send).not.toHaveBeenCalled();
  });
});
