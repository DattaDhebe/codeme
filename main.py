from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from codeme_agent.config import settings
from codeme_agent.db import engine, initialize_database
from codeme_agent.local_access import LocalAccessMiddleware
from codeme_agent.model_client import create_model_client
from codeme_agent.ollama import OllamaClient, OllamaError
from codeme_agent.routers import router
from codeme_agent.schemas import GenerateRequest, GenerateResponse
from codeme_agent.prompt_engine import build_prompt, generate_code
from codeme_agent.workspace import WorkspaceError


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_database(engine)
    yield


app = FastAPI(
    title=settings.app_name,
    description=settings.description,
    version=settings.version,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(LocalAccessMiddleware, allowed_origins=settings.cors_origins)

app.include_router(router)


@app.exception_handler(WorkspaceError)
def workspace_error_handler(request, exc: WorkspaceError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/health")
def api_health():
    try:
        models = create_model_client().list_models()
    except OllamaError as exc:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "ollama": "unavailable", "provider": settings.model_provider, "detail": str(exc)},
        )

    configured = settings.default_model
    available = (configured in models or (settings.model_provider == "ollama"
                 and OllamaClient._model_key(configured) in {OllamaClient._model_key(item) for item in models}))
    if not available:
        return JSONResponse(
            status_code=503,
            content={
                "status": "error",
                "ollama": "ok",
                "provider": settings.model_provider,
                "model": settings.default_model,
                "models": models,
                "detail": "Configured local model is not available in the selected server",
            },
        )

    return {
        "status": "ok",
        "ollama": "ok",
        "provider": settings.model_provider,
        "model": settings.default_model,
        "models": models,
    }


@app.post(
    "/generate",
    response_model=GenerateResponse,
    deprecated=True,
    summary="Legacy placeholder code-generation endpoint",
)
def generate(request: GenerateRequest):
    prompt = build_prompt(request)
    code = generate_code(prompt)
    return GenerateResponse(
        language=request.language,
        prompt=prompt,
        code=code,
    )
