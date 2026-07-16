from datetime import datetime

from pydantic import BaseModel, Field


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
    id: int
    title: str
    created_at: datetime
    updated_at: datetime

    class Config:
        orm_mode = True


class WorkspaceCreate(BaseModel):
    path: str | None = Field(
        None,
        description="Optional workspace root path. Omit to register the currently opened project.",
    )
    display_name: str | None = Field(None, description="Optional display name for the workspace")


class WorkspaceRead(BaseModel):
    id: int
    display_name: str
    root_path: str
    created_at: datetime
    updated_at: datetime

    class Config:
        orm_mode = True


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
    role: str = Field(..., regex="^(user|assistant|system|tool)$")
    content: str = Field(..., min_length=1)


class MessageRead(BaseModel):
    id: int
    role: str
    content: str
    created_at: datetime

    class Config:
        orm_mode = True


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[MessageCreate]


class ChatResponseChunk(BaseModel):
    delta: str
    done: bool = False


class ErrorResponse(BaseModel):
    detail: str
