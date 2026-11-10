CREATE TABLE IF NOT EXISTS tracks (
 id TEXT NOT NULL PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
 artists_json TEXT NOT NULL DEFAULT '[]', album TEXT, album_artist TEXT,
 track_number INTEGER, disc_number INTEGER, year INTEGER,
 genres_json TEXT NOT NULL DEFAULT '[]', duration_ms INTEGER,
 audio_json TEXT NOT NULL DEFAULT '{}', file_size INTEGER NOT NULL DEFAULT 0 CHECK(file_size>=0),
 modified_at TEXT, signature TEXT, artwork_hash TEXT, lyrics_json TEXT,
 data_json TEXT NOT NULL, indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path);
CREATE TABLE IF NOT EXISTS folders (
 id TEXT NOT NULL PRIMARY KEY,path TEXT NOT NULL UNIQUE,name TEXT NOT NULL,
 parent_id TEXT,child_folder_ids_json TEXT NOT NULL DEFAULT '[]',
 track_ids_json TEXT NOT NULL DEFAULT '[]',direct_track_count INTEGER NOT NULL DEFAULT 0,
 recursive_track_count INTEGER NOT NULL DEFAULT 0,data_json TEXT NOT NULL,indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_folders_path ON folders(path);
CREATE TABLE IF NOT EXISTS catalog_state (
 key TEXT NOT NULL PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL
);
