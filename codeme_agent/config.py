from typing import List

from pydantic import AnyHttpUrl
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "Personal Codex"
    description: str = "Local ChatGPT-style coding agent"
    version: str = "0.1.0"
    host: str = "127.0.0.1"
    port: int = 8000
    cors_origins: List[str] = ["http://localhost:4200", "http://127.0.0.1:4200"]
    database_url: str = "sqlite:///./codeme.db"
    ollama_url: AnyHttpUrl = "http://127.0.0.1:11434"
    default_model: str = "qwen2.5-coder:7b"

    class Config:
        env_file = ".env"
        extra = "forbid"


settings = Settings()
