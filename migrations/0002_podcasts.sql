CREATE TABLE IF NOT EXISTS podcast_shows (
 id TEXT NOT NULL PRIMARY KEY,
 folder_path TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL,
 author TEXT,
 description TEXT,
 cover_hash TEXT,
 data_json TEXT NOT NULL,
 indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_podcast_shows_title ON podcast_shows(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_podcast_shows_folder_path ON podcast_shows(folder_path);

CREATE TABLE IF NOT EXISTS podcast_episodes (
 id TEXT NOT NULL PRIMARY KEY,
 show_id TEXT NOT NULL,
 path TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL,
 description TEXT,
 episode_number INTEGER,
 season_number INTEGER,
 published_at TEXT,
 duration_ms INTEGER,
 audio_json TEXT NOT NULL DEFAULT '{}',
 file_size INTEGER NOT NULL DEFAULT 0 CHECK(file_size>=0),
 modified_at TEXT,
 artwork_hash TEXT,
 data_json TEXT NOT NULL,
 indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_show ON podcast_episodes(show_id);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_title ON podcast_episodes(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_published ON podcast_episodes(published_at);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_path ON podcast_episodes(path);
