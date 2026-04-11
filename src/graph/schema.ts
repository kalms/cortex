export const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  qualified_name TEXT,
  file_path   TEXT,
  data        TEXT NOT NULL DEFAULT '{}',
  tier        TEXT NOT NULL DEFAULT 'personal',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edge_annotations (
  id          TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  edge_id     TEXT NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);
`;

export const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_tier ON nodes(tier);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
`;

export const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  title, description, rationale,
  node_id UNINDEXED
);
`;
