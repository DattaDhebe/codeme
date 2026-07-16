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
