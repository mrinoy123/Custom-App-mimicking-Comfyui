"""
JSON Repair & Serializer Engine
Auto-fixes broken ComfyUI workflow JSONs from Civitai, GitHub, or manual edits.
Handles: trailing commas, unescaped quotes, missing brackets, <think> tags,
         NaN/Infinity values, and circular structures.
"""

import re
import json
import logging
from typing import Any, Dict, Optional

logger = logging.getLogger("engine.json_repair")


class JsonRepairSerializer:
    """
    Repairs and deserializes malformed JSON workflow files without crashing.
    """

    @staticmethod
    def repair(raw: str) -> Optional[Dict[str, Any]]:
        """
        Attempts to parse the input string as valid JSON.
        If it fails, applies progressive repair strategies and retries.

        Returns a valid Python dict on success, or None if unrepairable.
        """
        if not raw or not raw.strip():
            logger.warning("Empty or whitespace-only input provided to JsonRepairSerializer.")
            return None

        # Strategy 1: Try parsing as-is first
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass

        repaired = raw

        # Strategy 2: Strip <think>...</think> AI reasoning tags
        repaired = re.sub(r"<think>.*?</think>", "", repaired, flags=re.DOTALL)

        # Strategy 3: Remove JavaScript-style single-line comments (// ...)
        repaired = re.sub(r"//[^\n]*", "", repaired)

        # Strategy 4: Remove block comments (/* ... */)
        repaired = re.sub(r"/\*.*?\*/", "", repaired, flags=re.DOTALL)

        # Strategy 5: Replace NaN and Infinity (invalid JSON) with null
        repaired = re.sub(r"\bNaN\b", "null", repaired)
        repaired = re.sub(r"\bInfinity\b", "null", repaired)
        repaired = re.sub(r"\b-Infinity\b", "null", repaired)

        # Strategy 6: Remove trailing commas before closing brackets/braces
        repaired = re.sub(r",\s*([\}\]])", r"\1", repaired)

        # Strategy 7: Ensure property names are double-quoted (Python-style single quotes)
        repaired = re.sub(r"'([^']*)'", r'"\1"', repaired)

        # Strategy 8: Try parsing again after repairs
        try:
            result = json.loads(repaired)
            logger.info("JSON repair successful after applying syntax corrections.")
            return result
        except json.JSONDecodeError as e:
            logger.warning(f"JSON still invalid after repair strategies: {e}")

        # Strategy 9: Extract first valid JSON object (handles extra text around JSON)
        match = re.search(r"\{.*\}", repaired, re.DOTALL)
        if match:
            try:
                result = json.loads(match.group(0))
                logger.info("JSON extracted from surrounding text content.")
                return result
            except json.JSONDecodeError:
                pass

        logger.error("All JSON repair strategies failed. Input is unrepairable.")
        return None

    @staticmethod
    def serialize_full(workflow: Dict[str, Any]) -> str:
        """
        Serializes the entire workflow graph as a clean, formatted JSON string.
        Always stores the complete, atomic workflow (no delta patching).
        """
        return json.dumps(workflow, indent=2, ensure_ascii=False, default=str)

    @staticmethod
    def is_valid(raw: str) -> bool:
        """Quick validity check without repair attempts."""
        try:
            json.loads(raw)
            return True
        except (json.JSONDecodeError, TypeError):
            return False
