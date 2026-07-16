from pydantic import BaseModel, Field

class GenerateRequest(BaseModel):
    language: str = Field(..., description="Target programming language for generated code")
    task: str = Field(..., description="Task description to generate code for")
    context: str | None = Field(None, description="Optional additional context or constraints")

class GenerateResponse(BaseModel):
    language: str
    prompt: str
    code: str
