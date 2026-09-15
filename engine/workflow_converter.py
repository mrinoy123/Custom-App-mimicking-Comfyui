"""
Workflow Converter & Inspector Subsystem
Analyzes messy ComfyUI workflow JSONs, prunes visual spaghetti (reroutes, notes),
audits adapter compatibility, generates plain-language explanations, and exports
standalone Kaggle Python scripts.
"""

import json
import logging
from typing import Dict, List, Any, Tuple

from .dag_parser import DAGParser
from .json_repair import JsonRepairSerializer

logger = logging.getLogger("engine.workflow_converter")


class WorkflowConverter:
    """
    Ingests, cleans, audits, and converts ComfyUI workflow JSON files.
    """

    # Native adapters supported out-of-the-box by our micro-engine
    NATIVE_ADAPTERS = {
        "UNETLoaderGGUF": "gguf_loader",
        "DualCLIPLoader": "text_encoder",
        "CLIPTextEncode": "text_encoder",
        "KSampler": "sampler",
        "KSamplerAdvanced": "sampler",
        "VAEDecode": "vae_decoder",
        "SaveImage": "media_saver",
        "VHS_VideoCombine": "media_saver",
        "SaveVideo": "media_saver",
        "EmptyLatentImage": "builtin_latent",
        "LoraLoaderModelOnly": "lora_adapter",
    }

    def __init__(self, raw_workflow_json: Dict[str, Any]):
        self.raw_workflow = raw_workflow_json
        self.parser = DAGParser(self.raw_workflow)

    @classmethod
    def from_raw_text(cls, raw_text: str) -> "WorkflowConverter":
        """
        Constructs a WorkflowConverter from raw string input (file paste, API upload, etc.).
        Automatically runs JsonRepairSerializer on the input before parsing —
        so broken ComfyUI JSONs from Civitai/GitHub load without crashing.
        Raises ValueError if the input is completely unrepairable.
        """
        repaired = JsonRepairSerializer.repair(raw_text)
        if repaired is None:
            raise ValueError("Input could not be parsed as valid JSON even after all repair strategies.")
        return cls(repaired)

    def analyze(self) -> Dict[str, Any]:
        """
        Performs full audit: clutter removed, compatibility checklist,
        and natural-language breakdown.
        """
        cleaned_nodes = self.parser.sanitize()
        original_count = len(self.raw_workflow)
        cleaned_count = len(cleaned_nodes)
        pruned_count = original_count - cleaned_count

        supported_nodes = []
        missing_nodes = []
        node_types_seen = set()

        for node_id, node_info in cleaned_nodes.items():
            ctype = node_info.get("class_type", "Unknown")
            if ctype in node_types_seen:
                continue
            node_types_seen.add(ctype)

            if ctype in self.NATIVE_ADAPTERS:
                supported_nodes.append({"class_type": ctype, "adapter": self.NATIVE_ADAPTERS[ctype]})
            else:
                missing_nodes.append({"class_type": ctype, "status": "Needs Node Converter"})

        # Generate Natural Language Explanation
        explanation = self._generate_explanation(cleaned_nodes)

        return {
            "original_node_count": original_count,
            "cleaned_node_count": cleaned_count,
            "pruned_clutter_count": pruned_count,
            "supported_nodes": supported_nodes,
            "missing_nodes": missing_nodes,
            "is_fully_supported": len(missing_nodes) == 0,
            "explanation": explanation,
            "cleaned_graph": cleaned_nodes,
        }

    def _generate_explanation(self, cleaned_nodes: Dict[str, Any]) -> str:
        """Translates the workflow graph into a human-readable operational description."""
        prompts = []
        steps = "20"
        models = []
        outputs = []

        for node_id, node_info in cleaned_nodes.items():
            ctype = node_info.get("class_type", "")
            inputs = node_info.get("inputs", {})

            if "CLIPTextEncode" in ctype or "text" in inputs:
                text_val = inputs.get("text", "")
                if isinstance(text_val, str) and len(text_val.strip()) > 0:
                    prompts.append(f'"{text_val[:60]}..."' if len(text_val) > 60 else f'"{text_val}"')

            if "Sampler" in ctype:
                steps = str(inputs.get("steps", steps))

            if "Loader" in ctype:
                for k in ["unet_name", "ckpt_name", "model_name"]:
                    if k in inputs:
                        models.append(str(inputs[k]))

            if "Save" in ctype or "Combine" in ctype:
                outputs.append("Video (MP4)" if "Video" in ctype or "VHS" in ctype else "Image (PNG)")

        model_summary = ", ".join(models) if models else "Diffusion Checkpoint / GGUF"
        output_summary = ", ".join(set(outputs)) if outputs else "Generated Media"
        prompt_summary = " and ".join(prompts) if prompts else "User prompt"

        return (
            f"This pipeline executes an AI generation workflow using {model_summary}. "
            f"It conditions the model on {prompt_summary}, executes {steps} denoising steps, "
            f"and renders the final {output_summary} with direct Cloudflare R2 upload."
        )

    def export_as_python_script(self, workflow_name: str = "custom_pipeline") -> str:
        """
        Generates a standalone, ready-to-run Kaggle Python script
        that executes this exact workflow without needing any UI.
        """
        cleaned_nodes = self.parser.sanitize()
        ordered_ids = self.parser.get_execution_order()

        script_lines = [
            f"# ===========================================================",
            f"# Standalone Headless Kaggle Execution Script: {workflow_name}",
            f"# Generated by Custom ComfyUI Micro-Engine",
            f"# ===========================================================",
            "",
            "import os",
            "import sys",
            "from engine.runner import PipelineRunner",
            "",
            "# Workflow Graph Definition (Topologically Cleaned)",
            f"WORKFLOW = {json.dumps(cleaned_nodes, indent=4)}",
            "",
            "def main():",
            "    print('Starting headless Kaggle execution...')",
            "    runner = PipelineRunner()",
            "    results = runner.execute(WORKFLOW)",
            "    print('Execution complete!')",
            "    for file_path in results.get('saved_files', []):",
            "        print(f'Saved media: {file_path}')",
            "",
            "if __name__ == '__main__':",
            "    main()",
        ]
        return "\n".join(script_lines)
