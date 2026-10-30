import { ComponentFixture, fakeAsync, flushMicrotasks, TestBed, tick } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { of, Subject, throwError } from 'rxjs';
import { ApiService } from './api.service';
import { ChatShellComponent } from './chat-shell.component';
import { ConversationSummary, MessageRead, ModelSetupStatus } from './models';

const conversation = (id: number): ConversationSummary => ({ id, title: 'Conversation ' + id, created_at: '', updated_at: '' });
const setupStatus = (changes: Partial<ModelSetupStatus> = {}): ModelSetupStatus => ({
  state: 'ready', provider: 'ollama', model: 'local-model', available_models: ['local-model'],
  message: 'Your local model is ready.', completed_bytes: 0, total_bytes: 0, percent: null,
  error: null, can_retry: false, auto_setup_enabled: true, ...changes,
});
const response = (text = 'Hello'): Response => new Response(new ReadableStream<Uint8Array>({ start(controller) {
  controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(text) + '\n\nevent: done\ndata: {}\n\n'));
  controller.close();
} }));

describe('ChatShellComponent request ownership', () => {
  let fixture: ComponentFixture<ChatShellComponent>;
  let component: ChatShellComponent;
  let api: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj<ApiService>('ApiService', ['listConversations', 'createConversation', 'getMessages', 'getHealth', 'chatStreamUrl', 'renameConversation', 'deleteConversation', 'getModelSetup', 'startModelSetup', 'cancelModelSetup'], { defaultModel: 'local-model', isBrowser: true });
    api.listConversations.and.returnValue(of([]));
    api.createConversation.and.returnValue(of(conversation(1)));
    api.getMessages.and.returnValue(of([]));
    api.getHealth.and.returnValue(of({ status: 'ok', ollama: 'ok', model: 'local-model', models: ['local-model'] }));
    api.getModelSetup.and.returnValue(of(setupStatus()));
    api.startModelSetup.and.returnValue(of(setupStatus()));
    api.cancelModelSetup.and.returnValue(of(setupStatus({ state: 'cancelled', can_retry: true })));
    api.chatStreamUrl.and.returnValue('http://127.0.0.1:8000/chat');
    sessionStorage.removeItem('codeme:drafts:v1:http://127.0.0.1:8000/chat');
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

  it('follows setup already started by the backend, shows real progress, and selects the ready model', fakeAsync(() => {
    api.getModelSetup.and.returnValues(
      of(setupStatus({ state: 'checking', available_models: [], message: 'Checking installed models.' })),
      of(setupStatus({ state: 'downloading', model: 'coding-local', available_models: [], completed_bytes: 1024, total_bytes: 4096, percent: 25, message: 'Downloading model weights.' })),
      of(setupStatus({ model: 'coding-local', available_models: ['coding-local'] })),
    );
    fixture.detectChanges();
    component.inputText = 'Hello';
    expect(component.canSend).toBeFalse();
    expect(api.startModelSetup).not.toHaveBeenCalled();
    tick(1000);
    fixture.detectChanges();
    const progress: HTMLProgressElement = fixture.nativeElement.querySelector('progress');
    expect(progress.value).toBe(25);
    expect(fixture.nativeElement.textContent).toContain('1.0 KB of 4.0 KB');
    tick(1000);
    expect(component.model).toBe('coding-local');
    expect(component.connection).toBe('ready');
    expect(component.canSend).toBeTrue();
    fixture.destroy();
  }));

  it('honors disabled automatic setup and lets the user start it explicitly', () => {
    api.getModelSetup.and.returnValue(of(setupStatus({ state: 'idle', available_models: [], auto_setup_enabled: false })));
    component.refreshModelSetup();
    component.inputText = 'Hello';
    expect(api.startModelSetup).not.toHaveBeenCalled();
    expect(component.canSend).toBeFalse();
    component.startModelSetup();
    expect(api.startModelSetup).toHaveBeenCalledTimes(1);
    expect(component.canSend).toBeTrue();
  });

  it('starts an enabled idle setup only once while polling its state', fakeAsync(() => {
    api.getModelSetup.and.returnValue(of(setupStatus({ state: 'idle', available_models: [] })));
    api.startModelSetup.and.returnValue(of(setupStatus({ state: 'checking', available_models: [] })));
    component.refreshModelSetup();
    expect(api.startModelSetup).toHaveBeenCalledTimes(1);
    tick(1000);
    component.refreshModelSetup();
    expect(api.startModelSetup).toHaveBeenCalledTimes(1);
    fixture.destroy();
  }));

  it('preserves an explicitly selected model when it is still installed', () => {
    component.model = 'my-installed-model';
    api.getModelSetup.and.returnValue(of(setupStatus({ available_models: ['local-model', 'my-installed-model'] })));
    component.refreshModelSetup();
    expect(component.model).toBe('my-installed-model');
  });

  it('does not overlap setup requests or keep polling after the component is destroyed', fakeAsync(() => {
    const pending = new Subject<ModelSetupStatus>();
    api.getModelSetup.and.returnValue(pending);
    component.refreshModelSetup();
    component.refreshModelSetup();
    expect(api.getModelSetup).toHaveBeenCalledTimes(1);
    pending.next(setupStatus({ state: 'downloading', percent: null }));
    fixture.destroy();
    tick(2000);
    expect(api.getModelSetup).toHaveBeenCalledTimes(1);
  }));

  it('recovers from an unavailable backend without starting a second model download', () => {
    api.getModelSetup.and.returnValue(throwError(() => new Error('offline')));
    component.refreshModelSetup();
    expect(component.connection).toBe('offline');
    expect(component.setupError).toContain('local backend');
    api.getModelSetup.and.returnValue(of(setupStatus()));
    component.reconnect();
    expect(component.setupError).toBe('');
    expect(component.connection).toBe('ready');
    expect(api.startModelSetup).not.toHaveBeenCalled();
  });

  it('cancels setup and stops polling until the user retries', fakeAsync(() => {
    api.getModelSetup.and.returnValue(of(setupStatus({ state: 'downloading', percent: 10 })));
    component.refreshModelSetup();
    component.cancelModelSetup();
    expect(component.modelSetup?.state).toBe('cancelled');
    tick(2000);
    expect(api.getModelSetup).toHaveBeenCalledTimes(1);
    fixture.destroy();
  }));

  it('offers setup recovery when a previously ready local model server stops', () => {
    component.refreshModelSetup();
    api.getHealth.and.returnValue(throwError(() => new HttpErrorResponse({ status: 503 })));
    component.refreshHealth();
    expect(component.connection).toBe('model-missing');
    expect(component.modelSetup?.state).toBe('server_unavailable');
    expect(component.modelSetup?.can_retry).toBeTrue();
  });

  it('keeps progress indeterminate while the download size is unknown', () => {
    api.getModelSetup.and.returnValue(of(setupStatus({ state: 'downloading', percent: null, progress_scope: 'layer' })));
    fixture.detectChanges();
    const progress: HTMLProgressElement = fixture.nativeElement.querySelector('progress');
    expect(progress.hasAttribute('value')).toBeFalse();
    expect(progress.getAttribute('aria-label')).toContain('Current model layer');
    fixture.destroy();
  });

  it('waits for cancelled setup to release its worker before offering another attempt', fakeAsync(() => {
    api.getModelSetup.and.returnValues(
      of(setupStatus({ state: 'cancelled', can_retry: false })),
      of(setupStatus({ state: 'cancelled', can_retry: true })),
    );
    component.refreshModelSetup();
    tick(1000);
    expect(component.modelSetup?.can_retry).toBeTrue();
    tick(2000);
    expect(api.getModelSetup).toHaveBeenCalledTimes(2);
    fixture.destroy();
  }));

  it('ignores a stale health failure after a newer setup snapshot confirms readiness', () => {
    const health = new Subject<never>();
    api.getHealth.and.returnValue(health);
    component.refreshHealth();
    component.refreshModelSetup();
    health.error(new HttpErrorResponse({ status: 503 }));
    expect(component.connection).toBe('ready');
    expect(component.modelSetup?.state).toBe('ready');
    expect(component.healthChecking).toBeFalse();
  });

  it('can cancel while a passive setup status read is still pending', () => {
    const pending = new Subject<ModelSetupStatus>();
    api.getModelSetup.and.returnValue(pending);
    component.refreshModelSetup();
    component.cancelModelSetup();
    pending.next(setupStatus());
    expect(api.cancelModelSetup).toHaveBeenCalledTimes(1);
    expect(component.modelSetup?.state).toBe('cancelled');
    expect(component.setupRequestPending).toBeFalse();
  });

  it('keeps the Cancel setup control available during a pending status poll', () => {
    fixture.detectChanges();
    const pending = new Subject<ModelSetupStatus>();
    api.getModelSetup.and.returnValues(of(setupStatus({ state: 'downloading' })), pending);
    component.refreshModelSetup(); component.refreshModelSetup();
    fixture.detectChanges();
    const button = [...fixture.nativeElement.querySelectorAll('button')].find((item: unknown) => (item as HTMLButtonElement).textContent?.trim() === 'Cancel setup') as HTMLButtonElement;
    expect(button).toBeTruthy();
    button.click();
    expect(api.cancelModelSetup).toHaveBeenCalledTimes(1);
  });

  it('recovers unsent drafts after navigating away and recreating the chat view', () => {
    fixture.detectChanges();
    component.inputText = 'A draft to keep when exploring the workspace';
    fixture.destroy();
    fixture = TestBed.createComponent(ChatShellComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    expect(component.inputText).toBe('A draft to keep when exploring the workspace');
  });

  it('keeps a separate draft for each saved conversation across view recreation', () => {
    fixture.detectChanges();
    component.selectConversation(conversation(2));
    component.inputText = 'Continue working on this parser';
    fixture.destroy();
    fixture = TestBed.createComponent(ChatShellComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    component.selectConversation(conversation(2));
    expect(component.inputText).toBe('Continue working on this parser');
  });

  it('does not treat chat-only model readiness as a chat failure', () => {
    api.getModelSetup.and.returnValue(of(setupStatus({ tool_support: 'unsupported', agent_ready: false })));
    component.refreshModelSetup();
    component.inputText = 'Explain this function';
    expect(component.canSend).toBeTrue();
    expect(component.modelCapabilityNotice).toContain('Agent tasks in VS Code');
  });

  it('fails a stalled model request without discarding its draft or locking Stop forever', fakeAsync(() => {
    spyOn(window, 'fetch').and.callFake((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    component.activeConversation = conversation(1);
    component.inputText = 'Explain this code';
    void component.sendMessage();
    tick(180000);
    flushMicrotasks();
    expect(component.streaming).toBeFalse();
    expect(component.error).toContain('three minutes');
    expect(component.messages.some(message => message.role === 'user' && message.content === 'Explain this code')).toBeTrue();
  }));
});
