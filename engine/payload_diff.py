"""
Payload Diff Engine (Delta vs. Full Inspector)
Provides two complementary views of node execution outputs for debugging:
  - Isolated Delta:    Strictly what THIS node produced (new keys only).
  - Cumulative Full:   All upstream data accumulated up to this point.
"""

import copy
import logging
from typing import Dict, Any, List, Tuple

logger = logging.getLogger("engine.payload_diff")


class PayloadDiffEngine:
    """
    Tracks execution payloads per node and computes isolated vs. cumulative diffs.
    Attach one instance per pipeline run.
    """

    def __init__(self):
        # Stores the raw output dict per node_id
        self._node_outputs: Dict[str, Dict[str, Any]] = {}
        # Ordered execution log: (node_id, class_type)
        self._execution_order: List[Tuple[str, str]] = []

    def record(self, node_id: str, class_type: str, output: Dict[str, Any]):
        """Records a node's output after execution."""
        self._node_outputs[node_id] = copy.deepcopy(output)
        self._execution_order.append((node_id, class_type))
        logger.debug(f"PayloadDiffEngine recorded output for node {node_id} ({class_type})")

    def get_isolated_delta(self, node_id: str) -> Dict[str, Any]:
        """
        Returns ONLY what this specific node produced.
        Strips out all upstream tensor references passed through.
        Useful for: verifying a specific adapter's exact output.
        Example: Text Encoder delta shows just { "CONDITIONING": <tensor> }
        """
        output = self._node_outputs.get(node_id, {})
        # Return a shallow summary-safe version (replace large tensors with metadata)
        return self._summarize(output)

    def get_cumulative_payload(self, node_id: str) -> Dict[str, Any]:
        """
        Returns ALL outputs from every node that ran up to and including this node.
        Useful for: understanding the full data context available at any execution point.
        """
        cumulative = {}
        for exec_id, class_type in self._execution_order:
            output = self._node_outputs.get(exec_id, {})
            # Prefix key with node context to avoid key collisions
            for k, v in output.items():
                cumulative[f"[{class_type}#{exec_id}] {k}"] = self._summarize_value(v)
            if exec_id == node_id:
                break
        return cumulative

    def get_full_report(self) -> List[Dict[str, Any]]:
        """
        Returns a complete execution report for all nodes with both views.
        Used by the /api/inspect endpoint consumed by the UI inspector panel.
        """
        report = []
        for node_id, class_type in self._execution_order:
            report.append({
                "node_id": node_id,
                "class_type": class_type,
                "isolated_delta": self.get_isolated_delta(node_id),
                "cumulative_full": self.get_cumulative_payload(node_id),
            })
        return report

    def reset(self):
        """Clears recorded outputs between pipeline runs."""
        self._node_outputs.clear()
        self._execution_order.clear()

    @staticmethod
    def _summarize(output: Dict[str, Any]) -> Dict[str, Any]:
        """Returns a human-readable summary of an output dictionary."""
        return {k: PayloadDiffEngine._summarize_value(v) for k, v in output.items()}

    @staticmethod
    def _summarize_value(v: Any) -> Any:
        """
        Replaces non-serializable large objects (tensors, numpy arrays)
        with safe metadata strings to prevent API serialization crashes.
        """
        type_name = type(v).__name__

        if type_name == "Tensor":
            return f"<torch.Tensor shape={list(v.shape)} dtype={v.dtype} device={v.device}>"
        elif type_name == "ndarray":
            return f"<numpy.ndarray shape={v.shape} dtype={v.dtype}>"
        elif isinstance(v, dict):
            return {k2: PayloadDiffEngine._summarize_value(v2) for k2, v2 in v.items()}
        elif isinstance(v, (list, tuple)):
            return [PayloadDiffEngine._summarize_value(item) for item in v[:5]]
        elif isinstance(v, (str, int, float, bool)) or v is None:
            return v
        else:
            return f"<{type_name}>"
