"""
DAG Parser & Topological Graph Sorter
Ingests workflow JSON, strips UI-only nodes (Reroutes, Notes), and produces
a strict linear execution sequence using networkx.
"""

import logging
from typing import Dict, List, Any, Tuple, Set

logger = logging.getLogger("engine.dag_parser")

try:
    import networkx as nx
    NETWORKX_AVAILABLE = True
except ImportError:
    NETWORKX_AVAILABLE = False


class DAGParseException(Exception):
    """Raised when workflow JSON has syntax, cycle, or linkage errors."""
    pass


class DAGParser:
    """
    Parses and sanitizes ComfyUI API workflow graphs.
    """
    
    # UI-only nodes that carry no computational weight and must be bypassed
    UI_NODES = {"Reroute", "Note", "Markdown", "PrimitiveNode"}

    def __init__(self, workflow: Dict[str, Any]):
        if not isinstance(workflow, dict):
            raise DAGParseException("Workflow data must be a JSON dictionary.")
        self.raw_workflow = workflow
        self.cleaned_nodes: Dict[str, Dict[str, Any]] = {}
        self.edges: List[Tuple[str, str]] = []

    def sanitize(self) -> Dict[str, Dict[str, Any]]:
        """
        Removes visual artifacts like Reroutes and PrimitiveNodes,
        reconnecting upstream producers directly to downstream consumers.
        """
        nodes = {}
        reroute_map: Dict[str, Tuple[str, int]] = {}

        # 1. First pass: Identify reroutes and primitive nodes
        for node_id, node_data in self.raw_workflow.items():
            if not isinstance(node_data, dict):
                continue
            class_type = node_data.get("class_type", "")
            
            if class_type == "Reroute":
                # A reroute typically has input link: inputs: {"*": ["upstream_id", slot]}
                inputs = node_data.get("inputs", {})
                for val in inputs.values():
                    if isinstance(val, list) and len(val) >= 2:
                        reroute_map[node_id] = (str(val[0]), int(val[1]))
                        break
            elif class_type in {"Note", "Markdown"}:
                # Discard completely
                continue
            else:
                nodes[node_id] = {
                    "class_type": class_type,
                    "inputs": dict(node_data.get("inputs", {})),
                    "_meta": node_data.get("_meta", {})
                }

        # 2. Second pass: Flatten reroutes in all inputs
        for node_id, node_data in nodes.items():
            inputs = node_data["inputs"]
            for param_key, param_val in list(inputs.items()):
                if isinstance(param_val, list) and len(param_val) >= 2:
                    source_id = str(param_val[0])
                    output_slot = int(param_val[1])
                    
                    # Trace through any chained reroutes
                    visited_reroutes = set()
                    while source_id in reroute_map:
                        if source_id in visited_reroutes:
                            raise DAGParseException(f"Circular reroute detected at node {source_id}")
                        visited_reroutes.add(source_id)
                        source_id, output_slot = reroute_map[source_id]

                    inputs[param_key] = [source_id, output_slot]

        self.cleaned_nodes = nodes
        return self.cleaned_nodes

    def get_execution_order(self) -> List[str]:
        """
        Constructs a Directed Acyclic Graph and returns nodes in topological execution order.
        """
        if not self.cleaned_nodes:
            self.sanitize()

        self.edges = []
        for target_id, node_data in self.cleaned_nodes.items():
            for param_val in node_data["inputs"].values():
                if isinstance(param_val, list) and len(param_val) >= 2:
                    source_id = str(param_val[0])
                    if source_id in self.cleaned_nodes:
                        self.edges.append((source_id, target_id))

        if NETWORKX_AVAILABLE:
            G = nx.DiGraph()
            for node_id in self.cleaned_nodes:
                G.add_node(node_id)
            for source, target in self.edges:
                G.add_edge(source, target)

            if not nx.is_directed_acyclic_graph(G):
                cycles = list(nx.simple_cycles(G))
                raise DAGParseException(f"Workflow contains circular dependency cycles: {cycles}")

            return list(nx.topological_sort(G))
        else:
            # Fallback pure-Python Kahn's topological sort
            return self._kahn_topological_sort()

    def _kahn_topological_sort(self) -> List[str]:
        in_degree = {node: 0 for node in self.cleaned_nodes}
        adj = {node: [] for node in self.cleaned_nodes}

        for source, target in self.edges:
            adj[source].append(target)
            in_degree[target] += 1

        queue = [node for node, deg in in_degree.items() if deg == 0]
        order = []

        while queue:
            curr = queue.pop(0)
            order.append(curr)
            for neighbor in adj[curr]:
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    queue.append(neighbor)

        if len(order) != len(self.cleaned_nodes):
            raise DAGParseException("Graph has at least one circular dependency cycle.")

        return order
