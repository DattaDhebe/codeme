from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from codeme_agent.config import settings
from codeme_agent.db import Base, engine
from codeme_agent.routers import router
from codeme_agent.schemas import GenerateRequest, GenerateResponse
from codeme_agent.prompt_engine import build_prompt, generate_code

app = FastAPI(
    title=settings.app_name,
    description=settings.description,
    version=settings.version,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/generate", response_model=GenerateResponse)
def generate(request: GenerateRequest):
    prompt = build_prompt(request)
    code = generate_code(prompt)
    return GenerateResponse(
        language=request.language,
        prompt=prompt,
        code=code,
    )
