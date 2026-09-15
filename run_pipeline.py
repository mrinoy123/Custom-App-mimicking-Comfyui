"""
Pure Headless CLI Pipeline Runner
Executes workflows directly from the terminal or a Kaggle notebook cell without launching any UI.
Supports loading from Aiven Cloud Database (--workflow-db) or local file (--workflow).
"""

import os
import sys
import json
import argparse
import logging
from engine.runner import PipelineRunner
from engine.database import DatabaseManager
from engine.storage import StorageManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("run_pipeline")


def main():
    parser = argparse.ArgumentParser(description="Headless Custom ComfyUI Pipeline Runner")
    parser.add_argument("--workflow", type=str, help="Path to local workflow JSON file (e.g., workflows/flux_txt2img.json)")
    parser.add_argument("--workflow-db", type=str, help="Name of workflow to fetch directly from Aiven Cloud Database")
    parser.add_argument("--prompt", type=str, help="Optional text prompt override")
    parser.add_argument("--seed", type=int, help="Optional seed override")
    parser.add_argument("--output-dir", type=str, default="outputs", help="Directory to save generated media")

    args = parser.parse_args()

    if not args.workflow and not args.workflow_db:
        logger.error("Error: You must specify either --workflow <file.json> or --workflow-db <workflow_name>.")
        sys.exit(1)

    db_mgr = DatabaseManager()
    storage_mgr = StorageManager(local_dir=args.output_dir)

    workflow_json = None
    wf_name = "cli_run"

    # 1. Fetch Workflow
    if args.workflow_db:
        logger.info(f"Fetching workflow '{args.workflow_db}' from Aiven database...")
        workflow_json = db_mgr.get_workflow(args.workflow_db)
        if not workflow_json:
            logger.error(f"Workflow '{args.workflow_db}' not found in Aiven database or local files.")
            sys.exit(1)
        wf_name = args.workflow_db
    elif args.workflow:
        if not os.path.exists(args.workflow):
            logger.error(f"Workflow file not found: {args.workflow}")
            sys.exit(1)
        logger.info(f"Loading local workflow file: {args.workflow}")
        with open(args.workflow, "r", encoding="utf-8") as f:
            workflow_json = json.load(f)
        wf_name = os.path.splitext(os.path.basename(args.workflow))[0]

    # 2. Prepare Overrides
    overrides = {}
    if args.prompt:
        overrides["positive_prompt"] = args.prompt
    if args.seed is not None:
        overrides["seed"] = args.seed

    # 3. Execute Pipeline
    def console_progress(event):
        ev = event.get("event")
        if ev == "node_started":
            print(f"--> [{event.get('step')}/{event.get('total_steps')}] Executing: {event.get('class_type')} (Node {event.get('node_id')})")
        elif ev == "completed":
            print(f"==> Execution Succeeded in {event.get('duration_seconds')}s!")

    runner = PipelineRunner(
        storage_mgr=storage_mgr,
        db_mgr=db_mgr,
        progress_callback=console_progress
    )

    try:
        results = runner.execute(workflow_json, workflow_name=wf_name, overrides=overrides)
        print("\n=======================================================")
        print(f"🎉 Run Complete! Duration: {results.get('duration_seconds')}s")
        for f in results.get("saved_files", []):
            print(f"📁 Media Artifact: {f}")
        print("=======================================================\n")
    except Exception as e:
        logger.error(f"Pipeline execution terminated with error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
