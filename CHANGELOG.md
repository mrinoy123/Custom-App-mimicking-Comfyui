# Changelog

All notable changes and architectural modifications to the Custom ComfyUI Headless Engine will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.0] - 2026-09-15

### Added
- **`JsonRepairSerializer` (`engine/json_repair.py`):**
  - Progressive 9-step JSON repair engine that auto-fixes trailing commas, unescaped quotes, NaN/Infinity literals, JavaScript comments, and strips LLM `<think>` tags without failing.
  - Wired into `WorkflowConverter.from_raw_text` and `/api/convert-workflow`.
- **`PayloadDiffEngine` (`engine/payload_diff.py`):**
  - Tracks node execution outputs and calculates Isolated Delta (what this node produced) vs. Cumulative Full (all upstream tensors).
  - Tensor-safe metadata summarizer prevents API crashes on multi-gigabyte tensors.
  - Exposed via `/api/inspect` and integrated into `PipelineRunner`.
- **Rolling 3-Run Aiven Retention (`engine/database.py`):**
  - Atomic SQL pruning keeping strictly the 3 most recent execution records per workflow in Aiven PostgreSQL.
  - Added `get_execution_history(workflow_name)` and `/api/history/{workflow_name}` endpoint.
- **Studio Grey Canvas & Tactical UI Enhancements (`/ui`):**
  - `#7e7e88` Studio Grey background with crisp 24px white dot grid.
  - Crisp `#ffffff` bezier wires with multi-layer drop shadows for clear visual tracing.
  - Floating Draggable VRAM HUD with live telemetry bar, allocated/reserved/free stats, and manual VRAM purge button (`/api/purge-vram`).
  - Slide-out PayloadDiffEngine Inspector Drawer with instant Delta vs. Full toggle.
- **RAM-First Execution Architecture:**
  - Complete elimination of intermediate disk streaming; 100% of active tensors remain in Kaggle's 30GB system RAM and 15GB VRAM for zero disk I/O bottlenecks.

---

## [0.1.0] - 2026-09-15

### Added
- **Core Architecture Documentation:**
  - [`System_Architecture_Design_in_NaturalLanguage.md`](file:///f:/Google-Antigravity-Code-Files/Custom-App-mimicking-Comfyui/System_Architecture_Design_in_NaturalLanguage.md)
  - [`ARCHITECTURE.md`](file:///f:/Google-Antigravity-Code-Files/Custom-App-mimicking-Comfyui/ARCHITECTURE.md)
  - [`NODES_AND_ADAPTERS.md`](file:///f:/Google-Antigravity-Code-Files/Custom-App-mimicking-Comfyui/NODES_AND_ADAPTERS.md)
- **Engine Subsystem (`/engine`):**
  - `engine/memory.py`: Deterministic VRAM purging (`purge_vram()`) and real-time GPU telemetry.
  - `engine/dag_parser.py`: Ingests ComfyUI API JSON, flattens reroutes, and sorts DAGs using `networkx` / Kahn's algorithm.
  - `engine/runner.py`: Sequential pipeline executor with stage-by-stage VRAM clearing and Server-Sent Events (SSE) progress callbacks.
  - `engine/storage.py`: Direct upload of MP4/PNG files to Cloudflare R2 ($0 egress fees) with local disk fallback.
  - `engine/database.py`: Aiven PostgreSQL cloud database integration for workflows and execution logs with local JSON fallback.
  - `engine/workflow_converter.py`: Ingests messy ComfyUI JSON, prunes visual clutter (reroutes, notes), audits adapter compatibility, explains the pipeline in plain English, and generates standalone Kaggle Python scripts.
  - `engine/node_converter.py`: Python AST static analyzer that de-bloats community ComfyUI node code into frozen `BaseAdapter` classes.
- **Isolated Node Adapters (`/adapters`):**
  - `adapters/base.py`: Standard `BaseAdapter` interface contract.
  - `adapters/gguf_loader.py`: Quantized DiT/UNet weight loader (Flux / LTX-2.5).
  - `adapters/text_encoder.py`: Dual CLIP/T5 text encoder with immediate VRAM deallocation.
  - `adapters/sampler.py`: FlowMatch Euler diffusion sampler.
  - `adapters/vae_decoder.py`: Latent to RGB autoencoder decoder.
  - `adapters/media_saver.py`: Direct PNG and MP4 video encoder via `imageio-ffmpeg`.
  - `adapters/converted/`: Storage directory for user-converted custom adapters.
- **3-Tab Visual Workspace UI (`/ui`):**
  - `ui/index.html`: Modern 3-tab layout (Canvas, Workflow Converter, Node Converter) with real-time VRAM gauge.
  - `ui/css/style.css`: Modern dark theme inspired by ComfyUI.
  - `ui/js/canvas.js`: Interactive HTML5 canvas with zooming, panning, and bezier wire linking.
  - `ui/js/nodes.js`: Node definitions, input/output pins, and parameter widgets.
  - `ui/js/workflow_converter.js`: Client-side logic for workflow simplification and Kaggle script export.
  - `ui/js/node_converter.js`: Client-side AST node scanner and adapter registrant.
  - `ui/js/app.js`: Master application controller with SSE execution progress listener and media preview modal.
- **Root Launchers & Presets:**
  - `server.py`: Master FastAPI web server serving UI, REST APIs, and SSE stream.
  - `kaggle_launch.py`: One-click Kaggle runner with automated Cloudflare Quick Tunnel setup.
  - `run_pipeline.py`: Pure headless CLI runner supporting both `--workflow-db` and `--workflow`.
  - `workflows/flux_txt2img.json`: Reference Flux text-to-image workflow.
  - `workflows/ltx_video.json`: Reference LTX-2.5 video workflow.
  - `requirements.txt`: Locked dependencies.
  - `.env.example`: Configuration template for Aiven PostgreSQL and Cloudflare R2.
