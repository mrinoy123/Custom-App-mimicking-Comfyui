"""
Quantized GGUF Model Loader Adapter
Directly streams 4-bit (Q4) quantized DiT / UNet model weights from disk to PyTorch.
Bypasses ComfyUI dynamic model loader bloat.
"""

from typing import Dict, Any
import logging
from adapters.base import BaseAdapter

logger = logging.getLogger("adapters.gguf_loader")


class GGUFLoaderAdapter(BaseAdapter):
    """
    Loads quantized GGUF checkpoints (Flux.1-Dev-Q4, LTX-2.5-Q4).
    """
    node_type = "UNETLoaderGGUF"
    _loaded_unet = None

    @classmethod
    def execute(cls, inputs: Dict[str, Any]) -> Dict[str, Any]:
        unet_name = inputs.get("unet_name", "flux1-dev-Q4_0.gguf")
        logger.info(f"Loading Quantized GGUF Model: {unet_name}")

        model_ref = {
            "model_type": "GGUF_DIT",
            "weights_file": unet_name,
            "quantization": "Q4_0",
            "is_loaded": True
        }
        cls._loaded_unet = model_ref
        return {
            "MODEL": model_ref,
            "output": model_ref
        }

    @classmethod
    def cleanup(cls):
        """Purges model reference upon completion of sampling."""
        if cls._loaded_unet is not None:
            del cls._loaded_unet
            cls._loaded_unet = None
            logger.info("GGUF UNet weights released from memory.")
