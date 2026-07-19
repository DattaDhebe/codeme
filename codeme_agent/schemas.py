from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class GenerateRequest(BaseModel):
    language: str = Field(..., description="Target programming language for generated code")
    task: str = Field(..., description="Task description to generate code for")
    context: str | None = Field(None, description="Optional additional context or constraints")


class GenerateResponse(BaseModel):
    language: str
    prompt: str
    code: str


class ConversationBase(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)


class ConversationCreate(BaseModel):
    title: str | None = Field(None, description="Optional conversation title")


class ConversationUpdate(ConversationBase):
    pass


class ConversationSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    created_at: datetime
    updated_at: datetime

class WorkspaceCreate(BaseModel):
    path: str | None = Field(
        None,
        description="Optional workspace root path. Omit to register the currently opened project.",
    )
    display_name: str | None = Field(None, description="Optional display name for the workspace")


class WorkspaceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    display_name: str
    root_path: str
    created_at: datetime
    updated_at: datetime

class PageRequest(BaseModel):
    page: int = Field(1, ge=1)
    page_size: int = Field(50, ge=1, le=250)


class FileEntry(BaseModel):
    path: str
    name: str
    is_dir: bool
    size: int | None
    modified_at: datetime | None


class FileMetadata(BaseModel):
    path: str
    is_dir: bool
    size: int
    modified_at: datetime


class FileRead(BaseModel):
    path: str
    content: str
    metadata: FileMetadata


class SearchResult(BaseModel):
    path: str
    line: int
    column: int
    text: str


class SearchResponse(BaseModel):
    results: list[SearchResult]
    page: int
    page_size: int
    has_more: bool


class FileListResponse(BaseModel):
    entries: list[FileEntry]
    page: int
    page_size: int
    has_more: bool


class GitStatusEntry(BaseModel):
    path: str
    status: str


class GitStatusResponse(BaseModel):
    is_git: bool
    status: list[GitStatusEntry]


class GitDiffResponse(BaseModel):
    path: str | None = None
    diff: str


class AgentInstruction(BaseModel):
    path: str
    content: str


class AgentInstructionsResponse(BaseModel):
    instructions: list[AgentInstruction]


class MessageCreate(BaseModel):
    role: str = Field(..., pattern="^(user|assistant|system|tool)$")
    content: str = Field(..., min_length=1)


class MessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    role: str
    content: str
    created_at: datetime

class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[MessageCreate]


class AgentRequest(BaseModel):
    model: str | None = None
    prompt: str = Field(..., min_length=1, max_length=100_000)
    workspace_id: int
    context: str | None = Field(None, max_length=200_000)


class ChatResponseChunk(BaseModel):
    delta: str
    done: bool = False


class ErrorResponse(BaseModel):
    detail: str


class SearchReplaceEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    old_text: str = Field(..., min_length=1, max_length=200_000)
    new_text: str = Field(..., max_length=200_000)
    replace_all: bool = False


class ChangeOperationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["create", "modify"]
    relative_path: str = Field(..., min_length=1, max_length=1024)
    summary: str = Field(..., min_length=1, max_length=500)
    content: str | None = Field(None, max_length=1_500_000)
    edits: list[SearchReplaceEdit] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_operation_shape(self):
        if self.type == "create" and (self.content is None or self.edits):
            raise ValueError("Create operations require content and cannot include edits")
        if self.type == "modify" and (self.content is not None or not self.edits):
            raise ValueError("Modify operations require structured edits and cannot include complete content")
        return self


class ChangeSetCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    conversation_id: int
    workspace_id: int
    summary: str = Field(..., min_length=1, max_length=500)
    operations: list[ChangeOperationInput] = Field(..., min_length=1, max_length=50)


class ChangeOperationRead(BaseModel):
    operation_id: str
    type: Literal["create", "modify"]
    relative_path: str
    summary: str
    base_sha256: str | None
    proposed_sha256: str
    result_sha256: str | None = None
    encoding: Literal["utf-8"] = "utf-8"
    line_ending: Literal["lf", "crlf", "none", "mixed"]
    edits: list[SearchReplaceEdit]
    proposed_content: str
    diff: str


class ChangeSetEventRead(BaseModel):
    from_status: str | None
    to_status: str
    detail: str | None
    created_at: datetime


class ChangeSetRead(BaseModel):
    id: str
    schema_version: Literal[1] = 1
    conversation_id: int
    workspace_id: int
    summary: str
    status: str
    checkpoint_reference: str | None = None
    failure_reason: str | None = None
    created_at: datetime
    updated_at: datetime
    operations: list[ChangeOperationRead]
    events: list[ChangeSetEventRead] = Field(default_factory=list)


class ChangeSetDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["approve", "reject"]
    detail: str | None = Field(None, max_length=1000)


class ChangeSetApplyResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["applied", "failed"]
    result_hashes: dict[str, str] = Field(default_factory=dict)
    checkpoint_reference: str | None = Field(None, max_length=255)
    failure_reason: str | None = Field(None, max_length=1000)


class ChangeSetRestoreResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["restored", "restore_failed"]
    failure_reason: str | None = Field(None, max_length=1000)


CommandProfile = Literal[
    "pytest", "python_module", "npm_test", "npm_build", "npm_lint",
    "dotnet_test", "dotnet_build", "maven_test", "maven_package",
    "gradle_test", "gradle_build", "git_status", "git_diff", "custom_executable",
]
CommandRisk = Literal[
    "READ_ONLY", "BUILD_OR_TEST", "WRITES_WORKSPACE", "NETWORK",
    "PACKAGE_INSTALL", "LONG_RUNNING", "SENSITIVE", "BLOCKED",
]


class CommandProposalInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    profile: CommandProfile
    arguments: list[str] = Field(default_factory=list, max_length=50)
    cwd_relative: str = Field(".", min_length=1, max_length=1024)
    purpose: str = Field(..., min_length=1, max_length=500)
    requested_timeout_seconds: int = Field(120, ge=1, le=900)
    model_risk_hint: CommandRisk | None = None

    @model_validator(mode="after")
    def validate_literal_arguments(self):
        forbidden = ("\x00", "\r", "\n")
        shell_syntax = ("|", "&", ";", "`", "$(", ">", "<", "^")
        for argument in self.arguments:
            if len(argument) > 500 or any(value in argument for value in forbidden):
                raise ValueError("Command arguments must be bounded literal strings")
            if any(value in argument for value in shell_syntax):
                raise ValueError("Shell syntax is not allowed in command arguments")
        lowered = [argument.casefold() for argument in self.arguments]
        if self.profile == "python_module":
            if not self.arguments or not self.arguments[0].replace("_", "a").replace(".", "a").isalnum():
                raise ValueError("python_module requires a dotted module name as its first argument")
            if any(argument in {"-c", "-"} for argument in lowered):
                raise ValueError("Inline Python execution is not allowed")
        if self.profile in {"git_status", "git_diff"} and any(
            argument in {"reset", "clean", "checkout", "restore", "push", "branch"} for argument in lowered
        ):
            raise ValueError("Destructive Git actions are not valid profile arguments")
        if self.profile == "custom_executable" and not self.arguments:
            raise ValueError("custom_executable requires an allowlist alias as its first argument")
        return self


class CommandDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["approve", "reject", "block"]
    calculated_risk: CommandRisk
    risk_explanation: str = Field(..., min_length=1, max_length=1000)
    resolved_executable_name: str | None = Field(None, max_length=255)
    environment_keys: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("environment_keys")
    @classmethod
    def validate_environment_keys(cls, value: list[str]):
        sensitive = ("TOKEN", "SECRET", "PASSWORD", "API_KEY", "PRIVATE_KEY", "CONNECTION_STRING", "CREDENTIAL", "AUTH", "COOKIE")
        for key in value:
            if not key or len(key) > 100 or not key.replace("_", "A").isalnum():
                raise ValueError("Environment keys must be bounded names")
            if any(pattern in key.upper() for pattern in sensitive):
                raise ValueError("Sensitive environment keys cannot be persisted")
        return value


class CommandEventCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["starting", "running"]
    detail: str | None = Field(None, max_length=8000)


class CommandResultCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["completed", "failed", "timed_out", "cancelled"]
    exit_code: int | None = None
    termination_reason: str | None = Field(None, max_length=64)
    started_at: datetime
    completed_at: datetime
    duration_ms: int = Field(..., ge=0, le=86_400_000)
    stdout_tail: str = Field("", max_length=1_000_000)
    stderr_tail: str = Field("", max_length=1_000_000)
    output_truncated: bool = False
    timed_out: bool = False
    cancelled: bool = False
    failure_reason: str | None = Field(None, max_length=8000)

    @model_validator(mode="after")
    def validate_result_consistency(self):
        if self.completed_at < self.started_at:
            raise ValueError("Command completion cannot precede its start")
        if self.timed_out != (self.status == "timed_out"):
            raise ValueError("timed_out must match the terminal status")
        if self.cancelled != (self.status == "cancelled"):
            raise ValueError("cancelled must match the terminal status")
        return self


class CommandRunEventRead(BaseModel):
    from_status: str | None
    to_status: str
    detail: str | None
    created_at: datetime


class CommandRunRead(BaseModel):
    id: str
    schema_version: Literal[1] = 1
    conversation_id: int
    workspace_id: int
    profile: CommandProfile
    arguments: list[str]
    cwd_relative: str
    purpose: str
    requested_timeout_seconds: int
    model_risk_hint: CommandRisk | None = None
    calculated_risk: CommandRisk | None = None
    risk_explanation: str | None = None
    resolved_executable_name: str | None = None
    environment_keys: list[str] = Field(default_factory=list)
    decision: str | None = None
    status: str
    exit_code: int | None = None
    termination_reason: str | None = None
    duration_ms: int | None = None
    stdout_tail: str = ""
    stderr_tail: str = ""
    output_truncated: bool = False
    timed_out: bool = False
    cancelled: bool = False
    failure_reason: str | None = None
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    events: list[CommandRunEventRead] = Field(default_factory=list)


VerificationProfile = Literal[
    "pytest", "python_module", "npm_test", "npm_build", "npm_lint",
    "dotnet_test", "dotnet_build", "maven_test", "maven_package",
    "gradle_test", "gradle_build",
]
VerificationMode = Literal["quick", "full"]


class VerificationStepInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step_id: str = Field(..., min_length=1, max_length=64)
    position: int = Field(..., ge=0, le=5)
    profile: VerificationProfile
    arguments: list[str] = Field(default_factory=list, max_length=30)
    cwd_relative: str = Field(".", min_length=1, max_length=1024)
    purpose: str = Field(..., min_length=1, max_length=500)
    required: bool = True
    timeout_seconds: int = Field(120, ge=1, le=900)
    expected_outcome: str = Field("Exit code zero", min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_safe_verification_step(self):
        CommandProposalInput(
            profile=self.profile,
            arguments=self.arguments,
            cwd_relative=self.cwd_relative,
            purpose=self.purpose,
            requested_timeout_seconds=self.timeout_seconds,
        )
        lowered = [argument.casefold() for argument in self.arguments]
        if any(argument in {"install", "add", "update", "upgrade"} for argument in lowered):
            raise ValueError("Verification plans cannot install or update packages")
        if any("http://" in argument.casefold() or "https://" in argument.casefold() for argument in self.arguments):
            raise ValueError("Verification plans cannot contain network URLs")
        if self.profile.startswith("maven") and "--offline" not in lowered and "-o" not in lowered:
            raise ValueError("Maven verification must use offline mode")
        if self.profile.startswith("gradle") and "--offline" not in lowered:
            raise ValueError("Gradle verification must use offline mode")
        return self


class VerificationPlanInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    session_id: str | None = Field(None, max_length=64)
    workspace_id: int
    source_change_set_id: str | None = Field(None, max_length=36)
    mode: VerificationMode = "quick"
    summary: str = Field(..., min_length=1, max_length=500)
    steps: list[VerificationStepInput] = Field(..., min_length=1, max_length=6)
    maximum_repair_attempts: int = Field(2, ge=0, le=2)
    maximum_reruns: int = Field(2, ge=0, le=2)
    total_time_budget_seconds: int = Field(600, ge=30, le=1200)

    @model_validator(mode="after")
    def validate_plan_shape(self):
        positions = [step.position for step in self.steps]
        ids = [step.step_id for step in self.steps]
        if positions != list(range(len(self.steps))):
            raise ValueError("Verification step positions must be contiguous and ordered")
        if len(ids) != len(set(ids)):
            raise ValueError("Verification step IDs must be unique")
        if sum(step.timeout_seconds for step in self.steps) > self.total_time_budget_seconds:
            raise ValueError("Step timeouts exceed the total session budget")
        return self


class VerificationSessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    conversation_id: int
    workspace_id: int
    source_change_set_id: str | None = Field(None, max_length=36)
    mode: VerificationMode = "quick"
    original_request: str = Field(..., min_length=1, max_length=8000)
    steps: list[VerificationStepInput] | None = Field(None, max_length=6)
    maximum_repair_attempts: int = Field(2, ge=0, le=2)
    maximum_reruns: int = Field(2, ge=0, le=2)
    total_time_budget_seconds: int | None = Field(None, ge=30, le=1200)


class VerificationPlanDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decision: Literal["approve", "reject"]
    plan_fingerprint: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    detail: str | None = Field(None, max_length=1000)


class VerificationStepStart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan_fingerprint: str = Field(..., pattern=r"^[0-9a-f]{64}$")


class VerificationStepResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan_fingerprint: str = Field(..., pattern=r"^[0-9a-f]{64}$")
    command_run_id: str = Field(..., min_length=1, max_length=64)


class VerificationRepairRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str | None = Field(None, max_length=200)


class VerificationRepairResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["applied", "rejected", "conflict", "restored", "restore_failed"]
    change_set_id: str = Field(..., min_length=1, max_length=36)
    detail: str | None = Field(None, max_length=2000)


class VerificationCancel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field("Cancelled by user", min_length=1, max_length=1000)


class VerificationEventRead(BaseModel):
    event_type: str
    from_state: str | None
    to_state: str
    detail: str | None
    created_at: datetime


class RepairAttemptRead(BaseModel):
    id: str
    attempt_number: int
    failure_fingerprint: str
    model_analysis: str | None = None
    repair_change_set_id: str | None = None
    repair_content_fingerprint: str | None = None
    decision: str | None = None
    result: str | None = None
    created_at: datetime


class VerificationStepRead(BaseModel):
    step_id: str
    position: int
    profile: VerificationProfile
    arguments: list[str]
    cwd_relative: str
    purpose: str
    required: bool
    timeout_seconds: int
    expected_outcome: str
    status: str
    command_run_id: str | None = None
    exit_code: int | None = None
    failure_fingerprint: str | None = None
    result_summary: str | None = None


class VerificationSessionRead(BaseModel):
    id: str
    schema_version: Literal[1] = 1
    conversation_id: int
    workspace_id: int
    source_change_set_id: str | None = None
    mode: VerificationMode
    summary: str
    original_request: str
    state: str
    plan_version: int
    approved_plan_version: int | None = None
    plan_fingerprint: str
    approved_plan_fingerprint: str | None = None
    maximum_repair_attempts: int
    maximum_reruns: int
    total_time_budget_seconds: int
    current_attempt: int
    current_rerun: int
    final_summary: str | None = None
    failure_reason: str | None = None
    cancellation_reason: str | None = None
    created_at: datetime
    updated_at: datetime
    approved_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    steps: list[VerificationStepRead]
    repair_attempts: list[RepairAttemptRead] = Field(default_factory=list)
    events: list[VerificationEventRead] = Field(default_factory=list)


class VerificationStepStartRead(BaseModel):
    session: VerificationSessionRead
    command_run: CommandRunRead
