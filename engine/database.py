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
        self._init_db()

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

    def save_workflow(self, name: str, graph_json: Dict[str, Any], description: str = "") -> bool:
        """Saves or updates a workflow by name."""
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
        """Returns a list of all saved workflows."""
        workflows = []
        if self.connected:
            try:
                with psycopg2.connect(self.db_url) as conn:
                    with conn.cursor(cursor_factory=RealDictCursor) as cur:
                        cur.execute("SELECT name, description, updated_at FROM workflows ORDER BY updated_at DESC")
                        for row in cur.fetchall():
                            workflows.append({
                                "name": row["name"],
                                "description": row.get("description", ""),
                                "updated_at": str(row["updated_at"]),
                                "source": "aiven_cloud"
                            })
                return workflows
            except Exception as e:
                logger.error(f"Error listing workflows from database: {e}")

        # Local File Listing Fallback
        for fname in os.listdir(self.local_dir):
            if fname.endswith(".json"):
                name = fname[:-5]
                workflows.append({
                    "name": name,
                    "description": "Local workflow file",
                    "updated_at": datetime.fromtimestamp(os.path.getmtime(os.path.join(self.local_dir, fname))).isoformat(),
                    "source": "local_disk"
                })
        return workflows

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
