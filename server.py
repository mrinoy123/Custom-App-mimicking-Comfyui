"""
Master FastAPI Web Server & API Gateway
Serves the 3-Tab Visual Workspace UI, handles Aiven DB sync, Cloudflare R2 uploads,
and streams real-time execution progress via Server-Sent Events (SSE).
"""

import os
import json
import asyncio
import logging
from typing import Dict, Any, Optional
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from engine.memory import get_vram_info
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


@app.get("/api/nodes")
def api_nodes():
    """Returns registered native and converted node adapters."""
    return list_available_nodes()


@app.get("/api/workflows")
def api_list_workflows():
    """Returns saved workflows from Aiven database or local disk."""
    return db_mgr.list_workflows()


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


@app.post("/api/workflows")
def api_save_workflow(req: WorkflowSaveRequest):
    """Saves workflow graph to Aiven PostgreSQL cloud database."""
    success = db_mgr.save_workflow(req.name, req.graph_json, req.description)
    return {"success": success, "name": req.name}


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
