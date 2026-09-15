"""
Sequential Pipeline Runner & Dispatcher
Executes topologically sorted workflow nodes one by one with deterministic
VRAM flushes (purge_vram) between stages.
"""

import time
import logging
from typing import Dict, List, Any, Optional, Callable

from .dag_parser import DAGParser
from .memory import purge_vram, get_vram_info
from .storage import StorageManager
from .database import DatabaseManager
from .payload_diff import PayloadDiffEngine

logger = logging.getLogger("engine.runner")


class PipelineRunner:
    """
    Coordinates end-to-end execution of a workflow DAG.
    """

    def __init__(
        self,
        storage_mgr: Optional[StorageManager] = None,
        db_mgr: Optional[DatabaseManager] = None,
        progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None
    ):
        self.storage_mgr = storage_mgr or StorageManager()
        self.db_mgr = db_mgr or DatabaseManager()
        self.progress_callback = progress_callback
        self.node_outputs: Dict[str, Any] = {}
        self.payload_diff = PayloadDiffEngine()
        self.last_inspection_report: list = []

    def _emit_progress(self, event_type: str, data: Dict[str, Any]):
        if self.progress_callback:
            payload = {"event": event_type, "timestamp": time.time(), **data}
            try:
                self.progress_callback(payload)
            except Exception as e:
                logger.error(f"Error in progress callback: {e}")

    def execute(
        self,
        workflow: Dict[str, Any],
        workflow_name: str = "custom_run",
        overrides: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Executes the workflow graph sequentially.
        """
        start_time = time.time()
        self.node_outputs.clear()
        self.payload_diff.reset()
        saved_files = []

        # Parse & topologically sort
        parser = DAGParser(workflow)
        cleaned_nodes = parser.sanitize()
        exec_order = parser.get_execution_order()

        # Dynamic import of adapter registry
        from adapters import get_adapter

        total_nodes = len(exec_order)
        logger.info(f"Starting execution of {total_nodes} nodes in order: {exec_order}")

        self._emit_progress("started", {
            "workflow_name": workflow_name,
            "total_nodes": total_nodes,
            "execution_order": exec_order,
            "vram": get_vram_info()
        })

        try:
            for idx, node_id in enumerate(exec_order):
                node_data = cleaned_nodes[node_id]
                class_type = node_data.get("class_type", "Unknown")
                raw_inputs = node_data.get("inputs", {})

                self._emit_progress("node_started", {
                    "node_id": node_id,
                    "class_type": class_type,
                    "step": idx + 1,
                    "total_steps": total_nodes,
                    "vram": get_vram_info()
                })

                # 1. Resolve input references
                resolved_inputs = {}
                for k, v in raw_inputs.items():
                    if isinstance(v, list) and len(v) >= 2:
                        source_node_id = str(v[0])
                        output_slot = int(v[1])
                        
                        source_res = self.node_outputs.get(source_node_id)
                        if isinstance(source_res, dict):
                            # Slot or key lookup
                            resolved_inputs[k] = source_res.get(output_slot, source_res.get("output", source_res))
                        elif isinstance(source_res, (list, tuple)) and output_slot < len(source_res):
                            resolved_inputs[k] = source_res[output_slot]
                        else:
                            resolved_inputs[k] = source_res
                    else:
                        resolved_inputs[k] = v

                # Apply any programmatic overrides (e.g. prompt or seed)
                if overrides and class_type in ["CLIPTextEncode", "TextEncoder"]:
                    if "positive_prompt" in overrides and "text" in resolved_inputs:
                        resolved_inputs["text"] = overrides["positive_prompt"]
                if overrides and "seed" in overrides and "seed" in resolved_inputs:
                    resolved_inputs["seed"] = overrides["seed"]

                # 2. Get and execute adapter
                adapter_cls = get_adapter(class_type)
                logger.info(f"[{idx+1}/{total_nodes}] Running {class_type} (Node {node_id}) via {adapter_cls.__name__}")
                
                output = adapter_cls.execute(resolved_inputs)
                self.node_outputs[node_id] = output

                # Record into PayloadDiffEngine for isolated/cumulative inspection
                self.payload_diff.record(node_id, class_type, output)

                # Check if this node produced media files (images / videos)
                if isinstance(output, dict) and "saved_file" in output:
                    local_saved = output["saved_file"]
                    public_url = self.storage_mgr.save_media(local_saved)
                    saved_files.append(public_url)
                    output["public_url"] = public_url

                # 3. Deterministic Memory Clearing (The T4 Rule)
                # Purge VRAM after heavy generation stages
                if any(kw in class_type for kw in ["UNET", "Sampler", "VAE", "TextEncode", "Video"]):
                    adapter_cls.cleanup()
                    purge_vram()

                self._emit_progress("node_finished", {
                    "node_id": node_id,
                    "class_type": class_type,
                    "step": idx + 1,
                    "total_steps": total_nodes,
                    "vram": get_vram_info()
                })

            duration = round(time.time() - start_time, 2)
            logger.info(f"Pipeline executed successfully in {duration}s. Saved media: {saved_files}")

            # Log to Aiven PostgreSQL if connected
            self.db_mgr.log_execution(
                workflow_name=workflow_name,
                status="SUCCESS",
                duration_seconds=duration,
                media_url=saved_files[0] if saved_files else ""
            )

            result_payload = {
                "success": True,
                "workflow_name": workflow_name,
                "duration_seconds": duration,
                "saved_files": saved_files,
                "total_nodes": total_nodes,
                "vram": get_vram_info()
            }
            self._emit_progress("completed", result_payload)
            return result_payload

        except Exception as e:
            duration = round(time.time() - start_time, 2)
            logger.error(f"Pipeline execution failed: {e}", exc_info=True)
            self.db_mgr.log_execution(
                workflow_name=workflow_name,
                status="FAILED",
                duration_seconds=duration,
                error_message=str(e)
            )
            error_payload = {
                "success": False,
                "workflow_name": workflow_name,
                "duration_seconds": duration,
                "error": str(e),
                "vram": get_vram_info()
            }
            self._emit_progress("failed", error_payload)
            raise e
