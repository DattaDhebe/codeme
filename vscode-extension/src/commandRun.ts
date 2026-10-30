export type CommandProfile =
  | 'pytest' | 'python_module' | 'npm_test' | 'npm_build' | 'npm_lint'
  | 'dotnet_test' | 'dotnet_build' | 'maven_test' | 'maven_package'
  | 'gradle_test' | 'gradle_build' | 'git_status' | 'git_diff' | 'custom_executable';

export type CommandRisk =
  | 'READ_ONLY' | 'BUILD_OR_TEST' | 'WRITES_WORKSPACE' | 'NETWORK'
  | 'PACKAGE_INSTALL' | 'LONG_RUNNING' | 'SENSITIVE' | 'BLOCKED';

export type CommandStatus =
  | 'proposed' | 'approved' | 'rejected' | 'blocked' | 'starting' | 'running'
  | 'completed' | 'failed' | 'timed_out' | 'cancelled';

export interface CommandRun {
  id: string;
  schema_version: 1;
  conversation_id: number;
  workspace_id: number;
  profile: CommandProfile;
  arguments: string[];
  cwd_relative: string;
  purpose: string;
  requested_timeout_seconds: number;
  model_risk_hint?: CommandRisk | null;
  calculated_risk?: CommandRisk | null;
  risk_explanation?: string | null;
  resolved_executable_name?: string | null;
  environment_keys?: string[];
  resolved_arguments?: string[];
  network_access?: boolean;
  writes_workspace?: boolean;
  policy_blocked?: boolean;
  decision?: string | null;
  status: CommandStatus;
  exit_code?: number | null;
  termination_reason?: string | null;
  duration_ms?: number | null;
  stdout_tail?: string;
  stderr_tail?: string;
  output_truncated?: boolean;
  timed_out?: boolean;
  cancelled?: boolean;
  failure_reason?: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface CommandPolicyDecision {
  risk: CommandRisk;
  risks: CommandRisk[];
  explanation: string;
  blocked: boolean;
  network: boolean;
  writesWorkspace: boolean;
  executable: string;
  executableName: string;
  args: string[];
  cwd: string;
  cwdRelative: string;
  timeoutSeconds: number;
  environment: NodeJS.ProcessEnv;
  environmentKeys: string[];
  windowsWrapper: boolean;
}

export interface CommandExecutionResult {
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  exitCode: number | null;
  terminationReason: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  outputTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  failureReason?: string;
}

export interface CommandOutputEvent {
  commandRunId: string;
  stream: 'stdout' | 'stderr' | 'status';
  text: string;
}
