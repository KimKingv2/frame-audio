"""Minimal read-only OpenList API client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

import httpx


class OpenListError(RuntimeError):
    """An OpenList API or transport error."""


@dataclass(frozen=True)
class RemoteEntry:
    name: str
    path: str
    is_dir: bool
    size: int
    modified: str | None
    hash_info: Any = None


class OpenListClient:
    def __init__(self, base_url: str, token: str, timeout_seconds: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.client = httpx.Client(
            timeout=timeout_seconds,
            follow_redirects=True,
            headers={
                "Authorization": token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> "OpenListClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _post(self, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = urljoin(self.base_url + "/", endpoint.lstrip("/"))
        try:
            response = self.client.post(url, json=payload)
            response.raise_for_status()
            data = response.json()
        except httpx.HTTPError as exc:
            raise OpenListError(f"OpenList 請求失敗（{type(exc).__name__}）。") from exc
        except ValueError as exc:
            raise OpenListError("OpenList 回應不是有效 JSON。") from exc

        if not isinstance(data, dict):
            raise OpenListError("OpenList 回應格式錯誤。")
        code = data.get("code")
        if code not in (None, 200):
            message = str(data.get("message", "未知 API 錯誤"))
            raise OpenListError(f"OpenList API {code}: {message}")
        result = data.get("data")
        if not isinstance(result, dict):
            raise OpenListError("OpenList 回應缺少 data 物件。")
        return result

    def list_directory(self, path: str, page: int = 1, per_page: int = 200) -> tuple[list[RemoteEntry], int]:
        payload = {
            "path": path,
            "password": "",
            "page": page,
            "per_page": per_page,
            "refresh": False,
        }
        data = self._post("/api/fs/list", payload)
        content = data.get("content")
        if not isinstance(content, list):
            raise OpenListError("目錄清單缺少 data.content。")

        entries: list[RemoteEntry] = []
        for item in content:
            if not isinstance(item, dict) or not item.get("name"):
                continue
            name = str(item["name"])
            full_path = (path.rstrip("/") + "/" + name) if path != "/" else "/" + name
            entries.append(
                RemoteEntry(
                    name=name,
                    path=full_path,
                    is_dir=bool(item.get("is_dir", False)),
                    size=max(0, int(item.get("size") or 0)),
                    modified=str(item.get("modified")) if item.get("modified") else None,
                    hash_info=item.get("hash_info") or item.get("hashinfo"),
                )
            )
        return entries, int(data.get("total") or len(entries))

    def get_file_info(self, path: str) -> dict[str, Any]:
        return self._post("/api/fs/get", {"path": path, "password": ""})

    @staticmethod
    def resolve_raw_url(base_url: str, raw_url: str) -> str:
        return urljoin(base_url.rstrip("/") + "/", raw_url)
