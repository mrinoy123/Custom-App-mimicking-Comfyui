# Technical Architecture & Execution Logic

This document specifies the internal algorithms, storage abstractions, database persistence, and memory isolation rules governing the custom engine.

---

## 1. Multi-Tier Free-Cloud Architecture

```mermaid
graph TD
    subgraph Storage & Persistence Tier
        Git["GitHub (Engine Code & Adapters)"]
        Aiven["Aiven PostgreSQL (Workflows, Presets, Run Logs)"]
        R2["Cloudflare R2 (PNG Images & MP4 Videos - $0 Egress)"]
    end

    subgraph Compute Tier (Kaggle GPU / Local PC)
        CFT["Cloudflare Quick Tunnel (cloudflared)"]
        Server["server.py (FastAPI + SSE)"]
        Runner["engine/runner.py"]
        DAG["engine/dag_parser.py (networkx)"]
        MemMgr["engine/memory.py (purge_vram)"]
        Adapters["/adapters/ (Pure PyTorch)"]
    end

    subgraph Client Tier
        Canvas["Tab 1: Workflow Canvas"]
        WFConv["Tab 2: Workflow Converter"]
        NodeConv["Tab 3: Node Converter"]
    end

    Git -->|git pull| Compute Tier
    Aiven <-->|Sync Workflows & Logs| Server
    Aiven <-->|Fetch Workflow by Name| Runner
    Compute Tier -->|Upload Media| R2
    Server <-->|Public HTTPS Access| CFT
    CFT <--> Client Tier
    Runner --> DAG
    Runner --> Adapters
    Runner --> MemMgr
```

---

## 2. Cloudflare R2 Media Storage Subsystem (`engine/storage.py`)

### 2.1 Object Storage Contract
Cloudflare R2 provides an S3-compatible API with zero egress bandwidth costs.
- **Upload Flow:**
  - Media adapter (`adapters/media_saver.py`) writes raw frames to a local temporary buffer (`/tmp/output_<timestamp>.mp4`).
  - Storage module (`engine/storage.py`) uploads the file to the configured R2 bucket via `boto3`:
    ```python
    s3_client.upload_file(local_path, bucket_name, object_key, ExtraArgs={"ContentType": "video/mp4"})
    ```
  - Generates the public CDN URL: `https://<r2_public_domain>/<object_key>`.
- **Graceful Fallback:** If R2 environment variables (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) are not provided, files are saved locally to `outputs/` directory.

---

## 3. Aiven PostgreSQL Database Subsystem (`engine/database.py`)

### 3.1 Database Schema
```sql
-- Workflows Table
CREATE TABLE IF NOT EXISTS workflows (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    graph_json JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Execution History Logs Table
CREATE TABLE IF NOT EXISTS execution_logs (
    id SERIAL PRIMARY KEY,
    workflow_name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL, -- 'SUCCESS', 'FAILED', 'RUNNING'
    duration_seconds FLOAT,
    media_url TEXT,              -- Cloudflare R2 public URL
    prompt_used TEXT,
    seed_used BIGINT,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

### 3.2 Graceful Fallback
If `DATABASE_URL` is omitted, the engine defaults to reading and writing local `.json` files inside the `/workflows` directory.

---

## 4. Deterministic Memory Management (The T4 Protection Rule)

PyTorch retains allocated memory in its CUDA cache pool. ComfyUI's background daemons conflict with this allocator, resulting in deadlocks at ~6.7 GB VRAM. The engine enforces stage-by-stage purging:

$$\begin{aligned}
\text{Stage 1: Text Encoding} &\implies \text{Run T5/CLIP} \implies \text{Save Embeddings} \\
&\implies \texttt{del text\_encoder} \implies \texttt{gc.collect()} \implies \texttt{torch.cuda.empty\_cache()} \\
\text{Stage 2: DiT/UNet Sampling} &\implies \text{Stream GGUF/Safetensors} \implies \text{Compute Latents} \\
&\implies \texttt{del unet} \implies \texttt{gc.collect()} \implies \texttt{torch.cuda.empty\_cache()} \\
\text{Stage 3: Latent Decoding} &\implies \text{Load VAE} \implies \text{Decode to RGB Frames} \\
&\implies \texttt{del vae} \implies \texttt{gc.collect()} \implies \texttt{torch.cuda.empty\_cache()}
\end{aligned}$$

---

## 5. Subprocess Sandboxing & Process Boundaries

When executing hybrid pipelines involving disparate model architectures (e.g., **Flux 2D Diffusion $\rightarrow$ LTX-2.5 3D Video Diffusion**):
1. **Zero Shared State:** Stage 1 and Stage 2 run in completely separate OS processes via `subprocess.run()`.
2. **Intermediate Serialization Handshake:**
   - Stage 1 writes intermediate tensors/frames to disk (`/tmp/stage1_latent.safetensors`).
   - Stage 1 terminates. The operating system reclaims all GPU VRAM back to strictly $0.0\text{ GB}$.
   - Stage 2 launches, loads the intermediate file, and runs the video generation model.
3. Completely avoids attention kernel version conflicts and memory fragmentation.
