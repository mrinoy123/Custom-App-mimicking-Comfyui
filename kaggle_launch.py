"""
Kaggle One-Click Launcher with Automated Cloudflare Quick Tunnel
Automatically downloads the standalone cloudflared binary, boots the FastAPI server,
and prints the live public HTTPS link in your Kaggle notebook output.
"""

import os
import sys
import re
import time
import shutil
import subprocess
import urllib.request

PORT = 8000
SERVER_SCRIPT = "server.py"


def setup_cloudflared() -> str:
    """Ensures cloudflared binary is installed and executable."""
    cloudflared_path = shutil.which("cloudflared")
    if cloudflared_path:
        return cloudflared_path

    # Local fallback path
    local_bin = os.path.abspath("cloudflared")
    if os.path.exists(local_bin):
        return local_bin

    print("--> Downloading standalone Cloudflare Tunnel binary (cloudflared)...")
    url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    urllib.request.urlretrieve(url, local_bin)
    os.chmod(local_bin, 0o755)
    print("--> cloudflared downloaded successfully.")
    return local_bin


def main():
    print("=================================================================")
    print("🚀 Booting Custom ComfyUI Micro-Engine on Kaggle Cloud GPU...")
    print("=================================================================")

    # 1. Start FastAPI backend server in background
    env = os.environ.copy()
    env["PORT"] = str(PORT)
    env["HOST"] = "127.0.0.1"

    server_proc = subprocess.Popen(
        [sys.executable, SERVER_SCRIPT],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env
    )
    print(f"--> Engine server process started (PID: {server_proc.pid}) on port {PORT}...")
    time.sleep(2)

    # 2. Start Cloudflare Tunnel
    try:
        bin_path = setup_cloudflared()
    except Exception as e:
        print(f"Failed to setup cloudflared: {e}")
        print(f"Server is running locally at http://127.0.0.1:{PORT}")
        server_proc.wait()
        return

    print("--> Establishing secure Cloudflare Quick Tunnel...")
    tunnel_cmd = [bin_path, "tunnel", "--url", f"http://127.0.0.1:{PORT}"]
    tunnel_proc = subprocess.Popen(
        tunnel_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )

    tunnel_url = None
    url_pattern = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")

    # Read output to capture the public tunnel URL
    for line in tunnel_proc.stdout:
        match = url_pattern.search(line)
        if match:
            tunnel_url = match.group(0)
            break

    if tunnel_url:
        print("\n" + "=" * 65)
        print("🎉 YOUR 3-TAB COMFTUI WORKSPACE IS LIVE AND READY!")
        print(f"👉 CLICK HERE TO OPEN: {tunnel_url}")
        print("=" * 65)
        print("\nFeatures active:")
        print(" • Tab 1: Interactive Workflow Canvas")
        print(" • Tab 2: Workflow Ingestion, De-cluttering & Explainer")
        print(" • Tab 3: Community Node AST Converter")
        print(" • Real-time T4 VRAM telemetry & Cloudflare R2 media upload")
        print("\n(Keep this Kaggle cell running while you test in your browser)")
    else:
        print("Could not auto-detect public tunnel URL. Check tunnel logs.")

    try:
        tunnel_proc.wait()
    except KeyboardInterrupt:
        print("\nShutting down engine and closing tunnel...")
        tunnel_proc.terminate()
        server_proc.terminate()


if __name__ == "__main__":
    main()
