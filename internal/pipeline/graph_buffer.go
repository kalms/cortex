package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// GraphBuffer holds all nodes and edges in memory during the buffered indexing phase.
// Assigns temporary IDs (sequential counter) that are remapped to real SQLite-assigned
// IDs during FlushTo. All IDs within the buffer are valid only for cross-referencing
// nodes↔edges within the buffer.
type GraphBuffer struct {
	project string
	nextID  int64

	nodeByQN     map[string]*store.Node
	nodesByLabel map[string][]*store.Node
	nodeByID     map[int64]*store.Node

	edges             []*store.Edge
	edgeByKey         map[edgeKey]*store.Edge
	edgesBySourceType map[int64]map[string][]*store.Edge
}

type edgeKey struct {
	SourceID int64
	TargetID int64
	Type     string
}

func newGraphBuffer(project string) *GraphBuffer {
	return &GraphBuffer{
		project:           project,
		nextID:            1,
		nodeByQN:          make(map[string]*store.Node),
		nodesByLabel:      make(map[string][]*store.Node),
		nodeByID:          make(map[int64]*store.Node),
		edgeByKey:         make(map[edgeKey]*store.Edge),
		edgesBySourceType: make(map[int64]map[string][]*store.Edge),
	}
}

// UpsertNode inserts or updates a node. Returns the temp ID.
// Properties are JSON-round-tripped to normalize types (e.g., []string → []any),
// matching the behavior of SQLite serialization/deserialization.
func (b *GraphBuffer) UpsertNode(n *store.Node) int64 {
	if existing, ok := b.nodeByQN[n.QualifiedName]; ok {
		// Update in-place (pointer is shared by secondary indexes).
		// Fix label index if label changed.
		if existing.Label != n.Label {
			b.removeFromLabelIndex(existing.Label, existing.ID)
			b.nodesByLabel[n.Label] = append(b.nodesByLabel[n.Label], existing)
		}
		existing.Label = n.Label
		existing.Name = n.Name
		existing.FilePath = n.FilePath
		existing.StartLine = n.StartLine
		existing.EndLine = n.EndLine
		if n.Properties != nil {
			existing.Properties = roundTripProps(n.Properties)
		}
		return existing.ID
	}

	// New node: assign temp ID.
	id := b.nextID
	b.nextID++
	n.ID = id
	n.Project = b.project
	n.Properties = roundTripProps(n.Properties)
	b.nodeByQN[n.QualifiedName] = n
	b.nodeByID[id] = n
	b.nodesByLabel[n.Label] = append(b.nodesByLabel[n.Label], n)
	return id
}

// roundTripProps normalizes property types via JSON marshal/unmarshal.
// This ensures types like []string become []any, matching SQLite round-trip behavior.
func roundTripProps(props map[string]any) map[string]any {
	if len(props) == 0 {
		return props
	}
	data, err := json.Marshal(props)
	if err != nil {
		return props
	}
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		return props
	}
	return result
}

// removeFromLabelIndex removes a node from the label secondary index by ID.
func (b *GraphBuffer) removeFromLabelIndex(label string, id int64) {
	nodes := b.nodesByLabel[label]
	for i, n := range nodes {
		if n.ID == id {
			nodes[i] = nodes[len(nodes)-1]
			b.nodesByLabel[label] = nodes[:len(nodes)-1]
			return
		}
	}
}

// UpsertNodeBatch upserts multiple nodes and returns a QN → tempID map.
func (b *GraphBuffer) UpsertNodeBatch(nodes []*store.Node) map[string]int64 {
	result := make(map[string]int64, len(nodes))
	for _, n := range nodes {
		result[n.QualifiedName] = b.UpsertNode(n)
	}
	return result
}

// FindNodesByLabel returns all nodes with the given label.
func (b *GraphBuffer) FindNodesByLabel(label string) []*store.Node {
	return b.nodesByLabel[label]
}

// FindNodeByQN returns the node with the given qualified name, or nil.
func (b *GraphBuffer) FindNodeByQN(qn string) *store.Node {
	return b.nodeByQN[qn]
}

// FindNodeByID returns the node with the given temp ID, or nil.
func (b *GraphBuffer) FindNodeByID(id int64) *store.Node {
	return b.nodeByID[id]
}

// FindNodeIDsByQNs returns a map of QN → tempID for the given qualified names.
func (b *GraphBuffer) FindNodeIDsByQNs(qns []string) map[string]int64 {
	result := make(map[string]int64, len(qns))
	for _, qn := range qns {
		if n, ok := b.nodeByQN[qn]; ok {
			result[qn] = n.ID
		}
	}
	return result
}

// InsertEdge inserts an edge with dedup by (sourceID, targetID, type).
// On conflict, merges properties. Returns the edge ID.
func (b *GraphBuffer) InsertEdge(e *store.Edge) int64 {
	key := edgeKey{e.SourceID, e.TargetID, e.Type}
	if existing, ok := b.edgeByKey[key]; ok {
		// Merge properties (emulates json_patch).
		if e.Properties != nil {
			if existing.Properties == nil {
				existing.Properties = make(map[string]any)
			}
			for k, v := range e.Properties {
				existing.Properties[k] = v
			}
		}
		return existing.ID
	}

	// New edge: assign temp ID.
	id := b.nextID
	b.nextID++
	e.ID = id
	e.Project = b.project
	b.edges = append(b.edges, e)
	b.edgeByKey[key] = e

	// Update sourceType index.
	byType, ok := b.edgesBySourceType[e.SourceID]
	if !ok {
		byType = make(map[string][]*store.Edge)
		b.edgesBySourceType[e.SourceID] = byType
	}
	byType[e.Type] = append(byType[e.Type], e)

	return id
}

// InsertEdgeBatch inserts multiple edges.
func (b *GraphBuffer) InsertEdgeBatch(edges []*store.Edge) {
	for _, e := range edges {
		b.InsertEdge(e)
	}
}

// FindEdgesBySourceAndType returns edges from sourceID with the given type.
func (b *GraphBuffer) FindEdgesBySourceAndType(sourceID int64, edgeType string) []*store.Edge {
	byType, ok := b.edgesBySourceType[sourceID]
	if !ok {
		return nil
	}
	return byType[edgeType]
}

// FlushTo writes all buffered nodes and edges to the SQLite store.
// Drops indexes before bulk insert and recreates them after for O(N) index builds.
// On a fresh DB (no existing data), skips the expensive DROP INDEX + DELETE steps.
func (b *GraphBuffer) FlushTo(ctx context.Context, s *store.Store) error {
	t := time.Now()

	// 1. Drop user indexes so bulk INSERT doesn't maintain them.
	if err := s.DropUserIndexes(ctx); err != nil {
		return fmt.Errorf("drop indexes: %w", err)
	}

	// 2. Delete existing project data (skip on fresh DB — nothing to delete).
	existingCount, _ := s.CountNodes(b.project)
	if existingCount > 0 {
		if err := s.DeleteEdgesByProject(b.project); err != nil {
			return fmt.Errorf("delete edges: %w", err)
		}
		if err := s.DeleteNodesByProject(b.project); err != nil {
			return fmt.Errorf("delete nodes: %w", err)
		}
	}

	// 3. Bulk insert nodes (plain INSERT, no ON CONFLICT — table is empty for this project).
	nodes := b.allNodes()
	if err := s.BulkInsertNodes(ctx, nodes); err != nil {
		return fmt.Errorf("bulk insert nodes: %w", err)
	}

	// 4. Build QN → real SQLite ID map.
	qnToRealID, err := s.LoadNodeIDMap(ctx, b.project)
	if err != nil {
		return fmt.Errorf("load node id map: %w", err)
	}

	// 5. Build tempID → QN for edge remapping.
	tempToQN := make(map[int64]string, len(b.nodeByQN))
	for qn, n := range b.nodeByQN {
		tempToQN[n.ID] = qn
	}

	// 6. Remap edges from temp IDs to real SQLite IDs.
	remapped := make([]*store.Edge, 0, len(b.edges))
	skipped := 0
	for _, e := range b.edges {
		srcQN := tempToQN[e.SourceID]
		tgtQN := tempToQN[e.TargetID]
		realSrc := qnToRealID[srcQN]
		realTgt := qnToRealID[tgtQN]
		if realSrc == 0 || realTgt == 0 {
			skipped++
			continue
		}
		remapped = append(remapped, &store.Edge{
			Project:    b.project,
			SourceID:   realSrc,
			TargetID:   realTgt,
			Type:       e.Type,
			Properties: e.Properties,
		})
	}

	if err := s.BulkInsertEdges(ctx, remapped); err != nil {
		return fmt.Errorf("bulk insert edges: %w", err)
	}

	// 7. Recreate indexes (single sorted pass, O(N)).
	if err := s.CreateUserIndexes(ctx); err != nil {
		return fmt.Errorf("create indexes: %w", err)
	}

	slog.Info("graph_buffer.flush",
		"nodes", len(nodes),
		"edges", len(remapped),
		"skipped_edges", skipped,
		"elapsed", time.Since(t),
	)
	return nil
}

// allNodes returns all nodes in the buffer as a slice.
func (b *GraphBuffer) allNodes() []*store.Node {
	nodes := make([]*store.Node, 0, len(b.nodeByQN))
	for _, n := range b.nodeByQN {
		nodes = append(nodes, n)
	}
	return nodes
}
