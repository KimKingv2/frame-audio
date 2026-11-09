# FRAME Audio Indexer · first milestone

This is a **read-only diagnostic tool** for the private Mac. It is deliberately not a full-library scanner yet.

## Why this is staged

The Music library contains about 7,000 tracks / 90 GB. Before extracting tags, artwork, and lyrics, verify that OpenList can return file metadata and that its raw file URL honours HTTP Range. If Range is ignored, the tool stops without downloading the full file.

## Supported first checks

- Validate private TOML configuration and token environment variable.
- Read the first page of each configured Music / Podcasts root.
- Request a small byte range from one sample audio file.
- Report HTTP status and whether the server returned 206 Partial Content.

## Private setup

1. Copy `indexer/config.example.toml` to `config/local.toml` in a private working copy.
2. Fill in your real OpenList host and the two private root paths.
3. Set the token in the environment variable named by `token_env`.
4. Never commit `config/local.toml`, exported index data, or the token.

Install with Python 3.11+:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ./indexer
```

Available commands:

```bash
frame-audio-indexer check-config
frame-audio-indexer list-roots
frame-audio-indexer probe-range --path "/完整/音訊/檔案.flac" --bytes 1024
```

All commands are read-only. The Range probe refuses to read an entire file when the server responds with HTTP 200 instead of 206.

## Next milestone

After a representative FLAC, MP3, M4A, and WAV range test, implement Mutagen metadata extraction, artwork de-duplication, lyric extraction, SQLite incremental state, and JSON export. Do not run a 7,000-track scan before the sample tests pass.
