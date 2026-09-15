"""
Database Manager Subsystem
Handles persistence of workflow JSON graphs, prompt presets, and execution logs
using Aiven PostgreSQL with graceful local JSON file fallback.
"""

import os
import json
import logging
from typing import Dict, List, Any, Optional
from datetime import datetime

logger = logging.getLogger("engine.database")

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False


class DatabaseManager:
    """
    Unified database manager connecting to Aiven PostgreSQL cloud database
    or falling back to local filesystem JSON storage.
    """

    def __init__(self, db_url: Optional[str] = None, local_workflows_dir: str = "workflows"):
        self.db_url = db_url or os.getenv("DATABASE_URL")
        self.local_dir = local_workflows_dir
        os.makedirs(self.local_dir, exist_ok=True)
        self.connected = False
        self._metadata_file = os.path.join(self.local_dir, "_metadata.json")
        self._init_db()
        self._ensure_seed_workflows()

    def _init_db(self):
        if not PSYCOPG2_AVAILABLE or not self.db_url:
            logger.info("Operating in local JSON file mode (DATABASE_URL not set or psycopg2 missing).")
            return

        try:
            with psycopg2.connect(self.db_url) as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        CREATE TABLE IF NOT EXISTS workflows (
                            id SERIAL PRIMARY KEY,
                            name VARCHAR(255) UNIQUE NOT NULL,
                            description TEXT,
                            graph_json JSONB NOT NULL,
                            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                        );
                        CREATE TABLE IF NOT EXISTS execution_logs (
                            id SERIAL PRIMARY KEY,
                            workflow_name VARCHAR(255) NOT NULL,
                            status VARCHAR(50) NOT NULL,
                            duration_seconds FLOAT,
                            media_url TEXT,
                            prompt_used TEXT,
                            seed_used BIGINT,
                            error_message TEXT,
                            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                        );
                    """)
                conn.commit()
            self.connected = True
            logger.info("Connected to Aiven PostgreSQL database successfully.")
        except Exception as e:
            logger.error(f"Failed to connect to PostgreSQL: {e}. Falling back to local files.")
            self.connected = False

    def _load_metadata(self) -> Dict[str, Any]:
        if os.path.exists(self._metadata_file):
            try:
                with open(self._metadata_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                logger.error(f"Failed to read metadata file: {e}")
        return {}

    def _save_metadata(self, meta: Dict[str, Any]) -> None:
        try:
            with open(self._metadata_file, "w", encoding="utf-8") as f:
                json.dump(meta, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save metadata: {e}")

    def _ensure_seed_workflows(self):
        """Seeds reference workflows matching the Two-Tier Orchestration Studio UI."""
        meta = self._load_metadata()
        defaults = {
            "Parent-Workflow-AB": {
                "name": "Parent-Workflow-AB",
                "title": "Parent-Workflow-AB",
                "role": "master",
                "description": "Production Two-Tier master sequential orchestrator with memory barrier",
                "parent_id": None,
                "active": False,
                "selected": True,
                "updated_at": "Updated Sep 11, 08:04 PM"
            },
            "Subprocess-B": {
                "name": "Subprocess-B",
                "title": "Subprocess B (Scrape & Score)",
                "role": "subprocess",
                "description": "Scraping, screening, multi-tier AI scoring & Aiven vault collector subprocess",
                "parent_id": "Parent-Workflow-AB",
                "active": False,
                "selected": False,
                "updated_at": "Updated Sep 7, 03:35 PM"
            },
            "Workflow-C": {
                "name": "Workflow-C",
                "title": "Workflow-C",
                "role": "master",
                "description": "Independent Workflow C",
                "parent_id": None,
                "active": False,
                "selected": False,
                "updated_at": "Updated Sep 13, 04:41 PM"
            },
            "flux_txt2img": {
                "name": "flux_txt2img",
                "title": "Flux Text-to-Image",
                "role": "master",
                "description": "Direct FlowMatch latent diffusion pipeline",
                "parent_id": None,
                "active": False,
                "selected": False,
                "updated_at": "Updated Sep 14, 11:20 AM"
            },
            "ltx_video": {
                "name": "ltx_video",
                "title": "LTX-2.5 Video Generation",
                "role": "master",
                "description": "High-throughput 768x512 video diffusion pipeline",
                "parent_id": None,
                "active": False,
                "selected": False,
                "updated_at": "Updated Sep 15, 09:15 AM"
            }
        }

        # Seed metadata keys
        changed = False
        for k, v in defaults.items():
            if k not in meta:
                meta[k] = v
                changed = True

        if changed:
            self._save_metadata(meta)

        # Ensure json files exist
        flux_file = os.path.join(self.local_dir, "flux_txt2img.json")
        sample_graph = {}
        if os.path.exists(flux_file):
            try:
                with open(flux_file, "r", encoding="utf-8") as f:
                    sample_graph = json.load(f)
            except Exception:
                pass

        for name in ["Parent-Workflow-AB", "Subprocess-B", "Workflow-C"]:
            p = os.path.join(self.local_dir, f"{name}.json")
            if not os.path.exists(p):
                with open(p, "w", encoding="utf-8") as f:
                    json.dump(sample_graph, f, indent=2)

    def save_workflow(
        self,
        name: str,
        graph_json: Dict[str, Any],
        description: str = "",
        role: str = "master",
        parent_id: Optional[str] = None,
        active: bool = False,
        title: Optional[str] = None
    ) -> bool:
        """Saves or updates a workflow by name along with hierarchy metadata."""
        meta = self._load_metadata()
        now_str = datetime.now().strftime("Updated %b %d, %I:%M %p")
        meta[name] = {
            "name": name,
            "title": title or name,
            "description": description,
            "role": role,
            "parent_id": parent_id,
            "active": active,
            "selected": meta.get(name, {}).get("selected", False),
            "updated_at": now_str
        }
        self._save_metadata(meta)

        if self.connected:
            try:
                with psycopg2.connect(self.db_url) as conn:
                    with conn.cursor() as cur:
                        cur.execute("""
                            INSERT INTO workflows (name, description, graph_json, updated_at)
                            VALUES (%s, %s, %s, CURRENT_TIMESTAMP)
                            ON CONFLICT (name) DO UPDATE 
                            SET graph_json = EXCLUDED.graph_json,
                                description = EXCLUDED.description,
                                updated_at = CURRENT_TIMESTAMP;
                        """, (name, description, json.dumps(graph_json)))
                    conn.commit()
                logger.info(f"Saved workflow '{name}' to Aiven PostgreSQL.")
                return True
            except Exception as e:
                logger.error(f"Error saving workflow to database: {e}. Falling back to file.")

        # Local File Fallback
        file_path = os.path.join(self.local_dir, f"{name}.json")
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(graph_json, f, indent=2)
        logger.info(f"Saved workflow '{name}' to local file: {file_path}")
        return True

    def delete_workflow(self, name: str) -> bool:
        """Deletes a workflow and its metadata."""
        meta = self._load_metadata()
        if name in meta:
            del meta[name]
            # Also unlink or delete children
            for k, v in list(meta.items()):
                if v.get("parent_id") == name:
                    v["parent_id"] = None
            self._save_metadata(meta)

        file_path = os.path.join(self.local_dir, f"{name}.json")
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception as e:
                logger.error(f"Failed to delete file {file_path}: {e}")

        if self.connected:
            try:
                with psycopg2.connect(self.db_url) as conn:
                    with conn.cursor() as cur:
                        cur.execute("DELETE FROM workflows WHERE name = %s", (name,))
                    conn.commit()
            except Exception as e:
                logger.error(f"Failed to delete workflow from PostgreSQL: {e}")
        return True

    def toggle_workflow_active(self, name: str, active: bool) -> bool:
        """Toggles active/inactive status for a workflow."""
        meta = self._load_metadata()
        if name in meta:
            meta[name]["active"] = active
            self._save_metadata(meta)
            return True
        return False

    def get_workflow(self, name: str) -> Optional[Dict[str, Any]]:
        """Fetches a workflow by name."""
        if self.connected:
            try:
                with psycopg2.connect(self.db_url) as conn:
                    with conn.cursor(cursor_factory=RealDictCursor) as cur:
                        cur.execute("SELECT graph_json FROM workflows WHERE name = %s", (name,))
                        row = cur.fetchone()
                        if row:
                            return row["graph_json"]
            except Exception as e:
                logger.error(f"Error querying workflow from database: {e}")

        # Local File Fallback
        file_path = os.path.join(self.local_dir, f"{name}.json")
        if os.path.exists(file_path):
            with open(file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        return None

    def list_workflows(self) -> List[Dict[str, Any]]:
        """Returns a list of all saved workflows with hierarchy topology metadata."""
        meta = self._load_metadata()
        workflows = []
        names_seen = set()

        # Database rows if connected
        if self.connected:
            try:
                with psycopg2.connect(self.db_url) as conn:
                    with conn.cursor(cursor_factory=RealDictCursor) as cur:
                        cur.execute("SELECT name, description, updated_at FROM workflows ORDER BY updated_at DESC")
                        for row in cur.fetchall():
                            name = row["name"]
                            names_seen.add(name)
                            m = meta.get(name, {})
                            workflows.append({
                                "name": name,
                                "title": m.get("title", name),
                                "description": row.get("description") or m.get("description", ""),
                                "role": m.get("role", "master"),
                                "parent_id": m.get("parent_id"),
                                "active": m.get("active", False),
                                "selected": m.get("selected", False),
                                "updated_at": m.get("updated_at") or str(row["updated_at"]),
                                "source": "aiven_cloud"
                            })
            except Exception as e:
                logger.error(f"Error listing workflows from database: {e}")

        # Add from disk & metadata
        for fname in os.listdir(self.local_dir):
            if fname.endswith(".json") and not fname.startswith("_"):
                name = fname[:-5]
                if name not in names_seen:
                    names_seen.add(name)
                    m = meta.get(name, {})
                    file_mtime = datetime.fromtimestamp(os.path.getmtime(os.path.join(self.local_dir, fname))).strftime("Updated %b %d, %I:%M %p")
                    workflows.append({
                        "name": name,
                        "title": m.get("title", name),
                        "description": m.get("description", "Local workflow file"),
                        "role": m.get("role", "master"),
                        "parent_id": m.get("parent_id"),
                        "active": m.get("active", False),
                        "selected": m.get("selected", False),
                        "updated_at": m.get("updated_at", file_mtime),
                        "source": "local_disk"
                    })

        # Calculate subprocess counts for masters
        parent_sub_counts = {}
        for wf in workflows:
            pid = wf.get("parent_id")
            if pid:
                parent_sub_counts[pid] = parent_sub_counts.get(pid, 0) + 1

        for wf in workflows:
            wf["subprocess_count"] = parent_sub_counts.get(wf["name"], 0)

        # Build hierarchical ordering: Masters first, followed immediately by their subprocesses
        masters = [w for w in workflows if not w.get("parent_id")]
        ordered = []
        for m in masters:
            ordered.append(m)
            children = [w for w in workflows if w.get("parent_id") == m["name"]]
            ordered.extend(children)

        # Any orphaned subprocesses
        ordered_names = {w["name"] for w in ordered}
        for w in workflows:
            if w["name"] not in ordered_names:
                ordered.append(w)

        return ordered

    def log_execution(
        self,
        workflow_name: str,
        status: str,
        duration_seconds: float = 0.0,
        media_url: str = "",
        prompt_used: str = "",
        seed_used: Optional[int] = None,
        error_message: str = ""
    ):
        """
        Logs an execution run to Aiven database.
        Enforces Rolling 3-Run Retention: keeps only the 3 most recent runs
        per workflow to prevent unbounded log growth and maintain sub-5ms query latency.
        """
        if not self.connected:
            return
        try:
            with psycopg2.connect(self.db_url) as conn:
                with conn.cursor() as cur:
                    # Insert new log entry
                    cur.execute("""
                        INSERT INTO execution_logs
                            (workflow_name, status, duration_seconds, media_url, prompt_used, seed_used, error_message)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                    """, (workflow_name, status, duration_seconds, media_url, prompt_used, seed_used, error_message))

                    # Rolling 3-Run Retention: delete all but the 3 newest runs for this workflow
                    cur.execute("""
                        DELETE FROM execution_logs
                        WHERE workflow_name = %s
                          AND id NOT IN (
                              SELECT id FROM execution_logs
                              WHERE workflow_name = %s
                              ORDER BY created_at DESC
                              LIMIT 3
                          )
                    """, (workflow_name, workflow_name))

                conn.commit()
                logger.info(f"Logged execution for '{workflow_name}' (status={status}). Rolling 3-run retention enforced.")
        except Exception as e:
            logger.error(f"Failed to write execution log to database: {e}")

    def get_execution_history(self, workflow_name: str) -> list:
        """Returns the (up to 3) most recent execution runs for a given workflow."""
        if not self.connected:
            return []
        try:
            with psycopg2.connect(self.db_url) as conn:
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute("""
                        SELECT status, duration_seconds, media_url, prompt_used,
                               seed_used, error_message, created_at
                        FROM execution_logs
                        WHERE workflow_name = %s
                        ORDER BY created_at DESC
                        LIMIT 3
                    """, (workflow_name,))
                    return [dict(row) for row in cur.fetchall()]
        except Exception as e:
            logger.error(f"Failed to fetch execution history: {e}")
            return []

    def test_connection(self) -> Dict[str, Any]:
        """
        Tests connection to Aiven PostgreSQL and returns full diagnostic telemetry.
        """
        import time
        if not PSYCOPG2_AVAILABLE:
            return {
                "connected": False,
                "error": "psycopg2-binary not installed in Python environment.",
                "mode": "local_filesystem"
            }
        if not self.db_url:
            return {
                "connected": False,
                "error": "DATABASE_URL is not set.",
                "mode": "local_filesystem"
            }

        t0 = time.time()
        try:
            with psycopg2.connect(self.db_url, connect_timeout=5) as conn:
                latency_ms = round((time.time() - t0) * 1000, 2)
                with conn.cursor() as cur:
                    cur.execute("SELECT version();")
                    pg_version = cur.fetchone()[0]

                    cur.execute("SELECT count(*) FROM workflows;")
                    wf_count = cur.fetchone()[0]

                    cur.execute("SELECT count(*) FROM execution_logs;")
                    logs_count = cur.fetchone()[0]

                self.connected = True
                return {
                    "connected": True,
                    "mode": "aiven_postgresql",
                    "latency_ms": latency_ms,
                    "version": pg_version,
                    "tables": {
                        "workflows": wf_count,
                        "execution_logs": logs_count
                    }
                }
        except Exception as e:
            self.connected = False
            return {
                "connected": False,
                "error": str(e),
                "mode": "local_filesystem"
            }

    def reconnect(self, new_db_url: str) -> Dict[str, Any]:
        """Updates the connection URL and re-initializes database schemas dynamically."""
        self.db_url = new_db_url
        self._init_db()
        return self.test_connection()

    def sync_workflows(self) -> Dict[str, Any]:
        """
        Bidirectional sync:
        1. Uploads local disk JSON files into Aiven PostgreSQL.
        2. Exports any Aiven workflows down to the local workflows/ directory.
        """
        results = {"uploaded": 0, "downloaded": 0, "errors": []}

        # 1. Local to DB
        local_workflows = self._list_local_workflows()
        for wf in local_workflows:
            wf_name = wf["name"]
            local_data = self._get_local_workflow(wf_name)
            if local_data and self.connected:
                existing = self.get_workflow(wf_name)
                if not existing:
                    graph = local_data.get("graph_json", local_data)
                    self.save_workflow(wf_name, graph, "Synced from local disk")
                    results["uploaded"] += 1

        # 2. DB to Local
        if self.connected:
            try:
                db_workflows = self.list_workflows()
                for wf in db_workflows:
                    name = wf["name"]
                    local_path = os.path.join(self.local_dir, f"{name}.json")
                    if not os.path.exists(local_path):
                        full_wf = self.get_workflow(name)
                        if full_wf and "graph_json" in full_wf:
                            with open(local_path, "w", encoding="utf-8") as f:
                                json.dump(full_wf["graph_json"], f, indent=2)
                            results["downloaded"] += 1
            except Exception as e:
                results["errors"].append(str(e))

        return results

