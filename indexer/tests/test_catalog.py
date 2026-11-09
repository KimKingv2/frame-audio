from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from frame_audio_indexer.indexer import MusicCatalog, _number, _raw_text


class MusicCatalogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.output = Path(self.temp_dir.name)
        self.catalog = MusicCatalog(self.output)

    def tearDown(self) -> None:
        self.catalog.close()
        self.temp_dir.cleanup()

    def test_incremental_signature_and_modified_time(self) -> None:
        self.catalog.save_track(
            "/Music/Artist/song.flac",
            1234,
            "2026-11-09T12:00:00Z",
            "hash-1",
            {"id": "track-1", "title": "Song", "artists": ["Artist"]},
        )
        self.assertTrue(
            self.catalog.unchanged(
                "/Music/Artist/song.flac",
                1234,
                "2026-11-09T12:00:00Z",
                "hash-1",
            )
        )
        self.assertFalse(
            self.catalog.unchanged(
                "/Music/Artist/song.flac",
                1235,
                "2026-11-09T12:00:00Z",
                "hash-1",
            )
        )

    def test_export_preserves_folder_hierarchy_and_counts(self) -> None:
        self.catalog.save_folder("/Music")
        self.catalog.save_folder("/Music/Artist")
        self.catalog.save_track(
            "/Music/Artist/song.flac",
            1234,
            "2026-11-09T12:00:00Z",
            None,
            {
                "id": "track-1",
                "title": "Song",
                "artists": ["Artist"],
                "album": None,
                "albumArtist": None,
                "trackNumber": None,
                "discNumber": None,
                "year": None,
                "genres": [],
                "durationMs": None,
                "audio": {},
                "file": {"path": "/Music/Artist/song.flac", "sizeBytes": 1234},
                "artwork": None,
                "lyrics": None,
            },
        )
        destination = self.catalog.export({"partial": True, "processed": 1})
        payload = json.loads(destination.read_text(encoding="utf-8"))
        self.assertEqual(payload["trackCount"], 1)
        folders = {item["path"]: item for item in payload["folders"]}
        self.assertEqual(folders["/Music/Artist"]["directTrackCount"], 1)
        self.assertEqual(folders["/Music"]["recursiveTrackCount"], 1)
        self.assertEqual(folders["/Music/Artist"]["parentId"], folders["/Music"]["id"])

    def test_tag_helpers(self) -> None:
        self.assertEqual(_number("03/12"), 3)
        self.assertEqual(_raw_text(["one", "two"]), "one, two")


if __name__ == "__main__":
    unittest.main()
