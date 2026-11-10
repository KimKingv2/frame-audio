CREATE TABLE IF NOT EXISTS listening_progress (
 item_type TEXT NOT NULL CHECK(item_type IN ('track','episode')),
 item_id TEXT NOT NULL,
 path TEXT NOT NULL,
 title TEXT NOT NULL,
 subtitle TEXT,
 artwork_hash TEXT,
 position_ms INTEGER NOT NULL DEFAULT 0 CHECK(position_ms>=0),
 duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms>=0),
 playback_rate REAL NOT NULL DEFAULT 1 CHECK(playback_rate>=0.5 AND playback_rate<=2),
 updated_at TEXT NOT NULL,
 PRIMARY KEY(item_type,item_id)
);
CREATE INDEX IF NOT EXISTS idx_listening_progress_updated
 ON listening_progress(item_type,updated_at DESC);

CREATE TABLE IF NOT EXISTS listening_events (
 session_id TEXT NOT NULL PRIMARY KEY,
 item_type TEXT NOT NULL CHECK(item_type IN ('track','episode')),
 item_id TEXT NOT NULL,
 path TEXT NOT NULL,
 title TEXT NOT NULL,
 subtitle TEXT,
 started_at TEXT NOT NULL,
 listened_seconds INTEGER NOT NULL DEFAULT 0 CHECK(listened_seconds>=0),
 duration_seconds INTEGER,
 completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listening_events_period
 ON listening_events(item_type,started_at);
CREATE INDEX IF NOT EXISTS idx_listening_events_item
 ON listening_events(item_type,item_id,started_at);
