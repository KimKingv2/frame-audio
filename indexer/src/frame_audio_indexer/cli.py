"""Command-line entry point. OpenList is always accessed read-only."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .config import get_token, load_config
from .indexer import scan_music
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

    scan_parser = commands.add_parser(
        "scan-music",
        help="建立 Music SQLite / JSON 索引；預設最多處理 20 首",
    )
    scan_parser.add_argument("--limit", type=int, default=20, help="本次最多處理幾首音訊，預設 20")
    scan_parser.add_argument(
        "--full",
        action="store_true",
        help="明確允許本次遞迴處理所有歌曲；仍受每檔 Range 上限保護",
    )
    scan_parser.add_argument(
        "--max-transfer-mib",
        type=int,
        default=16,
        help="每首歌曲最多透過 Range 讀取的資料量，預設 16 MiB",
    )
    return parser


def _print_scan_report(report: dict) -> None:
    print("FRAME Audio Music 索引完成")
    print(f"本次處理：{report['processed']} 首")
    print(f"未變更而略過：{report['skippedUnchanged']} 首")
    print(f"失敗：{report['failed']} 首")
    print(f"Range 請求：{report['rangeRequests']} 次")
    print(f"重新導向：{report['redirects']} 次")
    print(f"實際讀取：{report['bytesFetched']} bytes")
    print(f"索引是否完整：{'否（小批次或有錯誤）' if report['partial'] else '是'}")
    print(f"SQLite：{report['databasePath']}")
    print(f"JSON：{report['catalogPath']}")
    for item in report.get("errors", [])[:10]:
        if isinstance(item, dict):
            print(f"錯誤：{item.get('path', '未知')}：{item.get('error', '未知')}")
        else:
            print(f"警告：{item}")
    if len(report.get("errors", [])) > 10:
        print(f"其餘錯誤未列出：{len(report['errors']) - 10} 項")


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
                        entries, total = client.list_directory(
                            root, page=1, per_page=min(max(args.limit, 1), 100)
                        )
                        dirs = sum(1 for entry in entries if entry.is_dir)
                        files = len(entries) - dirs
                        print(
                            f"{category}: 目錄可讀取；目前頁面 {len(entries)} 項"
                            f"（{dirs} 個資料夾、{files} 個檔案），API 總數 {total}。"
                        )
                return 0

            if args.command == "probe-range":
                if not 1 <= args.bytes <= 65536:
                    raise ValueError("--bytes 必須介於 1 到 65536。")
                result = probe_file_range(client, args.path, args.bytes, config.timeout_seconds)
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0 if result.get("range_supported") else 3

            if args.command == "scan-music":
                if args.limit < 1:
                    raise ValueError("--limit 必須大於 0；如要完整掃描請使用 --full。")
                if not 1 <= args.max_transfer_mib <= 64:
                    raise ValueError("--max-transfer-mib 必須介於 1 到 64。")
                limit = None if args.full else args.limit
                report = scan_music(
                    client=client,
                    roots=config.music_roots,
                    output_dir=config.output_dir,
                    page_size=config.page_size,
                    timeout_seconds=config.timeout_seconds,
                    limit=limit,
                    max_transfer_bytes=args.max_transfer_mib * 1024 * 1024,
                )
                _print_scan_report(report)
                return 0 if report["failed"] == 0 else 3

        return 0
    except (FileNotFoundError, ValueError, EnvironmentError, OpenListError) as exc:
        print(f"FRAME Audio Indexer：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
