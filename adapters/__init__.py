"""
Adapter Registry Subsystem
Registers all native and user-converted node adapters and maps ComfyUI class_types.
"""

import importlib
import logging
from typing import Dict, Type
from adapters.base import BaseAdapter
from adapters.gguf_loader import GGUFLoaderAdapter
from adapters.text_encoder import TextEncoderAdapter
from adapters.sampler import SamplerAdapter
from adapters.vae_decoder import VAEDecoderAdapter
from adapters.media_saver import MediaSaverAdapter

logger = logging.getLogger("adapters")

# Primary mapping of ComfyUI node class_type to native BaseAdapter
ADAPTER_REGISTRY: Dict[str, Type[BaseAdapter]] = {
    "UNETLoaderGGUF": GGUFLoaderAdapter,
    "DualCLIPLoader": TextEncoderAdapter,
    "CLIPTextEncode": TextEncoderAdapter,
    "KSampler": SamplerAdapter,
    "KSamplerAdvanced": SamplerAdapter,
    "VAEDecode": VAEDecoderAdapter,
    "SaveImage": MediaSaverAdapter,
    "SaveVideo": MediaSaverAdapter,
    "VHS_VideoCombine": MediaSaverAdapter,
}


class GenericPassthroughAdapter(BaseAdapter):
    """Fallback adapter for unknown or custom pass-through nodes."""
    node_type = "GenericNode"

    @classmethod
    def execute(cls, inputs):
        logger.warning(f"Executing generic passthrough for unmapped node.")
        return {"output": inputs}


def get_adapter(class_type: str) -> Type[BaseAdapter]:
    """
    Resolves a ComfyUI class_type string to an executable BaseAdapter class.
    Checks native registry first, then scans adapters/converted/, then falls back to generic.
    """
    if class_type in ADAPTER_REGISTRY:
        return ADAPTER_REGISTRY[class_type]

    # Check for converted adapter in adapters.converted
    try:
        module_name = f"adapters.converted.{class_type.lower()}_adapter"
        mod = importlib.import_module(module_name)
        for attr_name in dir(mod):
            attr = getattr(mod, attr_name)
            if isinstance(attr, type) and issubclass(attr, BaseAdapter) and attr != BaseAdapter:
                ADAPTER_REGISTRY[class_type] = attr
                return attr
    except ModuleNotFoundError:
        pass

    logger.warning(f"No specific adapter found for '{class_type}'. Using GenericPassthroughAdapter.")
    return GenericPassthroughAdapter


def list_available_nodes() -> Dict[str, str]:
    """Returns a list of all registered node types and their adapters."""
    return {k: v.__name__ for k, v in ADAPTER_REGISTRY.items()}
