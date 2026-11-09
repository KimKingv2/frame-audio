"""Command-line entry point. This first milestone is read-only."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .config import get_token, load_config
from .openlist import OpenListClient, OpenListError
from .range_probe import probe_file_range


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="frame-audio-indexer")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument("--config", type=Path, default=Path("config/local.toml"))
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check-config", help="檢查私人設定與 Token 環境變數")
    list_parser = commands.add_parser("list-roots", help="唯讀檢查 Music / Podcasts 根目錄")
    list_parser.add_argument("--limit", type=int, default=10)
    probe_parser = commands.add_parser("probe-range", help="對單一音訊檔案執行小型 Range 測試")
    probe_parser.add_argument("--path", required=True, help="OpenList 音訊檔案完整路徑")
    probe_parser.add_argument("--bytes", type=int, default=1024)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        config = load_config(args.config)
        token = get_token(config)

        if args.command == "check-config":
            print("設定檔與 Token 環境變數正常。")
            print(f"Music 根目錄數量：{len(config.music_roots)}")
            print(f"Podcasts 根目錄數量：{len(config.podcast_roots)}")
            print("沒有列出私人路徑或 Token。")
            return 0

        with OpenListClient(config.base_url, token, config.timeout_seconds) as client:
            if args.command == "list-roots":
                for category, roots in (("Music", config.music_roots), ("Podcasts", config.podcast_roots)):
                    for root in roots:
                        entries, total = client.list_directory(root, page=1, per_page=min(max(args.limit, 1), 100))
                        dirs = sum(1 for entry in entries if entry.is_dir)
                        files = len(entries) - dirs
                        print(f"{category}: 目錄可讀取；目前頁面 {len(entries)} 項（{dirs} 個資料夾、{files} 個檔案），API 總數 {total}。")
                return 0

            if args.command == "probe-range":
                if not 1 <= args.bytes <= 65536:
                    raise ValueError("--bytes 必須介於 1 到 65536。")
                result = probe_file_range(client, args.path, args.bytes, config.timeout_seconds)
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0 if result.get("range_supported") else 3

        return 0
    except (FileNotFoundError, ValueError, EnvironmentError, OpenListError) as exc:
        print(f"FRAME Audio Indexer：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
