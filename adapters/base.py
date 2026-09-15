"""
Standard Base Adapter Interface
Defines the mathematical execution and cleanup contract for all adapters.
"""

from typing import Dict, Any
import logging

logger = logging.getLogger("adapters.base")


class BaseAdapter:
    """
    Base contract for all native and converted node adapters.
    """
    node_type: str = "BaseNode"
    inputs_schema: Dict[str, Any] = {}
    outputs_schema: Dict[str, Any] = {}

    @classmethod
    def execute(cls, inputs: Dict[str, Any]) -> Dict[str, Any]:
        """
        Executes the pure mathematical tensor operation.
        
        Args:
            inputs: Dictionary containing scalar values and resolved upstream tensors.
            
        Returns:
            Dictionary containing output tensors or artifact paths.
        """
        raise NotImplementedError(f"Execute method not implemented for {cls.__name__}")

    @classmethod
    def cleanup(cls) -> None:
        """
        Optional hook to release transient model weights or VRAM allocations.
        """
        pass
