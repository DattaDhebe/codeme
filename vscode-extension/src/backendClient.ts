import * as vscode from 'vscode';
import { ChangeSet } from './changeSet';
import { readEventStream } from './eventStream';
import { CommandExecutionResult, CommandRisk, CommandRun } from './commandRun';
import { VerificationMode, VerificationSession, VerificationStepStart } from './verification';

export interface BackendSettings {
  get<T>(section: string, defaultValue: T): T;
}

export interface HealthResponse {
  status: string;
  ollama?: string;
  provider?: string;
  inference?: string;
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

export interface WorkspaceResponse {
  id: number;
  display_name?: string;
  root_path?: string;
}

export interface AgentPlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface AgentRun {
  id: string;
  conversation_id: number;
  workspace_id: number;
  goal: string;
  provider: string;
  time_budget_seconds: number;
  elapsed_ms: number;
  evidence: Record<string, unknown>;
  requires_verification: boolean;
  model?: string | null;
  status: 'running' | 'awaiting_approval' | 'completed' | 'blocked' | 'exhausted' | 'cancelled' | 'interrupted';
  plan: AgentPlanStep[];
  cycle_count: number;
  max_cycles: number;
  summary?: string | null;
  created_at: string;
  updated_at: string;
  pending_change_set_ids: string[];
  pending_command_run_ids: string[];
}

export type AgentEvent =
  | { type: 'task'; run: AgentRun }
  | { type: 'plan'; steps: AgentPlanStep[]; explanation?: string }
  | { type: 'outcome'; status: 'completed' | 'awaiting_approval' | 'blocked' | 'exhausted' | 'cancelled'; summary: string; evidence?: unknown }

  | { type: 'status'; label: string; detail?: string }
  | { type: 'tool'; name: string; summary: string; status: 'running' | 'complete' | 'error' }
  | { type: 'proposal'; kind: 'file_change'; path: string; content: string; explanation: string; change_set?: ChangeSet }
  | { type: 'proposal'; kind: 'change_set'; change_set: ChangeSet }
  | { type: 'proposal'; kind: 'command_proposal'; command_run: CommandRun }
  | { type: 'proposal'; kind: 'verification_plan'; verification_session: VerificationSession }
  | { type: 'proposal'; kind: 'command'; command: string; explanation: string }
  | { type: 'message'; content: string };

export function localBackendUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Use a valid local backend URL, such as http://127.0.0.1:8000.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Personal Codeme only connects to a local backend on localhost, 127.0.0.1, or [::1].');
  }
  return url.toString().replace(/\/+$/, '');
}

export class BackendClient {
  private controller?: AbortController;

  constructor(private config: BackendSettings) {}

  public get configuredModel(): string {
    return this.config.get('defaultModel', 'qwen2.5-coder:7b');
  }

  private get backendUrl(): string {
    return localBackendUrl(this.config.get('backendUrl', 'http://127.0.0.1:8000'));
  }

  private get showNotifications(): boolean {
    return this.config.get('showNotifications', true);
  }

  public async checkConnection(userTriggered: boolean): Promise<HealthResponse> {
    try {
      const response = await this.request<HealthResponse>('/health', undefined, 3000, 3);
      if (response.status === 'ok' && this.showNotifications && userTriggered) {
        const target = response.model ? `${response.model} through ${response.provider || 'Ollama'}` : 'the local backend';
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

  public async listWorkspaces(): Promise<WorkspaceResponse[]> {
    return this.request<WorkspaceResponse[]>('/workspaces');
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

  public async decideChangeSet(changeSetId: string, decision: 'approve' | 'reject', detail?: string): Promise<ChangeSet> {
    return this.post<ChangeSet>(`/change-sets/${encodeURIComponent(changeSetId)}/decision`, { decision, detail });
  }

  public async getChangeSet(changeSetId: string): Promise<ChangeSet> {
    return this.request<ChangeSet>(`/change-sets/${encodeURIComponent(changeSetId)}`);
  }

  public async createVerificationSession(input: {
    conversationId: number; workspaceId: number; originalRequest: string; mode: VerificationMode;
    sourceChangeSetId?: string; maximumRepairAttempts: number; maximumReruns: number; totalTimeBudgetSeconds: number;
  }): Promise<VerificationSession> {
    return this.post<VerificationSession>('/verification-sessions', {
      conversation_id: input.conversationId, workspace_id: input.workspaceId,
      source_change_set_id: input.sourceChangeSetId, original_request: input.originalRequest, mode: input.mode,
      maximum_repair_attempts: input.maximumRepairAttempts, maximum_reruns: input.maximumReruns,
      total_time_budget_seconds: input.totalTimeBudgetSeconds,
    });
  }

  public async listVerificationSessions(workspaceId: number, activeOnly = false): Promise<VerificationSession[]> {
    return this.request<VerificationSession[]>(`/verification-sessions?workspace_id=${workspaceId}&active_only=${activeOnly}`);
  }

  public async getVerificationSession(sessionId: string): Promise<VerificationSession> {
    return this.request<VerificationSession>(`/verification-sessions/${encodeURIComponent(sessionId)}`);
  }

  public async decideVerificationPlan(sessionId: string, decision: 'approve' | 'reject', planFingerprint: string): Promise<VerificationSession> {
    return this.post<VerificationSession>(`/verification-sessions/${encodeURIComponent(sessionId)}/decision`, {
      decision, plan_fingerprint: planFingerprint,
    });
  }

  public async startVerificationStep(sessionId: string, stepId: string, planFingerprint: string): Promise<VerificationStepStart> {
    return this.post<VerificationStepStart>(`/verification-sessions/${encodeURIComponent(sessionId)}/steps/${encodeURIComponent(stepId)}/start`, {
      plan_fingerprint: planFingerprint,
    });
  }

  public async reportVerificationStep(sessionId: string, stepId: string, planFingerprint: string, commandRunId: string): Promise<VerificationSession> {
    return this.post<VerificationSession>(`/verification-sessions/${encodeURIComponent(sessionId)}/steps/${encodeURIComponent(stepId)}/result`, {
      plan_fingerprint: planFingerprint, command_run_id: commandRunId,
    });
  }

  public async prepareVerificationRepair(sessionId: string, model?: string): Promise<VerificationSession> {
    return this.request<VerificationSession>(`/verification-sessions/${encodeURIComponent(sessionId)}/repair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
    }, 180_000);
  }

  public async reportVerificationRepair(
    sessionId: string, status: 'applied' | 'rejected' | 'conflict' | 'restored' | 'restore_failed', changeSetId: string, detail?: string,
  ): Promise<VerificationSession> {
    return this.post<VerificationSession>(`/verification-sessions/${encodeURIComponent(sessionId)}/repair-result`, {
      status, change_set_id: changeSetId, detail,
    });
  }

  public async cancelVerification(sessionId: string, reason: string, interrupted = false): Promise<VerificationSession> {
    const action = interrupted ? 'interrupt' : 'cancel';
    return this.post<VerificationSession>(`/verification-sessions/${encodeURIComponent(sessionId)}/${action}`, { reason });
  }

  public async reportChangeSetResult(
    changeSetId: string,
    status: 'applied' | 'failed',
    resultHashes: Record<string, string>,
    checkpointReference?: string,
    failureReason?: string,
  ): Promise<ChangeSet> {
    return this.post<ChangeSet>(`/change-sets/${encodeURIComponent(changeSetId)}/result`, {
      status,
      result_hashes: resultHashes,
      checkpoint_reference: checkpointReference,
      failure_reason: failureReason,
    });
  }

  public async reportChangeSetRestore(
    changeSetId: string,
    status: 'restored' | 'restore_failed',
    failureReason?: string,
  ): Promise<ChangeSet> {
    return this.post<ChangeSet>(`/change-sets/${encodeURIComponent(changeSetId)}/restore`, {
      status,
      failure_reason: failureReason,
    });
  }

  public async getCommandRun(commandRunId: string): Promise<CommandRun> {
    return this.request<CommandRun>(`/command-runs/${encodeURIComponent(commandRunId)}`);
  }

  public async decideCommandRun(
    commandRunId: string,
    decision: 'approve' | 'reject' | 'block',
    risk: CommandRisk,
    riskExplanation: string,
    executableName?: string,
    environmentKeys: string[] = [],
  ): Promise<CommandRun> {
    return this.post<CommandRun>(`/command-runs/${encodeURIComponent(commandRunId)}/decision`, {
      decision,
      calculated_risk: risk,
      risk_explanation: riskExplanation,
      resolved_executable_name: executableName,
      environment_keys: environmentKeys,
    });
  }

  public async reportCommandEvent(commandRunId: string, status: 'starting' | 'running', detail?: string): Promise<CommandRun> {
    return this.post<CommandRun>(`/command-runs/${encodeURIComponent(commandRunId)}/events`, { status, detail });
  }

  public async reportCommandResult(commandRunId: string, result: CommandExecutionResult): Promise<CommandRun> {
    return this.post<CommandRun>(`/command-runs/${encodeURIComponent(commandRunId)}/result`, {
      status: result.status,
      exit_code: result.exitCode,
      termination_reason: result.terminationReason,
      started_at: result.startedAt,
      completed_at: result.completedAt,
      duration_ms: result.durationMs,
      stdout_tail: result.stdoutTail,
      stderr_tail: result.stderrTail,
      output_truncated: result.outputTruncated,
      timed_out: result.timedOut,
      cancelled: result.cancelled,
      failure_reason: result.failureReason,
    });
  }

  public async streamChat(
    conversationId: number,
    messages: Array<{ role: string; content: string }>,
    model: string | undefined,
    onChunk: (chunk: string) => void,
    onComplete: () => void,
    onError: (error: Error) => void
  ): Promise<void> {
    await this.stream('/conversations/' + conversationId + '/chat',
      { model: model || this.configuredModel, messages }, (event) => {
        if (event.data === '[DONE]') return false;
        let decoded: unknown;
        try { decoded = JSON.parse(event.data); } catch { throw new Error('The backend returned an invalid chat event.'); }
        if (event.event === 'error' || (decoded && typeof decoded === 'object' && 'error' in decoded)) {
          throw new Error(String((decoded as { error?: string })?.error || 'Chat request failed.'));
        }
        if (typeof decoded === 'string') onChunk(decoded);
      }, onComplete, onError);
  }

  public async listAgentRuns(conversationId: number): Promise<AgentRun[]> {
    return this.request<AgentRun[]>(`/agent-runs?conversation_id=${conversationId}`);
  }

  public async getAgentRun(runId: string): Promise<AgentRun> {
    return this.request<AgentRun>(`/agent-runs/${encodeURIComponent(runId)}`);
  }

  public async cancelAgentRun(runId: string, reason = 'Stopped by user'): Promise<AgentRun> {
    return this.post<AgentRun>(`/agent-runs/${encodeURIComponent(runId)}/cancel`, { reason });
  }

  public async continueAgentRun(
    runId: string, onEvent: (event: AgentEvent) => void,
    onComplete: () => void, onError: (error: Error) => void,
  ): Promise<void> {
    await this.streamAgentEvents(`/agent-runs/${encodeURIComponent(runId)}/continue`, {}, onEvent, onComplete, onError);
  }

  public async streamAgent(
    conversationId: number, prompt: string, workspaceId: number, context: string | undefined,
    model: string | undefined, onEvent: (event: AgentEvent) => void,
    onComplete: () => void, onError: (error: Error) => void,
  ): Promise<void> {
    await this.streamAgentEvents('/conversations/' + conversationId + '/agent',
      { model: model || this.configuredModel, prompt, workspace_id: workspaceId, context }, onEvent, onComplete, onError);
  }

  private async streamAgentEvents(
    endpoint: string, body: unknown, onEvent: (event: AgentEvent) => void,
    onComplete: () => void, onError: (error: Error) => void,
  ): Promise<void> {
    await this.stream(endpoint, body, (event) => {
      if (event.event === 'done' || event.data === '[DONE]') return false;
      const decoded = JSON.parse(event.data) as AgentEvent | { error?: string };
      if (event.event === 'error' || 'error' in decoded) {
        throw new Error('error' in decoded ? decoded.error : 'Agent request failed.');
      }
      onEvent(decoded as AgentEvent);
    }, onComplete, onError);
  }

  private async stream(
    endpoint: string, body: unknown,
    consume: (event: { event: string; data: string }) => boolean | void,
    onComplete: () => void, onError: (error: Error) => void,
  ): Promise<void> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await fetch(this.getUrl(endpoint), {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) throw new Error('Backend request failed: ' + response.status + ' ' + await response.text());
      let completed = false;
      await readEventStream(response, (event) => {
        if (controller.signal.aborted) throw new DOMException('Generation stopped.', 'AbortError');
        if (consume(event) === false) { completed = true; return false; }
      });
      if (!completed) throw new Error('The backend stream ended early. Retry your request.');
      onComplete();
    } catch (error: unknown) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (controller.signal.aborted || failure.name === 'AbortError') {
        const cancelled = new Error('Generation stopped.');
        cancelled.name = 'AbortError';
        onError(cancelled);
      } else onError(failure);
    } finally {
      // An older request must never clear the controller for its successor.
      if (this.controller === controller) this.controller = undefined;
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
        const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
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
