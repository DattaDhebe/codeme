from typing import List

from pydantic import AnyHttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="forbid")

    app_name: str = "Personal Codex"
    description: str = "Local ChatGPT-style coding agent"
    version: str = "0.1.0"
    host: str = "127.0.0.1"
    port: int = 8000
    cors_origins: List[str] = ["http://localhost:4200", "http://127.0.0.1:4200"]
    database_url: str = "sqlite:///./codeme.db"
    ollama_url: AnyHttpUrl = "http://127.0.0.1:11434"
    default_model: str = "qwen2.5-coder:7b"
    default_workspace_root: str = "."
    allow_unc_paths: bool = False
    max_file_size: int = 1_500_000

settings = Settings()
