from codeme_agent.schemas import GenerateRequest

PROMPT_TEMPLATE = (
    "You are a code generation assistant. "
    "Generate working {language} code for the task below.\n\n"
    "Task:\n{task}\n\n"
    "Context:\n{context}\n\n"
    "Provide only the code output without explanation."
)


def build_prompt(request: GenerateRequest) -> str:
    context = request.context or "No additional context provided."
    return PROMPT_TEMPLATE.format(
        language=request.language,
        task=request.task,
        context=context,
    )


def generate_code(prompt: str) -> str:
    # Placeholder implementation.
    # Replace this with a real code generation model integration.
    if "reverse a string" in prompt.lower() and "python" in prompt.lower():
        return "def reverse_string(value: str) -> str:\n    return value[::-1]\n"

    return "# TODO: integrate a generative model here\n" \
           "# Generated code output will appear once the model is connected.\n"
