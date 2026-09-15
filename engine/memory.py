"""
Deterministic Memory Management (The T4 Protection Rule)
Guarantees clean stage-by-stage memory clearance for cloud GPU instances (e.g. Kaggle T4/P100).
"""

import gc
import logging
from typing import Dict, Any

logger = logging.getLogger("engine.memory")

try:
    import torch
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False


def purge_vram() -> None:
    """
    Deterministically evicts all cached GPU memory blocks and forces garbage collection.
    Must be called between execution stages (e.g. TextEncoder -> UNet/DiT -> VAE).
    """
    gc.collect()
    if TORCH_AVAILABLE and torch.cuda.is_available():
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()
        logger.info("VRAM purged successfully (CUDA cache emptied & IPC collected).")
    else:
        logger.debug("System GC run (CUDA not active or not available).")


def get_vram_info() -> Dict[str, Any]:
    """
    Returns real-time GPU memory metrics in Gigabytes.
    Safe to call even if running on CPU-only local machines.
    """
    if not TORCH_AVAILABLE or not torch.cuda.is_available():
        return {
            "cuda_available": False,
            "device_name": "CPU",
            "allocated_gb": 0.0,
            "reserved_gb": 0.0,
            "total_gb": 0.0,
            "free_gb": 0.0,
        }

    device = torch.cuda.current_device()
    total_bytes = torch.cuda.get_device_properties(device).total_memory
    allocated_bytes = torch.cuda.memory_allocated(device)
    reserved_bytes = torch.cuda.memory_reserved(device)
    free_bytes = total_bytes - reserved_bytes

    return {
        "cuda_available": True,
        "device_name": torch.cuda.get_device_name(device),
        "allocated_gb": round(allocated_bytes / (1024 ** 3), 2),
        "reserved_gb": round(reserved_bytes / (1024 ** 3), 2),
        "total_gb": round(total_bytes / (1024 ** 3), 2),
        "free_gb": round(free_bytes / (1024 ** 3), 2),
    }
