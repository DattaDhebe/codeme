from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from codeme_agent.config import settings
from codeme_agent.db import Base, engine
from codeme_agent.ollama import OllamaClient, OllamaError
from codeme_agent.routers import router
from codeme_agent.schemas import GenerateRequest, GenerateResponse
from codeme_agent.prompt_engine import build_prompt, generate_code
from codeme_agent.workspace import WorkspaceError


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
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
        models = OllamaClient().list_models()
    except OllamaError as exc:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "ollama": "unavailable", "detail": str(exc)},
        )

    if settings.default_model not in models:
        return JSONResponse(
            status_code=503,
            content={
                "status": "error",
                "ollama": "ok",
                "model": settings.default_model,
                "models": models,
                "detail": "Configured Ollama model is not installed",
            },
        )

    return {
        "status": "ok",
        "ollama": "ok",
        "model": settings.default_model,
        "models": models,
    }


@app.post("/generate", response_model=GenerateResponse)
def generate(request: GenerateRequest):
    prompt = build_prompt(request)
    code = generate_code(prompt)
    return GenerateResponse(
        language=request.language,
        prompt=prompt,
        code=code,
    )
