from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


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
