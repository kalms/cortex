CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  project_id  TEXT NOT NULL,
  payload     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS events_kind_created_at ON events(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
