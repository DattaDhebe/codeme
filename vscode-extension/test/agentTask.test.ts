import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRun, BackendClient } from '../src/backendClient';
import { PersonalCodexSidebarProvider } from '../src/sidebarProvider';
import * as vscode from 'vscode';

const task = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: 'task-1', conversation_id: 4, workspace_id: 8, goal: 'Fix parser', provider: 'ollama',
  status: 'awaiting_approval', plan: [{ id: 'inspect', description: 'Inspect parser', status: 'completed' }],
  cycle_count: 1, max_cycles: 8, time_budget_seconds: 900, elapsed_ms: 1000,
  evidence: {}, requires_verification: true, created_at: '2026-01-01', updated_at: '2026-01-01',
  pending_change_set_ids: ['edit-1'], pending_command_run_ids: ['command-1'], ...overrides,
});
const providerFor = (backend: Record<string, unknown> = {}): any => {
  const provider = Object.create(PersonalCodexSidebarProvider.prototype);
  Object.assign(provider, {
    backend: { cancel: vi.fn(), ...backend }, chatGeneration: 0, conversationLoadGeneration: 0,
    selectedConversationId: 4, currentWorkspaceId: 8, agentRuns: new Map([[4, task()]]),
    continuingAgentRuns: new Set(), pendingTaskContinuations: new Map(), cancelledAgentRuns: new Set(), cancellingAgentRuns: new Set(),
    taskActiveCommands: new Map(), taskVerificationOwners: new Map(), legacyChangeSets: new Map(),
    send: vi.fn().mockResolvedValue(undefined), processRunner: { cancel: vi.fn().mockResolvedValue(undefined) },
  });
  return provider;
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('durable local task transport', () => {
  it('resumes using server-owned state and consumes task, plan, and outcome records', async () => {
    const run = task();
    const events = [
      { type: 'task', run }, { type: 'plan', steps: run.plan },
      { type: 'outcome', status: 'awaiting_approval', summary: 'Review the parser fix.' },
    ];
    const frames = events.map((value) => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'event: done\ndata: [DONE]\n\n';
    const fetchMock = vi.fn().mockResolvedValue(new Response(frames));
    vi.stubGlobal('fetch', fetchMock);
    const client = new BackendClient({ get: (_key, value) => value });
    const consume = vi.fn(); const done = vi.fn(); const failure = vi.fn();
    await client.continueAgentRun(run.id, consume, done, failure);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8000/api/agent-runs/task-1/continue', expect.objectContaining({ method: 'POST', body: '{}', redirect: 'error' }));
    expect(consume.mock.calls.map(([event]) => event)).toEqual(events);
    expect(done).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
  });
  it('preserves pending-action conflicts for the UI instead of assuming success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Pending verification approval', { status: 409 })));
    const client = new BackendClient({ get: (_key, value) => value });
    const done = vi.fn(); const failure = vi.fn();
    await client.continueAgentRun('task-1', vi.fn(), done, failure);
    expect(done).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('409') }));
  });
});

describe('task approvals and request ownership', () => {
  it('finishes the UI resume request when a saved task is already completed', async () => {
    const provider = providerFor({ getAgentRun: vi.fn().mockResolvedValue(task({ status: 'completed' })), continueAgentRun: vi.fn() });
    await provider.continueTask('task-1', 'resume-completed');
    expect(provider.send).toHaveBeenCalledWith({ command: 'streamStopped', payload: { conversationId: 4, requestId: 'resume-completed' } });
    expect(provider.backend.continueAgentRun).not.toHaveBeenCalled();
    expect(provider.activeChat).toBeUndefined();
  });

  it('finishes a rejected resume request when its workspace is unavailable', async () => {
    const provider = providerFor({ continueAgentRun: vi.fn() });
    provider.currentWorkspaceId = undefined;
    await provider.continueTask('task-1', 'resume-no-workspace');
    expect(provider.send).toHaveBeenCalledWith({ command: 'streamStopped', payload: { conversationId: 4, requestId: 'resume-no-workspace' } });
    expect(provider.backend.continueAgentRun).not.toHaveBeenCalled();
  });

  it('keeps verification repairs on the original task model after automatic setup selected it', async () => {
    const provider = providerFor({ prepareVerificationRepair: vi.fn().mockResolvedValue({ id: 'verify-1', state: 'AWAITING_REPAIR_APPROVAL' }), configuredModel: 'missing-configured-model' });
    provider.agentRuns.set(4, task({ model: 'installed-local-coder' }));
    provider.taskVerificationOwners.set('verify-1', { runId: 'task-1', generation: 0 });
    provider.executingVerifications = new Set(); provider.activeVerificationCommands = new Map();
    provider.publishVerification = vi.fn();
    await provider.executeVerification({ id: 'verify-1', state: 'VERIFICATION_FAILED', maximum_repair_attempts: 1, current_attempt: 0 });
    expect(provider.backend.prepareVerificationRepair).toHaveBeenCalledWith('verify-1', 'installed-local-coder');
  });

  it('creates a verification plan after an approved task edit without executing it', async () => {
    const provider = providerFor();
    provider.applyChangeSet = vi.fn().mockResolvedValue({ id: 'edit-1', conversation_id: 4 });
    provider.startVerification = vi.fn(); provider.continueTask = vi.fn();
    await provider.handleMessage({ command: 'applyChangeSet', args: { changeSet: { id: 'edit-1', conversation_id: 4 } } });
    expect(provider.startVerification).toHaveBeenCalledWith(4, 'Fix parser', 'edit-1', 'quick', 'task-1');
    expect(provider.continueTask).not.toHaveBeenCalled();
  });
  it('does not create a verification plan when applying was declined', async () => {
    const provider = providerFor();
    provider.applyChangeSet = vi.fn().mockResolvedValue(undefined); provider.startVerification = vi.fn();
    await provider.handleMessage({ command: 'applyChangeSet', args: { changeSet: { id: 'edit-1', conversation_id: 4 } } });
    expect(provider.startVerification).not.toHaveBeenCalled();
  });
  it('does not resume or create verification for a task superseded while approval was open', async () => {
    const provider = providerFor();
    provider.applyChangeSet = vi.fn().mockImplementation(async () => { provider.chatGeneration++; return { id: 'edit-1' }; });
    provider.startVerification = vi.fn();
    await provider.handleMessage({ command: 'applyChangeSet', args: { changeSet: { id: 'edit-1', conversation_id: 4 } } });
    expect(provider.startVerification).not.toHaveBeenCalled();
    expect(provider.ownsTask('task-1', 4, 0)).toBe(false);
  });
  it.each(['interrupted', 'blocked'] as const)('keeps %s tasks stopped until an explicit resume', async (status) => {
    const provider = providerFor({ getAgentRun: vi.fn().mockResolvedValue(task({ status })), continueAgentRun: vi.fn() });
    await provider.continueTask('task-1', undefined, true);
    expect(provider.backend.continueAgentRun).not.toHaveBeenCalled();
  });
  it('treats pending actions as waiting for review after a resume conflict', async () => {
    const provider = providerFor({
      getAgentRun: vi.fn().mockResolvedValue(task()),
      continueAgentRun: vi.fn().mockImplementation(async (_id, _event, _done, fail) => fail(new Error('Backend request failed: 409 pending approval'))),
    });
    await provider.continueTask('task-1', 'resume-1');
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ command: 'taskNotice' }));
    expect(provider.send.mock.calls.some(([message]: [{command: string}]) => message.command === 'streamError')).toBe(false);
    expect(provider.activeChat).toBeUndefined();
  });
  it('continues only after an explicitly approved command result is recorded', async () => {
    const command = {id:'command-1', conversation_id:4, workspace_id:8, status:'proposed'};
    const provider = providerFor({
      getCommandRun: vi.fn().mockResolvedValue(command),
      decideCommandRun: vi.fn().mockResolvedValue({...command,status:'approved'}),
      reportCommandEvent: vi.fn().mockResolvedValue({...command,status:'running'}),
      reportCommandResult: vi.fn().mockResolvedValue({...command,status:'completed'}),
    });
    provider.evaluateCommand = vi.fn().mockResolvedValue({risks:[], risk:'READ_ONLY', args:[], environmentKeys:[], explanation:'Local check'});
    provider.processRunner.run = vi.fn().mockResolvedValue({status:'completed'});
    provider.continueTask = vi.fn();
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Run once' as never);
    await provider.runControlledCommand(command);
    expect(provider.backend.decideCommandRun).toHaveBeenCalled();
    expect(provider.backend.reportCommandResult).toHaveBeenCalledWith('command-1', {status:'completed'});
    expect(provider.continueTask).toHaveBeenCalledWith('task-1', undefined, true, 0);
    expect(provider.backend.reportCommandResult.mock.invocationCallOrder[0]).toBeLessThan(provider.continueTask.mock.invocationCallOrder[0]);
  });
  it('does not run or continue a command when approval is declined', async () => {
    const command = {id:'command-1', conversation_id:4, workspace_id:8, status:'proposed'};
    const provider = providerFor({getCommandRun: vi.fn().mockResolvedValue(command), decideCommandRun:vi.fn()});
    provider.evaluateCommand = vi.fn().mockResolvedValue({risks:[], risk:'READ_ONLY', args:[], environmentKeys:[]});
    provider.continueTask = vi.fn(); provider.processRunner.run = vi.fn();
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    await provider.runControlledCommand(command);
    expect(provider.backend.decideCommandRun).not.toHaveBeenCalled();
    expect(provider.processRunner.run).not.toHaveBeenCalled();
    expect(provider.continueTask).not.toHaveBeenCalled();
  });
  it('shows a model-proposed verification plan without approving or executing it', async () => {
    const provider = providerFor();
    provider.publishVerification = vi.fn().mockResolvedValue(undefined);
    provider.approveVerification = vi.fn(); provider.executeVerification = vi.fn();
    const session = { id:'verify-proposed',conversation_id:4,workspace_id:8,state:'AWAITING_PLAN_APPROVAL',steps:[] };
    provider.acceptAgentEvent({ type:'proposal',kind:'verification_plan',verification_session:session },4,'request-1',0,{requestId:'request-1',conversationId:4,runId:'task-1'});
    await Promise.resolve();
    expect(provider.publishVerification).toHaveBeenCalledWith(session);
    expect(provider.taskVerificationOwners.get(session.id)).toEqual({runId:'task-1',generation:0});
    expect(provider.approveVerification).not.toHaveBeenCalled();
    expect(provider.executeVerification).not.toHaveBeenCalled();
    expect(provider.send.mock.calls.some(([message]:[{command:string}])=>message.command==='agentEvent')).toBe(false);
  });
  it('continues once after terminal verification while preserving plan approval boundaries', async () => {
    const provider = providerFor();
    provider.taskVerificationOwners.set('verify-1',{runId:'task-1',generation:0});
    provider.continueTask = vi.fn();
    const session = {id:'verify-1',conversation_id:4,state:'AWAITING_PLAN_APPROVAL',steps:[]};
    await provider.publishVerification(session);
    expect(provider.continueTask).not.toHaveBeenCalled();
    await provider.publishVerification({...session,state:'PASSED'});
    await provider.publishVerification({...session,state:'PASSED'});
    expect(provider.continueTask).toHaveBeenCalledOnce();
    expect(provider.continueTask).toHaveBeenCalledWith('task-1',undefined,true,0);
  });
  it('loads a saved task and proposals without automatically resuming or executing', async () => {
    const provider = providerFor({
      getConversationMessages: vi.fn().mockResolvedValue([]), listAgentRuns: vi.fn().mockResolvedValue([task({status:'interrupted'})]),
      getChangeSet: vi.fn().mockResolvedValue({ id: 'edit-1', status: 'applied' }),
      getCommandRun: vi.fn().mockResolvedValue({ id: 'command-1', status: 'completed' }),
      continueAgentRun: vi.fn(),
    });
    provider.prepareCommandProposalEvent = vi.fn();
    await provider.loadConversation(4);
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({command:'agentRunUpdated'}));
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({command:'agentProposalRecovered'}));
    expect(provider.prepareCommandProposalEvent).toHaveBeenCalledWith(4, {id:'command-1',status:'completed'}, undefined, 0, true);
    expect(provider.backend.continueAgentRun).not.toHaveBeenCalled();
  });
  it('cancels only the task-owned local processes and verification sessions', async () => {
    const provider = providerFor({ cancelAgentRun: vi.fn().mockResolvedValue(task({status:'cancelled'})) });
    provider.taskActiveCommands.set('command-1', {runId:'task-1', conversationId:4});
    provider.taskActiveCommands.set('other-command', {runId:'other-task', conversationId:5});
    provider.taskVerificationOwners.set('verify-1', {runId:'task-1', generation:0});
    provider.taskVerificationOwners.set('other-verify', {runId:'other-task', generation:0});
    provider.cancelVerification = vi.fn();
    await provider.cancelTask('task-1');
    expect(provider.processRunner.cancel).toHaveBeenCalledWith('command-1');
    expect(provider.cancelVerification).toHaveBeenCalledWith('verify-1');
    expect(provider.backend.cancelAgentRun).toHaveBeenCalledWith('task-1');
    expect(provider.ownsTask('task-1',4,0)).toBe(false);
  });
  it('cancels a task whose identifier arrives after Stop and drops the stale event', async () => {
    const provider = providerFor({ cancelAgentRun: vi.fn().mockResolvedValue(task({status:'cancelled'})) });
    const active = { requestId:'old', conversationId:4, cancelled:true };
    provider.chatGeneration = 1;
    provider.acceptAgentEvent({type:'task', run:task()},4,'old',0,active);
    await Promise.resolve(); await Promise.resolve();
    expect(provider.backend.cancelAgentRun).toHaveBeenCalledWith('task-1');
    expect(provider.send.mock.calls.some(([message]:[{command:string}])=>message.command==='agentEvent')).toBe(false);
  });
});
