-- Precomputed catalogue counters and per-kind revisions.
-- Apply after migrations/0001_catalog.sql, 0002_podcasts.sql, and 0003_listening.sql. The retired 0004_connection_settings.sql is a no-op.

CREATE TABLE IF NOT EXISTS catalog_meta (
  kind TEXT NOT NULL PRIMARY KEY,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count>=0),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO catalog_meta(kind,item_count,revision,updated_at)
SELECT 'tracks',COUNT(*),1,CURRENT_TIMESTAMP FROM tracks;
INSERT OR IGNORE INTO catalog_meta(kind,item_count,revision,updated_at)
SELECT 'folders',COUNT(*),1,CURRENT_TIMESTAMP FROM folders;
INSERT OR IGNORE INTO catalog_meta(kind,item_count,revision,updated_at)
SELECT 'shows',COUNT(*),1,CURRENT_TIMESTAMP FROM podcast_shows;
INSERT OR IGNORE INTO catalog_meta(kind,item_count,revision,updated_at)
SELECT 'episodes',COUNT(*),1,CURRENT_TIMESTAMP FROM podcast_episodes;

CREATE INDEX IF NOT EXISTS idx_tracks_indexed_at ON tracks(indexed_at);
CREATE INDEX IF NOT EXISTS idx_folders_indexed_at ON folders(indexed_at);
CREATE INDEX IF NOT EXISTS idx_podcast_shows_indexed_at ON podcast_shows(indexed_at);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_indexed_at ON podcast_episodes(indexed_at);
CREATE INDEX IF NOT EXISTS idx_podcast_shows_cursor ON podcast_shows(title COLLATE NOCASE,folder_path);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_cursor
  ON podcast_episodes(COALESCE(published_at,''),title COLLATE NOCASE,path);

CREATE TRIGGER IF NOT EXISTS trg_tracks_catalog_meta_insert
AFTER INSERT ON tracks BEGIN
  UPDATE catalog_meta SET item_count=item_count+1,revision=revision+1,updated_at=CURRENT_TIMESTAMP
  WHERE kind='tracks';
END;
CREATE TRIGGER IF NOT EXISTS trg_tracks_catalog_meta_delete
AFTER DELETE ON tracks BEGIN
  UPDATE catalog_meta SET item_count=MAX(0,item_count-1),revision=revision+1,updated_at=CURRENT_TIMESTAMP
  WHERE kind='tracks';
END;

CREATE TRIGGER IF NOT EXISTS trg_folders_catalog_meta_insert
AFTER INSERT ON folders BEGIN
  UPDATE catalog_meta SET item_count=item_count+1,revision=revision+1,updated_at=CURRENT_TIMESTAMP
  WHERE kind='folders';
END;
CREATE TRIGGER IF NOT EXISTS trg_folders_catalog_meta_delete
AFTER DELETE ON folders BEGIN
  UPDATE catalog_meta SET item_count=MAX(0,item_count-1),revision=revision+1,updated_at=CURRENT_TIMESTAMP
  WHERE kind='folders';
END;

CREATE TRIGGER IF NOT EXISTS trg_podcast_shows_catalog_meta_insert
AFTER INSERT ON podcast_shows BEGIN
  UPDATE catalog_meta SET item_count=item_count+1,revision=revision+1,updated_at=CURRENT_TIMESTAMP
  WHERE kind='shows';
END;
CREATE TRIGGER IF NOT EXISTS trg_podcast_shows_catalog_meta_delete
AFTER DELETE ON podcast_shows BEGIN
  UPDATE catalog_meta SET item_count=MAX(0,item_count-1),revision=revision+1,updated_at=CURRENT_TIMESTAMP
  WHERE kind='shows';
END;

CREATE TRIGGER IF NOT EXISTS trg_podcast_episodes_catalog_meta_insert
AFTER INSERT ON podcast_episodes BEGIN
  UPDATE catalog_meta SET item_count=item_count+1,revision=revision+1,updated_at=CURRENT_TIMESTAMP
  WHERE kind='episodes';
END;
CREATE TRIGGER IF NOT EXISTS trg_podcast_episodes_catalog_meta_delete
AFTER DELETE ON podcast_episodes BEGIN
  UPDATE catalog_meta SET item_count=MAX(0,item_count-1),revision=revision+1,updated_at=CURRENT_TIMESTAMP
  WHERE kind='episodes';
END;
