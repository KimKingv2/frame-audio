"""Bounded, read-only Music indexer for OpenList."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import sqlite3
import time
from collections import OrderedDict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from mutagen import File as MutagenFile

from .openlist import OpenListClient, OpenListError

AUDIO_EXTENSIONS = {
    ".flac", ".mp3", ".m4a", ".mp4", ".aac", ".wav", ".wave",
    ".aiff", ".aif", ".ogg", ".opus", ".wma", ".ape", ".dsf", ".dff",
}
CHUNK_SIZE = 64 * 1024
MAX_DIRECTORY_COUNT = 100_000
ALLOWED_SOURCE_HEADERS = {"user-agent", "referer", "origin", "cookie"}


class RangeReadError(OpenListError):
    """A bounded HTTP Range read failed."""


class RangeNotSupportedError(RangeReadError):
    """The source ignored the Range header; the response body was not read."""


class RangeLimitError(RangeReadError):
    """The per-file metadata transfer budget was reached."""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _safe_source_headers(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {
        str(key): str(item)
        for key, item in value.items()
        if str(key).lower() in ALLOWED_SOURCE_HEADERS and item is not None
    }


class RangeReader:
    """Seekable file-like object backed by bounded, 64 KiB HTTP Range requests."""

    def __init__(
        self,
        url: str,
        size: int,
        headers: dict[str, str] | None,
        timeout_seconds: float,
        max_transfer_bytes: int,
        filename: str,
    ) -> None:
        if size <= 0:
            raise RangeReadError("OpenList 回報的檔案大小無效。")
        self.url = url
        self.size = size
        self.name = filename
        self.position = 0
        self.max_transfer_bytes = max_transfer_bytes
        self.bytes_fetched = 0
        self.range_requests = 0
        self.redirect_count = 0
        self.initial_host = urlparse(url).hostname or "unknown"
        self.final_host = self.initial_host
        self.cache: OrderedDict[int, bytes] = OrderedDict()
        self.closed = False
        request_headers = {"Accept-Encoding": "identity"}
        request_headers.update(_safe_source_headers(headers))
        self.client = httpx.Client(
            follow_redirects=True,
            timeout=timeout_seconds,
            headers=request_headers,
        )

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.position

    def seek(self, offset: int, whence: int = 0) -> int:
        if whence == 0:
            target = offset
        elif whence == 1:
            target = self.position + offset
        elif whence == 2:
            target = self.size + offset
        else:
            raise ValueError("Invalid seek mode.")
        if target < 0:
            raise ValueError("Negative seek position.")
        self.position = target
        return target

    def _chunk(self, start: int) -> bytes:
        if self.closed:
            raise RangeReadError("RangeReader 已關閉。")
        if start in self.cache:
            self.cache.move_to_end(start)
            return self.cache[start]

        expected = min(CHUNK_SIZE, self.size - start)
        if expected <= 0:
            return b""
        if self.bytes_fetched + expected > self.max_transfer_bytes:
            raise RangeLimitError(
                f"單檔標籤讀取已達上限 {self.max_transfer_bytes} bytes，已停止讀取。"
            )

        end = start + expected - 1
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                with self.client.stream(
                    "GET",
                    self.url,
                    headers={"Range": f"bytes={start}-{end}"},
                ) as response:
                    self.redirect_count += len(response.history)
                    self.final_host = urlparse(str(response.url)).hostname or self.final_host

                    if response.status_code == 200:
                        raise RangeNotSupportedError(
                            "音訊來源忽略 Range（HTTP 200）。已取消回應，沒有讀取完整檔案。"
                        )
                    if response.status_code != 206:
                        if response.status_code in {408, 425, 429, 500, 502, 503, 504} and attempt < 2:
                            time.sleep(0.5 * (attempt + 1))
                            continue
                        raise RangeReadError(
                            f"音訊 Range 請求失敗（HTTP {response.status_code}）。"
                        )

                    content_range = response.headers.get("content-range", "")
                    match = re.match(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", content_range, re.I)
                    if not match or int(match.group(1)) != start:
                        raise RangeReadError(
                            f"Range 回應 Content-Range 不符：{content_range or '未提供'}。"
                        )
                    data = response.read()
                    if len(data) != expected:
                        if len(data) < expected and attempt < 2:
                            time.sleep(0.5 * (attempt + 1))
                            continue
                        raise RangeReadError(
                            f"Range 回應長度不符：預期 {expected}，實際 {len(data)} bytes。"
                        )

                self.bytes_fetched += len(data)
                self.range_requests += 1
                self.cache[start] = data
                self.cache.move_to_end(start)
                while len(self.cache) > 4:
                    self.cache.popitem(last=False)
                return data
            except RangeNotSupportedError:
                raise
            except (httpx.HTTPError, RangeReadError) as exc:
                last_error = exc
                if isinstance(exc, RangeReadError) and not any(
                    marker in str(exc) for marker in ("HTTP 408", "HTTP 425", "HTTP 429", "HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504", "長度不符")
                ):
                    raise
                if attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
        raise RangeReadError(f"Range 請求失敗：{type(last_error).__name__ if last_error else '未知錯誤'}。") from last_error

    def read(self, size: int = -1) -> bytes:
        if self.closed:
            raise ValueError("I/O operation on closed file.")
        if size is None or size < 0:
            size = max(0, self.size - self.position)
        else:
            size = min(size, max(0, self.size - self.position))

        output = bytearray()
        while len(output) < size:
            absolute = self.position
            chunk_start = (absolute // CHUNK_SIZE) * CHUNK_SIZE
            chunk = self._chunk(chunk_start)
            offset = absolute - chunk_start
            take = min(size - len(output), len(chunk) - offset)
            if take <= 0:
                break
            output.extend(chunk[offset:offset + take])
            self.position += take
        return bytes(output)

    def readinto(self, buffer: Any) -> int:
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self.client.close()
            self.cache.clear()


def _raw_text(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "text"):
        value = value.text
    if isinstance(value, (list, tuple)):
        if len(value) == 2 and all(isinstance(part, int) for part in value):
            return f"{value[0]}/{value[1]}" if value[1] else str(value[0])
        return ", ".join(part for part in (_raw_text(item) for item in value) if part)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").strip()
    return str(value).strip()


def _tag(tags: Any, *keys: str) -> str:
    if tags is None:
        return ""
    for key in keys:
        try:
            value = tags.get(key)
        except (AttributeError, TypeError):
            value = None
        text = _raw_text(value)
        if text:
            return text
    return ""


def _number(value: str) -> int | None:
    match = re.search(r"\d+", value or "")
    return int(match.group()) if match else None


def _image_mime(data: bytes, declared: str | None = None) -> str:
    if declared and declared.startswith("image/"):
        return declared
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    return "application/octet-stream"


def _extract_picture(audio: Any) -> tuple[bytes, str] | None:
    candidates: list[tuple[bytes, str | None]] = []
    pictures = getattr(audio, "pictures", None)
    if pictures:
        for picture in pictures:
            data = getattr(picture, "data", None)
            if data:
                candidates.append((bytes(data), getattr(picture, "mime", None)))
    tags = getattr(audio, "tags", None)
    if tags is not None:
        getall = getattr(tags, "getall", None)
        if callable(getall):
            try:
                for frame in getall("APIC"):
                    data = getattr(frame, "data", None)
                    if data:
                        candidates.append((bytes(data), getattr(frame, "mime", None)))
            except (KeyError, TypeError):
                pass
        try:
            covers = tags.get("covr", [])
        except AttributeError:
            covers = []
        if not isinstance(covers, (list, tuple)):
            covers = [covers]
        for cover in covers:
            if isinstance(cover, (bytes, bytearray)):
                data = bytes(cover)
                image_format = getattr(cover, "imageformat", None)
                declared = "image/jpeg" if str(image_format).lower().endswith("jpeg") else None
                candidates.append((data, declared))
    for data, declared in candidates:
        if data:
            return data, _image_mime(data, declared)
    return None


def _extract_lyrics(tags: Any) -> str:
    if tags is None:
        return ""
    getall = getattr(tags, "getall", None)
    if callable(getall):
        try:
            for frame in getall("USLT"):
                text = _raw_text(getattr(frame, "text", ""))
                if text:
                    return text
        except (KeyError, TypeError):
            pass
    return _tag(tags, "lyrics", "LYRICS", "unsyncedlyrics", "©lyr", "WM/Lyrics")


def extract_metadata(reader: RangeReader, path: str) -> tuple[dict[str, Any], tuple[bytes, str] | None]:
    audio = MutagenFile(reader, easy=False)
    if audio is None:
        raise OpenListError("Mutagen 無法辨識此音訊格式或標籤。")

    tags = getattr(audio, "tags", None)
    title = _tag(tags, "title", "TIT2", "©nam") or Path(path).stem
    artist = _tag(tags, "artist", "TPE1", "©ART")
    album = _tag(tags, "album", "TALB", "©alb")
    album_artist = _tag(tags, "albumartist", "album artist", "TPE2", "aART")
    date = _tag(tags, "date", "year", "TDRC", "TYER", "©day")
    track = _tag(tags, "tracknumber", "track", "TRCK", "trkn")
    disc = _tag(tags, "discnumber", "disc", "TPOS", "disk")
    genre = _tag(tags, "genre", "TCON", "©gen")
    composer = _tag(tags, "composer", "TCOM", "©wrt")
    lyrics_text = _extract_lyrics(tags)

    info = getattr(audio, "info", None)
    duration = getattr(info, "length", None)
    mime_values = getattr(audio, "mime", None) or []
    codec = mime_values[0] if mime_values else type(audio).__name__
    audio_info = {
        "container": type(audio).__name__,
        "codec": codec,
        "bitrate": getattr(info, "bitrate", None),
        "sampleRate": getattr(info, "sample_rate", None),
        "bitsPerSample": getattr(info, "bits_per_sample", None),
        "channels": getattr(info, "channels", None),
        "lossless": getattr(info, "lossless", None),
        "durationMs": round(duration * 1000) if isinstance(duration, (int, float)) else None,
    }
    metadata = {
        "id": hashlib.sha256(path.encode("utf-8")).hexdigest()[:24],
        "title": title,
        "artists": [artist] if artist else [],
        "album": album or None,
        "albumArtist": album_artist or None,
        "trackNumber": _number(track),
        "discNumber": _number(disc),
        "year": _number(date),
        "genres": [genre] if genre else [],
        "durationMs": audio_info["durationMs"],
        "audio": audio_info,
        "lyrics": {"text": lyrics_text, "source": "embedded"} if lyrics_text else None,
        "artwork": None,
    }
    return metadata, _extract_picture(audio)


def _signature(value: Any) -> str | None:
    if value in (None, "", {}):
        return None
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


def _stable_id(path: str) -> str:
    return hashlib.sha256(path.encode("utf-8")).hexdigest()[:24]


class MusicCatalog:
    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        (self.output_dir / "assets").mkdir(parents=True, exist_ok=True)
        self.db_path = self.output_dir / "frame-audio.sqlite3"
        self.db = sqlite3.connect(self.db_path)
        self.db.row_factory = sqlite3.Row
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS tracks (
                path TEXT PRIMARY KEY,
                size INTEGER NOT NULL,
                modified TEXT,
                signature TEXT,
                metadata_json TEXT NOT NULL,
                indexed_at TEXT NOT NULL
            )"""
        )
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS folders (
                path TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_path TEXT
            )"""
        )
        self.db.commit()

    def unchanged(self, path: str, size: int, modified: str | None, signature: str | None) -> bool:
        row = self.db.execute(
            "SELECT size, modified, signature FROM tracks WHERE path = ?", (path,)
        ).fetchone()
        if row is None or (modified is None and signature is None):
            return False
        return row["size"] == size and row["modified"] == modified and row["signature"] == signature

    def save_folder(self, path: str) -> None:
        normalized = path.rstrip("/") or "/"
        name = normalized.rsplit("/", 1)[-1] or "/"
        parent = normalized.rsplit("/", 1)[0] or None
        self.db.execute(
            "INSERT INTO folders(path, name, parent_path) VALUES(?, ?, ?) "
            "ON CONFLICT(path) DO UPDATE SET name=excluded.name, parent_path=excluded.parent_path",
            (normalized, name, parent),
        )

    def save_track(self, path: str, size: int, modified: str | None,
                   signature: str | None, metadata: dict[str, Any]) -> None:
        self.db.execute(
            """INSERT INTO tracks(path, size, modified, signature, metadata_json, indexed_at)
               VALUES(?, ?, ?, ?, ?, ?)
               ON CONFLICT(path) DO UPDATE SET size=excluded.size, modified=excluded.modified,
               signature=excluded.signature, metadata_json=excluded.metadata_json,
               indexed_at=excluded.indexed_at""",
            (path, size, modified, signature,
             json.dumps(metadata, ensure_ascii=False, separators=(",", ":")), _utc_now()),
        )
        self.db.commit()

    def save_artwork(self, metadata: dict[str, Any], picture: tuple[bytes, str] | None) -> None:
        if not picture:
            return
        data, mime = picture
        digest = hashlib.sha256(data).hexdigest()
        extension = mimetypes.guess_extension(mime) or ".bin"
        if extension == ".jpe":
            extension = ".jpg"
        relative = f"assets/{digest}{extension}"
        target = self.output_dir / relative
        if not target.exists():
            target.write_bytes(data)
        metadata["artwork"] = {"sha256": digest, "path": relative, "mime": mime}

    def export(self, report: dict[str, Any]) -> Path:
        tracks = [
            json.loads(row["metadata_json"])
            for row in self.db.execute("SELECT metadata_json FROM tracks ORDER BY path")
        ]
        track_rows = self.db.execute("SELECT path, metadata_json FROM tracks").fetchall()
        direct: dict[str, list[str]] = {}
        for row in track_rows:
            parent = row["path"].rsplit("/", 1)[0] or "/"
            track = json.loads(row["metadata_json"])
            direct.setdefault(parent, []).append(track["id"])

        folders = {
            row["path"]: {
                "id": _stable_id(row["path"]),
                "name": row["name"],
                "path": row["path"],
                "parentPath": row["parent_path"],
                "childFolderIds": [],
                "trackIds": sorted(direct.get(row["path"], [])),
                "directTrackCount": len(direct.get(row["path"], [])),
                "recursiveTrackCount": 0,
            }
            for row in self.db.execute("SELECT path, name, parent_path FROM folders")
        }
        for folder in folders.values():
            parent_path = folder.pop("parentPath")
            folder["parentId"] = folders[parent_path]["id"] if parent_path in folders else None
            if parent_path in folders:
                folders[parent_path]["childFolderIds"].append(folder["id"])

        def count_recursive(path: str, seen: set[str]) -> int:
            if path in seen:
                return 0
            seen.add(path)
            node = next((item for item in folders.values() if item["path"] == path), None)
            if node is None:
                return 0
            total = node["directTrackCount"]
            for child_id in node["childFolderIds"]:
                child = next((item for item in folders.values() if item["id"] == child_id), None)
                if child:
                    total += count_recursive(child["path"], seen)
            node["recursiveTrackCount"] = total
            return total

        roots = [path for path, item in folders.items() if item["parentId"] is None]
        for root in roots:
            count_recursive(root, set())

        output = {
            "schemaVersion": 1,
            "generatedAt": _utc_now(),
            "partial": bool(report.get("partial", True)),
            "scan": report,
            "trackCount": len(tracks),
            "tracks": tracks,
            "folders": sorted(folders.values(), key=lambda item: item["path"]),
        }
        destination = self.output_dir / "music-catalog.json"
        destination.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
        self.db.commit()
        return destination

    def close(self) -> None:
        self.db.close()


def scan_music(
    client: OpenListClient,
    roots: tuple[str, ...],
    output_dir: Path,
    page_size: int,
    timeout_seconds: float,
    limit: int | None = 20,
    max_transfer_bytes: int = 16 * 1024 * 1024,
) -> dict[str, Any]:
    """Index a bounded sample by default. Source files are never written or downloaded in full."""
    catalog = MusicCatalog(output_dir)
    started = _utc_now()
    report: dict[str, Any] = {
        "startedAt": started,
        "partial": limit is not None,
        "limit": limit,
        "processed": 0,
        "skippedUnchanged": 0,
        "failed": 0,
        "rangeRequests": 0,
        "redirects": 0,
        "bytesFetched": 0,
        "errors": [],
    }
    visited_dirs: set[str] = set()
    try:
        queue = deque(roots)
        for root in roots:
            catalog.save_folder(root)

        while queue:
            if len(visited_dirs) >= MAX_DIRECTORY_COUNT:
                report["partial"] = True
                report["errors"].append("已達目錄數安全上限，停止繼續遞迴。")
                break
            directory = queue.popleft().rstrip("/") or "/"
            if directory in visited_dirs:
                continue
            visited_dirs.add(directory)

            page = 1
            while True:
                entries, total = client.list_directory(directory, page=page, per_page=page_size)
                for entry in entries:
                    if entry.is_dir:
                        catalog.save_folder(entry.path)
                        queue.append(entry.path)
                        continue
                    if Path(entry.name).suffix.lower() not in AUDIO_EXTENSIONS:
                        continue
                    if limit is not None and report["processed"] >= limit:
                        report["partial"] = True
                        return _finish_report(catalog, report)

                    signature = _signature(entry.hash_info)
                    if catalog.unchanged(entry.path, entry.size, entry.modified, signature):
                        report["skippedUnchanged"] += 1
                        report["processed"] += 1
                        continue

                    try:
                        info = client.get_file_info(entry.path)
                        size = int(info.get("size") or entry.size or 0)
                        if size <= 0:
                            raise OpenListError("OpenList 沒有提供有效檔案大小。")
                        raw_url = info.get("raw_url")
                        if not raw_url:
                            raise OpenListError("OpenList /api/fs/get 沒有提供 raw_url。")
                        url = client.resolve_raw_url(client.base_url, str(raw_url))
                        reader = RangeReader(
                            url=url,
                            size=size,
                            headers=info.get("header"),
                            timeout_seconds=timeout_seconds,
                            max_transfer_bytes=max_transfer_bytes,
                            filename=entry.name,
                        )
                        try:
                            metadata, picture = extract_metadata(reader, entry.path)
                            stats = {
                                "rangeRequests": reader.range_requests,
                                "redirects": reader.redirect_count,
                                "bytesFetched": reader.bytes_fetched,
                                "initialHost": reader.initial_host,
                                "finalHost": reader.final_host,
                            }
                        finally:
                            reader.close()

                        metadata["file"] = {
                            "path": entry.path,
                            "sizeBytes": size,
                            "modifiedAt": entry.modified,
                            "signature": signature,
                        }
                        catalog.save_artwork(metadata, picture)
                        catalog.save_track(entry.path, size, entry.modified, signature, metadata)
                        report["rangeRequests"] += stats["rangeRequests"]
                        report["redirects"] += stats["redirects"]
                        report["bytesFetched"] += stats["bytesFetched"]
                    except Exception as exc:
                        report["failed"] += 1
                        report["errors"].append({
                            "path": entry.path,
                            "error": f"{type(exc).__name__}: {exc}",
                        })
                    report["processed"] += 1

                if page * page_size >= total or not entries:
                    break
                page += 1

        if report["failed"]:
            report["partial"] = True
        return _finish_report(catalog, report)
    finally:
        catalog.close()


def _finish_report(catalog: MusicCatalog, report: dict[str, Any]) -> dict[str, Any]:
    report["finishedAt"] = _utc_now()
    report["catalogPath"] = str(catalog.output_dir / "music-catalog.json")
    report["databasePath"] = str(catalog.db_path)
    catalog.export(report)
    return report
