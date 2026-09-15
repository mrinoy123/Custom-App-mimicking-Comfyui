# System Architecture Design in Natural Language

## 1. Project Vision & Core Philosophy

This project builds a **custom, lightweight alternative to ComfyUI** that provides the visual node-graph flexibility of ComfyUI without its fatal flaws (VRAM deadlocks, memory freezes at ~6.7 GB, server/socket bloat, and ephemeral data loss).

The system operates across a 100% free-tier, permanent cloud ecosystem:
1. **GitHub:** Stores version-controlled application engine code, adapters, and UI.
2. **Aiven (PostgreSQL):** Stores workflow graph JSONs, prompt presets, and execution logs in a persistent cloud database (no git commits required for prompt updates).
3. **Kaggle (T4/P100 GPUs):** Provides free cloud GPU compute running headless execution or visual interactive testing.
4. **Cloudflare R2:** High-speed, S3-compatible object storage with **$0 egress fees** where all generated output media (PNG images and MP4 videos) are permanently saved.
5. **Cloudflare Tunnel (`cloudflared`):** Exposes the 3-tab visual UI securely over HTTPS during interactive Kaggle sessions.

---

## 2. Real-World Execution Pipeline

```
+─────────────────────────────────────────────────────────────────────────────+
|                               THE ECOSYSTEM                                 |
+─────────────────────────────────────────────────────────────────────────────+
|  1. GitHub:          Stores the APP CODE (engine, adapters, UI)             |
|  2. Aiven:           Stores WORKFLOW JSONs, prompt presets, & run logs      |
|  3. Kaggle:          Provides 15GB T4/P100 FREE GPU COMPUTE                 |
|  4. Cloudflare R2:   Stores all generated OUTPUT MEDIA (PNG images & MP4s)  |
|  5. Cloudflare Tunnel: Exposes the 3-tab VISUAL UI during manual Kaggle runs |
+─────────────────────────────────────────────────────────────────────────────+
```

### Flow A: Automated Headless Production Execution
1. Kaggle boots and pulls engine code from GitHub (`git pull`).
2. Engine connects to Aiven DB and fetches the target workflow JSON.
3. Engine topologically sorts the graph and executes stage-by-stage with strict VRAM purges (`purge_vram()`).
4. Engine uploads generated MP4/PNG files directly to Cloudflare R2.
5. Engine logs the public R2 media URL back to Aiven DB (`status = SUCCESS`).

### Flow B: Interactive Visual Testing on Kaggle
1. Kaggle launches `kaggle_launch.py`, starting the lightweight local server and opening a Cloudflare Tunnel.
2. User opens the live URL in their browser to access the 3-tab UI:
   - **Tab 1: Workflow Canvas:** Visual graph editor with live VRAM gauge and "Queue Execution" button.
   - **Tab 2: Workflow Converter & Inspector:** Ingests external ComfyUI JSON, strips clutter (reroutes, notes), audits compatibility, explains pipeline, and exports.
   - **Tab 3: Node Converter:** Ingests community Python node code, strips bloat via AST, and creates frozen PyTorch adapters.
3. User triggers execution; output images/videos upload to Cloudflare R2 and preview directly in the UI.

---

## 3. Deterministic Hardware & Memory Protection
* **The T4 Rule:** PyTorch CUDA cache is forcefully evicted between stages:
  $$\text{Text Encoding} \xrightarrow{\text{Purge}} \text{UNet/DiT Sampling} \xrightarrow{\text{Purge}} \text{VAE Decoding}$$
* **Process Sandboxing:** Distinct architectures (Flux 2D $\rightarrow$ LTX-2.5 3D) run in isolated subprocesses, dropping VRAM to strictly 0.0 GB between phases.
* **Local Machine Safety:** Local PC (GTX 1050 Ti 4GB / 16GB RAM) handles code editing, graph design, and AST node conversions with zero heavy model loads.
* **RAM-First Execution (Zero Intermediate Disk I/O):** Kaggle supplies 30GB of high-speed system RAM. 100% of active attention tensors, conditioning dicts, and intermediate latents remain in RAM/VRAM during compute. The disk is only touched once to write the completed output PNG/MP4 before R2 upload.

---

## 4. Specialized Utility Engines

1. **`JsonRepairSerializer` (`engine/json_repair.py`):**
   - Automatically repairs broken ComfyUI workflow JSON files from Civitai or GitHub.
   - Fixes trailing commas, unescaped quotes, NaN/Infinity literals, single-quote dictionaries, and strips LLM `<think>` tags without crashing the app.
   - Always stores complete, atomic workflow graphs to Aiven (no bandwidth limits, eliminating JSON patch delta complexity).

2. **`PayloadDiffEngine` (`engine/payload_diff.py`):**
   - Provides per-node output debugging in the UI inspector with two distinct views:
     - **Isolated Delta:** Shows strictly what a specific node produced (e.g. `[FluxTextEncode] CONDITIONING: <torch.Tensor shape=[1, 512, 4096]>`).
     - **Cumulative Full:** Shows the accumulated upstream tensor tree at that execution point.
   - Automatically serializes tensor and array shapes into safe metadata strings to prevent payload crashes.

3. **Rolling 3-Run Retention Engine (`engine/database.py`):**
   - Keeps only the 3 most recent execution logs per workflow in Aiven PostgreSQL.
   - Pruning occurs automatically on every run completion via atomic SQL subqueries, keeping database queries sub-5ms forever.

---

## 5. Visual Studio Workspace UI Design

* **Studio Grey Canvas (`#7e7e88`):** High-contrast matte grey workspace background with a 24px pure white dot grid.
* **Crisp `#ffffff` Bezier Wires:** Pure white connection cables with multi-stop drop shadows for tactile visual tracing.
* **Floating Draggable VRAM HUD:** Live, glass-morphic telemetry card that can be dragged across the viewport to monitor GPU memory allocation, reserved overhead, and execute manual cache purges on demand.

