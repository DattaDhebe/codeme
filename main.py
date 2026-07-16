from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from codeme_agent.schemas import GenerateRequest, GenerateResponse
from codeme_agent.prompt_engine import build_prompt, generate_code

app = FastAPI(
    title="Codeme Agent",
    description="A lightweight code-generation assistant API.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
