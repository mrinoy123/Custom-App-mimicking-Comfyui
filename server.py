"""
Master FastAPI Web Server & API Gateway
Serves the 3-Tab Visual Workspace UI, handles Aiven DB sync, Cloudflare R2 uploads,
and streams real-time execution progress via Server-Sent Events (SSE).
"""

import os
import json
import asyncio
import logging
import shutil
import subprocess
from typing import Dict, Any, Optional
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from engine.memory import get_vram_info, purge_vram
from engine.storage import StorageManager
from engine.database import DatabaseManager
from engine.workflow_converter import WorkflowConverter
from engine.node_converter import NodeConverter
from engine.runner import PipelineRunner
from adapters import list_available_nodes

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("server")

app = FastAPI(title="Custom ComfyUI Micro-Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Core Subsystems
storage_mgr = StorageManager()
db_mgr = DatabaseManager()
node_converter = NodeConverter()

# Broadcast queue for Server-Sent Events (SSE)
sse_subscribers = []


def sse_broadcast(payload: Dict[str, Any]):
    """Broadcasts progress events to all connected UI clients."""
    msg = f"data: {json.dumps(payload)}\n\n"
    for queue in sse_subscribers:
        try:
            queue.put_nowait(msg)
        except Exception:
            pass


# --------------------------------------------------------------------------
# API Endpoints
# --------------------------------------------------------------------------

@app.get("/api/vram")
def api_vram():
    """Returns live GPU VRAM telemetry."""
    return get_vram_info()


@app.post("/api/purge-vram")
def api_purge_vram():
    """Manually purges PyTorch CUDA cache, triggers gc, and returns updated telemetry."""
    purge_vram()
    return {"purged": True, "vram": get_vram_info()}


def _find_git_cmd():
    for p in ["git", r"C:\Program Files\Git\cmd\git.exe", r"C:\Program Files\Git\bin\git.exe"]:
        if shutil.which(p) or os.path.isfile(p):
            return p
    return "git"


@app.post("/api/github/pull")
def api_github_pull():
    """Pulls latest updates from GitHub origin main into local PC."""
    git_bin = _find_git_cmd()
    try:
        res = subprocess.run([git_bin, "pull", "origin", "main"], capture_output=True, text=True, check=True)
        return {"success": True, "message": res.stdout.strip() or "Already up to date."}
    except subprocess.CalledProcessError as e:
        return {"success": False, "error": e.stderr.strip() or str(e)}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.post("/api/github/push")
def api_github_push():
    """Stages local changes, commits, and pushes to GitHub origin main."""
    git_bin = _find_git_cmd()
    try:
        subprocess.run([git_bin, "add", "."], check=True)
        diff = subprocess.run([git_bin, "status", "--porcelain"], capture_output=True, text=True)
        if diff.stdout.strip():
            subprocess.run([git_bin, "commit", "-m", "Sync updates from MicroEngine UI"], check=True)
        res = subprocess.run([git_bin, "push", "origin", "main"], capture_output=True, text=True, check=True)
        return {"success": True, "message": "Pushed to GitHub successfully!"}
    except subprocess.CalledProcessError as e:
        return {"success": False, "error": e.stderr.strip() or str(e)}
    except Exception as e:
        return {"success": False, "error": str(e)}


# --------------------------------------------------------------------------
# Environment & Cloud Database Management Endpoints
# --------------------------------------------------------------------------

def _mask_secret(val: Optional[str]) -> str:
    if not val:
        return ""
    if len(val) <= 8:
        return "********"
    return val[:4] + "********" + val[-4:]


@app.get("/api/env")
def api_get_env():
    """Returns current environment variable status with sensitive secrets masked."""
    return {
        "DATABASE_URL": _mask_secret(os.getenv("DATABASE_URL")),
        "R2_ACCOUNT_ID": _mask_secret(os.getenv("R2_ACCOUNT_ID")),
        "R2_ACCESS_KEY_ID": _mask_secret(os.getenv("R2_ACCESS_KEY_ID")),
        "R2_SECRET_ACCESS_KEY": _mask_secret(os.getenv("R2_SECRET_ACCESS_KEY")),
        "R2_BUCKET_NAME": os.getenv("R2_BUCKET_NAME", ""),
        "R2_PUBLIC_DOMAIN": os.getenv("R2_PUBLIC_DOMAIN", ""),
        "has_database_url": bool(os.getenv("DATABASE_URL")),
        "has_r2": bool(os.getenv("R2_ACCESS_KEY_ID") and os.getenv("R2_SECRET_ACCESS_KEY")),
    }


class EnvSaveRequest(BaseModel):
    DATABASE_URL: Optional[str] = None
    R2_ACCOUNT_ID: Optional[str] = None
    R2_ACCESS_KEY_ID: Optional[str] = None
    R2_SECRET_ACCESS_KEY: Optional[str] = None
    R2_BUCKET_NAME: Optional[str] = None
    R2_PUBLIC_DOMAIN: Optional[str] = None


@app.post("/api/env")
def api_save_env(req: EnvSaveRequest):
    """
    Saves environment variables to .env file on Kaggle or local PC,
    hot-reloads runtime managers, and returns connection diagnostics.
    """
    global db_mgr, storage_mgr
    updates = {}
    for field, val in req.dict().items():
        if val is not None and val.strip() and not val.startswith("****"):
            os.environ[field] = val.strip()
            updates[field] = val.strip()

    # Persist to .env file
    env_lines = []
    if os.path.exists(".env"):
        with open(".env", "r", encoding="utf-8") as f:
            for line in f:
                line_strip = line.strip()
                if "=" in line_strip and not line_strip.startswith("#"):
                    k = line_strip.split("=")[0].strip()
                    if k not in updates:
                        env_lines.append(line.rstrip())
    for k, v in updates.items():
        env_lines.append(f"{k}={v}")

    with open(".env", "w", encoding="utf-8") as f:
        f.write("\n".join(env_lines) + "\n")

    # Hot-reload managers
    if "DATABASE_URL" in updates:
        db_mgr.reconnect(updates["DATABASE_URL"])
    if any(k.startswith("R2_") for k in updates):
        storage_mgr = StorageManager()

    db_diag = db_mgr.test_connection()
    return {
        "success": True,
        "updated_keys": list(updates.keys()),
        "db_status": db_diag
    }


@app.get("/api/db/status")
def api_db_status():
    """Returns real-time connection status and table statistics for Aiven PostgreSQL."""
    return db_mgr.test_connection()


@app.post("/api/db/sync")
def api_db_sync():
    """Triggers bidirectional sync between local JSON files and Aiven PostgreSQL."""
    return db_mgr.sync_workflows()


@app.get("/api/nodes")
def api_nodes():
    """Returns registered native and converted node adapters."""
    return list_available_nodes()


@app.get("/api/workflows")
def api_list_workflows():
    """Returns saved workflows with hierarchy topology metadata."""
    wfs = db_mgr.list_workflows()
    return {"workflows": wfs}


@app.get("/api/workflows/{name}")
def api_get_workflow(name: str):
    """Retrieves a specific workflow JSON by name."""
    wf = db_mgr.get_workflow(name)
    if wf is None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return wf


class WorkflowSaveRequest(BaseModel):
    name: str
    graph_json: Dict[str, Any]
    description: Optional[str] = ""
    title: Optional[str] = None
    role: Optional[str] = "master"
    parent_id: Optional[str] = None
    active: Optional[bool] = False


@app.post("/api/workflows")
def api_save_workflow(req: WorkflowSaveRequest):
    """Saves workflow graph to Aiven PostgreSQL cloud database or local storage."""
    success = db_mgr.save_workflow(
        name=req.name,
        graph_json=req.graph_json,
        description=req.description or "",
        role=req.role or "master",
        parent_id=req.parent_id,
        active=req.active or False,
        title=req.title or req.name
    )
    return {"success": success, "name": req.name}


class WorkflowActiveRequest(BaseModel):
    active: bool


@app.post("/api/workflows/{name}/active")
def api_toggle_workflow_active(name: str, req: WorkflowActiveRequest):
    """Toggles workflow active state."""
    success = db_mgr.toggle_workflow_active(name, req.active)
    return {"success": success, "name": name, "active": req.active}


@app.delete("/api/workflows/{name}")
def api_delete_workflow(name: str):
    """Deletes a workflow."""
    success = db_mgr.delete_workflow(name)
    return {"success": success, "name": name}


class WorkflowConvertRequest(BaseModel):
    workflow_json: Any  # Accepts either dict or raw JSON string (auto-repaired)


@app.post("/api/convert-workflow")
def api_convert_workflow(req: WorkflowConvertRequest):
    """
    Tab 2: Ingests external ComfyUI JSON, auto-repairs broken syntax,
    prunes clutter nodes, audits compatibility, and explains the graph.
    Accepts both dict and raw string input (JsonRepairSerializer handles broken files).
    """
    try:
        raw = req.workflow_json
        if isinstance(raw, str):
            conv = WorkflowConverter.from_raw_text(raw)
        else:
            conv = WorkflowConverter(raw)
        audit = conv.analyze()
        return audit
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error(f"Error analyzing workflow: {e}")
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/export-script")
def api_export_script(req: WorkflowConvertRequest):
    """Tab 2: Generates a standalone Kaggle Python script from the workflow JSON."""
    try:
        raw = req.workflow_json
        if isinstance(raw, str):
            conv = WorkflowConverter.from_raw_text(raw)
        else:
            conv = WorkflowConverter(raw)
        script_code = conv.export_as_python_script()
        return {"python_script": script_code}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


class NodeScanRequest(BaseModel):
    python_code: str


@app.post("/api/scan-nodes")
def api_scan_nodes(req: NodeScanRequest):
    """Tab 3: Uses AST to scan ComfyUI Python code for node classes."""
    try:
        nodes = node_converter.scan_file_for_nodes(req.python_code)
        return {"nodes": nodes}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


class NodeConvertRequest(BaseModel):
    python_code: str
    selected_class_name: str
    custom_adapter_name: Optional[str] = None


@app.post("/api/convert-node")
def api_convert_node(req: NodeConvertRequest):
    """Tab 3: De-bloats target node class and emits a clean BaseAdapter."""
    try:
        res = node_converter.convert_node(
            req.python_code,
            req.selected_class_name,
            req.custom_adapter_name
        )
        return res
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


class ExecuteRequest(BaseModel):
    workflow: Dict[str, Any]
    workflow_name: Optional[str] = "ui_execution"
    overrides: Optional[Dict[str, Any]] = None


# Single shared runner instance so /api/inspect can access last run's payload diff
_active_runner: Optional[Any] = None


@app.post("/api/execute")
async def api_execute(req: ExecuteRequest):
    """Triggers sequential pipeline execution and streams SSE progress."""
    global _active_runner
    try:
        runner = PipelineRunner(
            storage_mgr=storage_mgr,
            db_mgr=db_mgr,
            progress_callback=sse_broadcast
        )
        _active_runner = runner

        # Run pipeline in a worker thread so the async event loop stays responsive
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None,
            runner.execute,
            req.workflow,
            req.workflow_name,
            req.overrides
        )
        return result
    except Exception as e:
        logger.error(f"Execution failed: {e}")
        return {"success": False, "error": str(e)}


@app.get("/api/inspect")
def api_inspect():
    """
    PayloadDiffEngine: Returns a full per-node inspection report for the most recent run.
    Each entry contains:
      - node_id, class_type
      - isolated_delta:   ONLY what this node produced (clean, tensor-safe metadata)
      - cumulative_full:  All accumulated outputs up to this node
    Used by the Node Inspector panel in the UI.
    """
    if _active_runner is None:
        return {"nodes": [], "message": "No pipeline run yet. Execute a workflow first."}
    report = _active_runner.payload_diff.get_full_report()
    return {"nodes": report}


@app.get("/api/history/{workflow_name}")
def api_execution_history(workflow_name: str):
    """Returns the 3 most recent execution runs for a workflow (Rolling Retention)."""
    history = db_mgr.get_execution_history(workflow_name)
    return {"workflow_name": workflow_name, "runs": history}


@app.get("/api/progress")
async def api_progress(request: Request):
    """Server-Sent Events (SSE) stream endpoint for live stage progress & VRAM."""
    queue = asyncio.Queue()
    sse_subscribers.append(queue)

    async def event_generator():
        try:
            while True:
                if await request.is_disconnected():
                    break
                data = await queue.get()
                yield data
        finally:
            if queue in sse_subscribers:
                sse_subscribers.remove(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
    )


# --------------------------------------------------------------------------
# Static Assets & UI Serving
# --------------------------------------------------------------------------

os.makedirs("outputs", exist_ok=True)
app.mount("/outputs", StaticFiles(directory="outputs"), name="outputs")

if os.path.exists("ui"):
    app.mount("/", StaticFiles(directory="ui", html=True), name="ui")


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    host = os.getenv("HOST", "0.0.0.0")
    print(f"Starting Custom ComfyUI Micro-Engine on http://{host}:{port}")
    uvicorn.run("server:app", host=host, port=port, reload=False)
