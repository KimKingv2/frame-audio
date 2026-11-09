"""Read private TOML settings without exposing credentials."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


@dataclass(frozen=True)
class AppConfig:
    base_url: str
    token_env: str
    music_roots: tuple[str, ...]
    podcast_roots: tuple[str, ...]
    page_size: int
    timeout_seconds: float
    probe_bytes: int
    output_dir: Path


def load_config(path: Path) -> AppConfig:
    if not path.is_file():
        raise FileNotFoundError(
            f"找不到設定檔：{path}。請先複製 indexer/config.example.toml "
            "為 config/local.toml，並填入私人目錄路徑。"
        )

    with path.open("rb") as handle:
        raw = tomllib.load(handle)

    openlist = raw.get("openlist", {})
    library = raw.get("library", {})
    scan = raw.get("scan", {})
    output = raw.get("output", {})

    base_url = str(openlist.get("base_url", "")).strip().rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError("openlist.base_url 必須是有效的 HTTPS 網址。")

    token_env = str(openlist.get("token_env", "FRAME_AUDIO_OPENLIST_TOKEN")).strip()
    music_roots = tuple(str(v).strip() for v in library.get("music_roots", []) if str(v).strip())
    podcast_roots = tuple(str(v).strip() for v in library.get("podcast_roots", []) if str(v).strip())
    if not music_roots:
        raise ValueError("library.music_roots 至少需要設定一個目錄。")
    if not podcast_roots:
        raise ValueError("library.podcast_roots 至少需要設定一個目錄。")

    for root in (*music_roots, *podcast_roots):
        if not root.startswith("/") or "\\x00" in root:
            raise ValueError(f"OpenList 目錄必須是以 / 開頭的絕對路徑：{root!r}")

    page_size = int(scan.get("page_size", 200))
    timeout_seconds = float(scan.get("request_timeout_seconds", 30))
    probe_bytes = int(scan.get("range_probe_bytes", 1024))
    if not 1 <= page_size <= 1000:
        raise ValueError("scan.page_size 必須介於 1 到 1000。")
    if not 1 <= probe_bytes <= 65536:
        raise ValueError("scan.range_probe_bytes 必須介於 1 到 65536。")

    return AppConfig(
        base_url=base_url,
        token_env=token_env,
        music_roots=music_roots,
        podcast_roots=podcast_roots,
        page_size=page_size,
        timeout_seconds=timeout_seconds,
        probe_bytes=probe_bytes,
        output_dir=Path(str(output.get("directory", "./private-export"))).expanduser(),
    )


def get_token(config: AppConfig) -> str:
    token = os.environ.get(config.token_env, "").strip()
    if not token:
        raise EnvironmentError(
            f"找不到環境變數 {config.token_env}。請將 OpenList Token 設為環境變數；"
            "不要把 Token 寫進 TOML、GitHub 或命令列參數。"
        )
    return token
