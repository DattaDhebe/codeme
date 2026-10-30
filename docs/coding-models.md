# Choose a free local coding model

CodeMe includes a small researched catalog of freely downloadable coding models. Open **Coding models** in the browser header, or **Choose coding models** in the VS Code toolbar. Check the download and memory guidance, then choose **Download and use**. An exact installed model is reused instead of downloaded again.

Downloads are optional and handled by your local Ollama server. CodeMe shows its real progress, supports cancellation and retry, loads the selected model, and selects it for your next chat. It does not download every catalog entry or switch the existing default merely because you opened the list. No Hugging Face account, paid inference API, or hosted model endpoint is used.

## Research picks

Checked **30 October 2026** against official author model cards and Ollama listings. All five upstream model cards identify **Apache-2.0** licensing. These choices cover different machines; this is not a universal benchmark ranking.

| Model | Why consider it | Approximate download | Memory planning estimate |
| --- | --- | --- | --- |
| [Qwen 2.5 Coder 7B](https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct) | Lighter existing CodeMe default; the only catalog model evaluated here so far | [4.7 GB](https://ollama.com/library/qwen2.5-coder:7b) | Around 16 GB system RAM; context and other apps need headroom |
| [Devstral Small 2 24B](https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512) | Agent-focused alternative for exploring repositories and editing multiple files | [15 GB](https://ollama.com/library/devstral-small-2:24b) | Around 32 GB system RAM, depending on offload and context |
| [Qwen3 Coder 30B](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct) | Balanced research recommendation for a capable coding workstation; coding and tool-use specialization | [19 GB](https://ollama.com/library/qwen3-coder:30b) | Around 32 GB system RAM or more |
| [Qwen3.8 27B](https://huggingface.co/Qwen/Qwen3.8-27B) | Newer advanced coding/agent candidate; experimental in CodeMe | [18 GB](https://ollama.com/library/qwen3.8:27b-q4_K_M) | Around 32 GB or more; thinking and context affect use |
| [Qwen3 Coder Next](https://huggingface.co/Qwen/Qwen3-Coder-Next) | Larger coding specialist for machines with substantial memory | [52 GB](https://ollama.com/library/qwen3-coder-next:q4_K_M) | Plan for 64–96 GB or more, depending on context and offload |

Download sizes describe the listed Ollama quantizations, not full-precision Hugging Face weights. They can change with registry revisions. **Download size is not RAM or VRAM use.** Memory estimates are planning guidance, not minimum specifications or a guarantee that a model fits. Sparse models still store their total weights even when only a smaller set of parameters is active for each token. [Larger context also uses more memory](https://docs.ollama.com/context-length); CodeMe keeps its configured context budget instead of automatically adopting a vendor's maximum.

Keep Ollama current before installing new architectures. [Devstral Small 2 requires Ollama 0.13.3 or newer](https://ollama.com/library/devstral-small-2:24b). Other new models may also require a newer runtime; a setup error remains visible and does not trigger a different download.

## What has actually been tested

One local Qwen 2.5 Coder 7B run passed five of six coding tasks; its multi-file task remained blocked. Recovery and policy controls were measured separately. The other entries are research candidates, not models proven to work reliably in CodeMe. Run the [model evaluation suite](model-evaluations.md) after installing one to measure it on your hardware.

Qwen3.8's author reports strong coding and agent results, but those are vendor measurements using particular evaluation settings. Its upstream thinking and preserved-thinking behavior also differs from CodeMe's policy of discarding private reasoning. It remains an optional experimental choice until local evaluation establishes useful behavior. The older default has not been replaced by an untested model.

## Download, switch, and retry

Only a catalog ID is accepted by the download action. It maps to a reviewed local Ollama tag; caller-supplied download URLs, shell commands, and cloud variants are not accepted. The existing setup job owns progress and cancellation. If another model is being prepared, cancel that job and wait for it to stop before choosing a different model. Retry keeps the requested target rather than silently substituting an installed alternative.

A successful explicit choice is remembered in the application's ignored `.runtime/model-choice.json`. This file contains the allowlisted catalog ID and a fingerprint of the configured default, not prompts or credentials. Your `.env` is preserved. Changing `DEFAULT_MODEL` externally or changing providers takes precedence over the saved choice. If the preference cannot be saved, the model remains usable for the current session and CodeMe shows the persistence warning.

For LM Studio or another local OpenAI-compatible server, the catalog provides research links and guidance. Install/load local weights using that server's controls; its common chat API does not define a universal download operation. CodeMe does not change your provider to perform a download. See [Configuration](configuration.md) for local-server setup.
