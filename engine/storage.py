"""
Storage Manager Subsystem
Handles uploading generated PNG images and MP4 videos to Cloudflare R2 ($0 egress fees)
with graceful fallback to local disk storage.
"""

import os
import shutil
import logging
from typing import Optional

logger = logging.getLogger("engine.storage")

try:
    import boto3
    from botocore.config import Config
    BOTO3_AVAILABLE = True
except ImportError:
    BOTO3_AVAILABLE = False


class StorageManager:
    """
    Unified storage manager supporting Cloudflare R2 S3-compatible uploads
    and local filesystem fallback.
    """

    def __init__(
        self,
        account_id: Optional[str] = None,
        access_key_id: Optional[str] = None,
        secret_access_key: Optional[str] = None,
        bucket_name: Optional[str] = None,
        public_domain: Optional[str] = None,
        local_dir: str = "outputs"
    ):
        self.account_id = account_id or os.getenv("R2_ACCOUNT_ID")
        self.access_key_id = access_key_id or os.getenv("R2_ACCESS_KEY_ID")
        self.secret_access_key = secret_access_key or os.getenv("R2_SECRET_ACCESS_KEY")
        self.bucket_name = bucket_name or os.getenv("R2_BUCKET_NAME", "comfy-media")
        self.public_domain = (public_domain or os.getenv("R2_PUBLIC_DOMAIN", "")).rstrip("/")
        self.local_dir = local_dir or os.getenv("LOCAL_OUTPUT_DIR", "outputs")

        os.makedirs(self.local_dir, exist_ok=True)
        self.s3_client = None
        self._init_r2_client()

    def _init_r2_client(self):
        if not BOTO3_AVAILABLE:
            logger.warning("boto3 not installed. Cloudflare R2 uploads disabled. Using local storage.")
            return

        if self.account_id and self.access_key_id and self.secret_access_key:
            try:
                endpoint_url = f"https://{self.account_id}.r2.cloudflarestorage.com"
                self.s3_client = boto3.client(
                    "s3",
                    endpoint_url=endpoint_url,
                    aws_access_key_id=self.access_key_id,
                    aws_secret_access_key=self.secret_access_key,
                    config=Config(signature_version="s3v4")
                )
                logger.info(f"Connected to Cloudflare R2 bucket: {self.bucket_name}")
            except Exception as e:
                logger.error(f"Failed to initialize Cloudflare R2 client: {e}. Falling back to local storage.")
                self.s3_client = None
        else:
            logger.info("Cloudflare R2 credentials not set. Operating in local storage mode.")

    def save_media(self, source_path: str, filename: Optional[str] = None) -> str:
        """
        Saves a generated image or video. Uploads to Cloudflare R2 if configured;
        otherwise copies to the local output directory. Returns the public URL or relative path.
        """
        if not os.path.exists(source_path):
            raise FileNotFoundError(f"Source media file not found: {source_path}")

        file_basename = filename or os.path.basename(source_path)

        # 1. Attempt Cloudflare R2 Upload
        if self.s3_client:
            try:
                content_type = "video/mp4" if file_basename.endswith(".mp4") else "image/png"
                self.s3_client.upload_file(
                    source_path,
                    self.bucket_name,
                    file_basename,
                    ExtraArgs={"ContentType": content_type}
                )
                if self.public_domain:
                    media_url = f"{self.public_domain}/{file_basename}"
                else:
                    media_url = f"https://{self.bucket_name}.r2.cloudflarestorage.com/{file_basename}"
                logger.info(f"Uploaded to Cloudflare R2: {media_url}")
                return media_url
            except Exception as e:
                logger.error(f"Error uploading to Cloudflare R2: {e}. Defaulting to local storage.")

        # 2. Local Fallback
        dest_path = os.path.join(self.local_dir, file_basename)
        if os.path.abspath(source_path) != os.path.abspath(dest_path):
            shutil.copy2(source_path, dest_path)
        logger.info(f"Saved media locally to: {dest_path}")
        return dest_path
