# Systems Engine Installed & Node Adapters

This document catalogues the core engine dependencies, the architectural strategy for converting community ComfyUI nodes into isolated adapters, and the standard interface contracts.

---

## 1. Core Engine Dependencies (`requirements.txt`)

To ensure rapid boot times on Kaggle and avoid dependency bloat, the engine relies strictly on low-overhead, standard libraries:

| Library | Version Target | Primary Responsibility |
| :--- | :--- | :--- |
| `torch` | $\ge 2.2.0$ | Core tensor operations, CUDA execution, GPU memory management |
| `accelerate` | $\ge 0.28.0$ | Memory-efficient model loading and device dispatching |
| `safetensors` | $\ge 0.4.0$ | High-speed, zero-copy serialization for weights and intermediate latents |
| `gguf` | $\ge 0.10.0$ | Pure Python parsing and dequantization of `.gguf` weights (Flux, LTX-2.5) |
| `diffusers` | $\ge 0.29.0$ | Low-level scheduler math (FlowMatchEulerDiscreteScheduler) & DiT layers |
| `transformers` | $\ge 4.40.0$ | CLIP and T5-XXL text tokenizers and encoders |
| `sentencepiece` | $\ge 0.2.0$ | Tokenization engine for T5-XXL |
| `einops` | $\ge 0.8.0$ | High-efficiency tensor reshaping & patchification for DiT models |
| `networkx` | $\ge 3.0$ | DAG dependency resolution and topological sorting |
| `imageio` | $\ge 2.34.0$ | Direct frame assembly into images |
| `imageio-ffmpeg` | $\ge 0.4.9$ | Headless MP4 encoding (eliminates heavy `VideoHelperSuite` nodes) |
| `boto3` | $\ge 1.34.0$ | High-speed direct upload of MP4/PNG files to Cloudflare R2 ($0 egress) |
| `psycopg2-binary`| $\ge 2.9.9$ | Direct connection to Aiven PostgreSQL cloud database |
| `fastapi` | $\ge 0.111.0$ | Lightweight REST API, SSE progress streamer & static UI server |
| `uvicorn[standard]` | $\ge 0.30.0$ | Ultra-fast ASGI web server |
| `pydantic` | $\ge 2.7.0$ | Data validation for workflow graphs and conversion schemas |

---

## 2. Node Adapter Conversion Strategy

### 2.1 The Problem with Upstream ComfyUI Nodes
Community nodes (e.g., `rgthree`, `KJNodes`, `ComfyUI-GGUF`) package simple PyTorch calculations with heavy extraneous layers:
* WebSocket progress updates (`PromptServer.instance.send_sync`)
* Custom HTML/JavaScript web components
* Complex UI caching mechanisms (`IS_CHANGED` decorators)
* Dynamic monkey-patching of global ComfyUI registries

### 2.2 Extraction & De-Cluttering Protocol (The Node Converter)
When converting an upstream node into an internal adapter (`/adapters/converted/<adapter_name>.py`):
1. **AST Static Analysis:** `engine/node_converter.py` uses Python's `ast` parser to inspect the class without executing unsafe code.
2. **Schema Ingestion:** Reads `INPUT_TYPES()` and `RETURN_TYPES` to establish the input/output dictionary contracts.
3. **Strip Frontend Wrappers:** Discards all `web/`, JavaScript, and server notification calls.
4. **Isolate Mathematical Kernel:** Extracts only the PyTorch tensor manipulations, matrix multiplications, and weight transformations.
5. **Freeze Implementation:** Emits a standalone Python file subclassing `BaseAdapter`. The adapter is now completely decoupled from upstream GitHub repositories.

---

## 3. Standard Adapter Contract

Every adapter adheres to a standardized Python interface:

```python
from typing import Dict, Any

class BaseAdapter:
    """Standard interface contract for all engine adapters."""
    
    node_type: str = "BaseNode"
    inputs_schema: Dict[str, Any] = {}
    outputs_schema: Dict[str, Any] = {}

    @classmethod
    def execute(cls, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes the mathematical operation.
        
        Args:
            inputs: Dictionary containing resolved scalar arguments and 
                    upstream tensor references.
                    
        Returns:
            Dictionary containing output tensors or artifact paths.
        """
        raise NotImplementedError

    @classmethod
    def cleanup(cls):
        """Optional hook for adapters holding transient VRAM allocations."""
        pass
```

---

## 4. Initial Catalog of Converted Adapters

### 4.1 Quantized Model Loader (`adapters/gguf_loader.py`)
* **Replaces:** `UNETLoaderGGUF` (city96)
* **Function:** Directly reads quantized weights from `.gguf` files on disk and constructs PyTorch tensor views ready for the DiT forward pass.

### 4.2 Dual CLIP / T5 Text Encoder (`adapters/text_encoder.py`)
* **Replaces:** `DualCLIPLoader`, `CLIPTextEncode`
* **Function:** Ingests positive/negative prompt strings, tokenizes via Hugging Face `transformers` and `sentencepiece`, computes text embeddings, and purges text model weights immediately.

### 4.3 LoRA Injection Adapter (`adapters/lora_adapter.py`)
* **Replaces:** `rgthree` LoRA Stack, `LoraLoaderModelOnly`
* **Function:** Ingests low-rank `.safetensors` deltas, applies matrix scaling $\Delta W = W + (\alpha / r) \cdot (B \times A)$ directly into attention projections without external UI wrappers.

### 4.4 Flow-Match Diffusion Sampler (`adapters/sampler.py`)
* **Replaces:** `KSampler`, `KSamplerAdvanced`
* **Function:** Executes deterministic denoising steps using `diffusers` FlowMatch Euler Discrete scheduler, taking noise latents and conditionings to generate the denoised latent.

### 4.5 VAE Latent Decoder (`adapters/vae_decoder.py`)
* **Replaces:** `VAEDecode`
* **Function:** Streams latent tensors through standard Flux/SD VAE decoder onto CPU system memory as uint8 RGB arrays.

### 4.6 Headless Video Output (`adapters/media_saver.py`)
* **Replaces:** `VHS_VideoCombine` (VideoHelperSuite)
* **Function:** Takes stacked frame arrays, encodes to H.264 `.mp4` via `imageio-ffmpeg`, and uploads directly to **Cloudflare R2** via `engine/storage.py`.
