import { CommandRisk, CommandRun } from './commandRun';

export type VerificationMode = 'quick' | 'full';

export interface VerificationStep {
  step_id: string;
  position: number;
  profile: CommandRun['profile'];
  arguments: string[];
  cwd_relative: string;
  purpose: string;
  required: boolean;
  timeout_seconds: number;
  expected_outcome: string;
  status: string;
  command_run_id?: string | null;
  exit_code?: number | null;
  failure_fingerprint?: string | null;
  result_summary?: string | null;
  calculated_risk?: CommandRisk;
  risk_explanation?: string;
  output?: string;
}

export interface RepairAttempt {
  id: string;
  attempt_number: number;
  failure_fingerprint: string;
  model_analysis?: string | null;
  repair_change_set_id?: string | null;
  repair_content_fingerprint?: string | null;
  decision?: string | null;
  result?: string | null;
  created_at: string;
}

export interface VerificationSession {
  id: string;
  schema_version: 1;
  conversation_id: number;
  workspace_id: number;
  source_change_set_id?: string | null;
  mode: VerificationMode;
  summary: string;
  original_request: string;
  state: string;
  plan_version: number;
  approved_plan_version?: number | null;
  plan_fingerprint: string;
  approved_plan_fingerprint?: string | null;
  maximum_repair_attempts: number;
  maximum_reruns: number;
  total_time_budget_seconds: number;
  current_attempt: number;
  current_rerun: number;
  final_summary?: string | null;
  failure_reason?: string | null;
  cancellation_reason?: string | null;
  created_at: string;
  updated_at: string;
  steps: VerificationStep[];
  repair_attempts: RepairAttempt[];
  events?: Array<{ event_type: string; from_state?: string | null; to_state: string; detail?: string | null; created_at: string }>;
}

export interface VerificationStepStart {
  session: VerificationSession;
  command_run: CommandRun;
}

export const verificationTerminalStates = new Set([
  'PASSED', 'REJECTED', 'CANCELLED', 'TIMED_OUT', 'EXHAUSTED', 'BLOCKED', 'STOPPED_NO_PROGRESS',
]);
