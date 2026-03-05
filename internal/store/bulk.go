package store

import (
	"context"
	"fmt"
	"strings"
)

// userIndexes lists all user-created indexes (excluding UNIQUE autoindexes on tables).
var userIndexes = []string{
	"idx_nodes_label",
	"idx_nodes_name",
	"idx_nodes_file",
	"idx_edges_source",
	"idx_edges_target",
	"idx_edges_type",
	"idx_edges_target_type",
	"idx_edges_source_type",
	"idx_edges_url_path",
}

// DropUserIndexes drops all user-created indexes for faster bulk writes.
func (s *Store) DropUserIndexes(ctx context.Context) error {
	for _, idx := range userIndexes {
		if _, err := s.q.Exec("DROP INDEX IF EXISTS " + idx); err != nil {
			return fmt.Errorf("drop index %s: %w", idx, err)
		}
	}
	return nil
}

// CreateUserIndexes recreates all user-created indexes (single sorted pass, O(N)).
func (s *Store) CreateUserIndexes(ctx context.Context) error {
	indexes := []string{
		"CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(project, label)",
		"CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(project, name)",
		"CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(project, file_path)",
		"CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id, type)",
		"CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, type)",
		"CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(project, type)",
		"CREATE INDEX IF NOT EXISTS idx_edges_target_type ON edges(project, target_id, type)",
		"CREATE INDEX IF NOT EXISTS idx_edges_source_type ON edges(project, source_id, type)",
		"CREATE INDEX IF NOT EXISTS idx_edges_url_path ON edges(project, url_path_gen)",
	}
	for _, ddl := range indexes {
		if _, err := s.q.Exec(ddl); err != nil {
			return fmt.Errorf("create index: %w", err)
		}
	}
	return nil
}

// BulkInsertNodes inserts nodes in batches using plain INSERT (no ON CONFLICT).
// Assumes no duplicates exist for the project after a prior DELETE.
func (s *Store) BulkInsertNodes(ctx context.Context, nodes []*Node) error {
	for i := 0; i < len(nodes); i += nodesBatchSize {
		end := i + nodesBatchSize
		if end > len(nodes) {
			end = len(nodes)
		}
		if err := s.bulkInsertNodeChunk(nodes[i:end]); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) bulkInsertNodeChunk(batch []*Node) error {
	var sb strings.Builder
	sb.WriteString("INSERT INTO nodes (project, label, name, qualified_name, file_path, start_line, end_line, properties) VALUES ")

	args := make([]any, 0, len(batch)*numNodeCols)
	for i, n := range batch {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString("(?,?,?,?,?,?,?,?)")
		args = append(args, n.Project, n.Label, n.Name, n.QualifiedName, n.FilePath, n.StartLine, n.EndLine, marshalProps(n.Properties))
	}

	if _, err := s.q.Exec(sb.String(), args...); err != nil {
		return fmt.Errorf("bulk insert nodes: %w", err)
	}
	return nil
}

// BulkInsertEdges inserts edges in batches using plain INSERT (no ON CONFLICT).
// Assumes no duplicates exist for the project after a prior DELETE.
func (s *Store) BulkInsertEdges(ctx context.Context, edges []*Edge) error {
	for i := 0; i < len(edges); i += edgesBatchSize {
		end := i + edgesBatchSize
		if end > len(edges) {
			end = len(edges)
		}
		if err := s.bulkInsertEdgeChunk(edges[i:end]); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) bulkInsertEdgeChunk(batch []*Edge) error {
	var sb strings.Builder
	sb.WriteString("INSERT INTO edges (project, source_id, target_id, type, properties) VALUES ")

	args := make([]any, 0, len(batch)*numEdgeCols)
	for i, e := range batch {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString("(?,?,?,?,?)")
		args = append(args, e.Project, e.SourceID, e.TargetID, e.Type, marshalProps(e.Properties))
	}

	if _, err := s.q.Exec(sb.String(), args...); err != nil {
		return fmt.Errorf("bulk insert edges: %w", err)
	}
	return nil
}

// LoadNodeIDMap returns a map of qualified_name → SQLite ID for all nodes in a project.
func (s *Store) LoadNodeIDMap(ctx context.Context, project string) (map[string]int64, error) {
	rows, err := s.q.Query("SELECT id, qualified_name FROM nodes WHERE project=?", project)
	if err != nil {
		return nil, fmt.Errorf("load node id map: %w", err)
	}
	defer rows.Close()

	result := make(map[string]int64)
	for rows.Next() {
		var id int64
		var qn string
		if err := rows.Scan(&id, &qn); err != nil {
			return nil, err
		}
		result[qn] = id
	}
	return result, rows.Err()
}
