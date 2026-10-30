from typing import List, Literal

from pydantic import AnyHttpUrl, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from codeme_agent.local_access import is_loopback_host, validate_local_origin, validate_local_url
from codeme_agent.model_catalog import saved_model_choice


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="forbid")

    app_name: str = "CodeMe"
    description: str = "A local coding workspace by DHEBE Studios"
    version: str = "0.7.0"
    host: str = "127.0.0.1"
    port: int = Field(8000, ge=1, le=65535)
    cors_origins: List[str] = ["http://localhost:4200", "http://127.0.0.1:4200"]
    database_url: str = "sqlite:///./codeme.db"
    ollama_url: AnyHttpUrl = "http://127.0.0.1:11434"
    model_provider: Literal["ollama", "openai_compatible"] = "ollama"
    local_model_url: AnyHttpUrl = "http://127.0.0.1:1234/v1"
    default_model: str = "qwen2.5-coder:7b"
    auto_model_setup: bool = True
    ollama_context_length: int = Field(8192, ge=2048, le=131072)
    agent_max_cycles: int = Field(8, ge=1, le=32)
    agent_time_budget_seconds: int = Field(900, ge=30, le=3600)
    default_workspace_root: str = "."
    allow_unc_paths: bool = False
    max_file_size: int = 1_500_000

    @field_validator("host")
    @classmethod
    def local_host(cls, value: str) -> str:
        if not is_loopback_host(value):
            raise ValueError("CodeMe must bind to localhost or a loopback IP address")
        return value

    @field_validator("ollama_url", "local_model_url", mode="before")
    @classmethod
    def local_model_endpoint(cls, value):
        return validate_local_url(value)

    @field_validator("cors_origins")
    @classmethod
    def local_browser_origins(cls, values: List[str]) -> List[str]:
        return [validate_local_origin(value) for value in values]

    @field_validator("allow_unc_paths")
    @classmethod
    def local_filesystem_only(cls, value: bool) -> bool:
        if value:
            raise ValueError("Network shares are disabled; CodeMe workspaces must be on this machine")
        return value

settings = Settings()

# An explicit in-app catalog choice survives restarts without rewriting .env.
# A changed DEFAULT_MODEL or provider takes precedence over this preference.
configured_default_model = settings.default_model
_saved_choice = saved_model_choice(configured_default_model, settings.model_provider)
if _saved_choice is not None:
    settings.default_model = _saved_choice.ollama_model
