"""Probe one file's HTTP byte-range behaviour without downloading the file."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import httpx

from .openlist import OpenListClient, OpenListError


def _extra_headers(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    allowed = {"user-agent", "referer", "origin", "cookie"}
    return {
        str(key): str(item)
        for key, item in value.items()
        if str(key).lower() in allowed and item is not None
    }


def probe_file_range(
    client: OpenListClient,
    path: str,
    byte_count: int = 1024,
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    info = client.get_file_info(path)
    if info.get("is_dir"):
        raise OpenListError("指定路徑是資料夾，不是音訊檔案。")

    raw_url = info.get("raw_url")
    if not raw_url:
        raise OpenListError("OpenList /api/fs/get 沒有提供 raw_url。")

    size = int(info.get("size") or 0)
    if size <= 0:
        raise OpenListError("OpenList 回報檔案大小為 0，無法進行 Range 測試。")

    count = min(byte_count, size)
    target = client.resolve_raw_url(client.base_url, str(raw_url))
    headers = {"Range": f"bytes=0-{count - 1}", "Accept-Encoding": "identity"}
    headers.update(_extra_headers(info.get("header")))

    try:
        with httpx.Client(follow_redirects=True, timeout=timeout_seconds) as requester:
            with requester.stream("GET", target, headers=headers) as response:
                status = response.status_code
                content_range = response.headers.get("content-range")
                content_length = response.headers.get("content-length")
                if status == 206:
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) >= count:
                            break
                    return {
                        "path": path,
                        "file_size": size,
                        "status_code": status,
                        "range_supported": True,
                        "content_range": content_range,
                        "bytes_received": min(len(body), count),
                        "content_length": content_length,
                        "final_host": urlparse(str(response.url)).hostname,
                    }
                if status == 200:
                    return {
                        "path": path,
                        "file_size": size,
                        "status_code": status,
                        "range_supported": False,
                        "content_range": content_range,
                        "bytes_received": 0,
                        "content_length": content_length,
                        "final_host": urlparse(str(response.url)).hostname,
                        "warning": "伺服器忽略 Range。測試已停止，沒有讀取完整檔案。",
                    }
                return {
                    "path": path,
                    "file_size": size,
                    "status_code": status,
                    "range_supported": False,
                    "content_range": content_range,
                    "bytes_received": 0,
                    "final_host": urlparse(str(response.url)).hostname,
                    "warning": f"非預期 HTTP 狀態：{status}",
                }
    except httpx.HTTPError as exc:
        raise OpenListError(f"Range 測試請求失敗（{type(exc).__name__}）。") from exc
