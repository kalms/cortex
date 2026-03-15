package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"runtime"
	"time"

	"github.com/DeusData/codebase-memory-mcp/internal/cbm"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// Compile-time assertion: *GraphBuffer implements store.StoreBackend.
var _ store.StoreBackend = (*GraphBuffer)(nil)

// GraphBuffer holds all nodes and edges in memory during the buffered indexing phase.
// Implements store.StoreBackend so pipeline passes can run against it directly,
// eliminating the need for an in-memory SQLite during full indexing.
//
// Assigns temporary IDs (sequential counter) that are remapped to real SQLite-assigned
// IDs during FlushTo/DumpToSQLite.
type GraphBuffer struct {
	project  string
	rootPath string
	nextID   int64

	// Primary indexes
	nodeByQN map[string]*store.Node
	nodeByID map[int64]*store.Node

	// Secondary node indexes
	nodesByLabel map[string][]*store.Node
	nodesByName  map[string][]*store.Node

	// Edge storage
	edges     []*store.Edge
	edgeByKey map[edgeKey]*store.Edge

	// Edge indexes
	edgesBySourceType map[int64]map[string][]*store.Edge // sourceID → type → edges
	edgesByTargetType map[int64]map[string][]*store.Edge // targetID → type → edges
	edgesByType       map[string][]*store.Edge           // edge type → edges
}

type edgeKey struct {
	SourceID int64
	TargetID int64
	Type     string
}

func newGraphBuffer(project, rootPath string) *GraphBuffer {
	return &GraphBuffer{
		project:           project,
		rootPath:          rootPath,
		nextID:            1,
		nodeByQN:          make(map[string]*store.Node),
		nodeByID:          make(map[int64]*store.Node),
		nodesByLabel:      make(map[string][]*store.Node),
		nodesByName:       make(map[string][]*store.Node),
		edgeByKey:         make(map[edgeKey]*store.Edge),
		edgesBySourceType: make(map[int64]map[string][]*store.Edge),
		edgesByTargetType: make(map[int64]map[string][]*store.Edge),
		edgesByType:       make(map[string][]*store.Edge),
	}
}

// --- StoreBackend: Node methods ---

// UpsertNode inserts or updates a node. Returns the temp ID.
// Properties are JSON-round-tripped to normalize types (e.g., []string → []any),
// matching the behavior of SQLite serialization/deserialization.
func (b *GraphBuffer) UpsertNode(n *store.Node) (int64, error) {
	if existing, ok := b.nodeByQN[n.QualifiedName]; ok {
		// Update in-place (pointer is shared by secondary indexes).
		if existing.Label != n.Label {
			b.removeFromLabelIndex(existing.Label, existing.ID)
			b.nodesByLabel[n.Label] = append(b.nodesByLabel[n.Label], existing)
		}
		if existing.Name != n.Name {
			b.removeFromNameIndex(existing.Name, existing.ID)
			b.nodesByName[n.Name] = append(b.nodesByName[n.Name], existing)
		}
		existing.Label = n.Label
		existing.Name = n.Name
		existing.FilePath = n.FilePath
		existing.StartLine = n.StartLine
		existing.EndLine = n.EndLine
		if n.Properties != nil {
			existing.Properties = roundTripProps(n.Properties)
		}
		return existing.ID, nil
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
	b.nodesByName[n.Name] = append(b.nodesByName[n.Name], n)
	return id, nil
}

// roundTripProps normalizes property types via JSON marshal/unmarshal.
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

// removeFromNameIndex removes a node from the name secondary index by ID.
func (b *GraphBuffer) removeFromNameIndex(name string, id int64) {
	nodes := b.nodesByName[name]
	for i, n := range nodes {
		if n.ID == id {
			nodes[i] = nodes[len(nodes)-1]
			b.nodesByName[name] = nodes[:len(nodes)-1]
			return
		}
	}
}

// UpsertNodeBatch upserts multiple nodes and returns a QN → tempID map.
func (b *GraphBuffer) UpsertNodeBatch(nodes []*store.Node) (map[string]int64, error) {
	result := make(map[string]int64, len(nodes))
	for _, n := range nodes {
		id, _ := b.UpsertNode(n)
		result[n.QualifiedName] = id
	}
	return result, nil
}

// FindNodeByID returns the node with the given temp ID.
func (b *GraphBuffer) FindNodeByID(id int64) (*store.Node, error) {
	return b.nodeByID[id], nil
}

// FindNodeByQN returns the node with the given qualified name.
// project param is ignored (buffer is single-project).
func (b *GraphBuffer) FindNodeByQN(_, qn string) (*store.Node, error) {
	return b.nodeByQN[qn], nil
}

// FindNodesByLabel returns all nodes with the given label.
// project param is ignored (buffer is single-project).
func (b *GraphBuffer) FindNodesByLabel(_, label string) ([]*store.Node, error) {
	return b.nodesByLabel[label], nil
}

// FindNodesByName returns all nodes with the given name.
// project param is ignored (buffer is single-project).
func (b *GraphBuffer) FindNodesByName(_, name string) ([]*store.Node, error) {
	return b.nodesByName[name], nil
}

// FindNodesByIDs returns a map of nodeID → *Node for the given IDs.
func (b *GraphBuffer) FindNodesByIDs(ids []int64) (map[int64]*store.Node, error) {
	result := make(map[int64]*store.Node, len(ids))
	for _, id := range ids {
		if n, ok := b.nodeByID[id]; ok {
			result[id] = n
		}
	}
	return result, nil
}

// FindNodeIDsByQNs returns a map of QN → tempID for the given qualified names.
// project param is ignored (buffer is single-project).
func (b *GraphBuffer) FindNodeIDsByQNs(_ string, qns []string) (map[string]int64, error) {
	result := make(map[string]int64, len(qns))
	for _, qn := range qns {
		if n, ok := b.nodeByQN[qn]; ok {
			result[qn] = n.ID
		}
	}
	return result, nil
}

// DeleteNodesByLabel deletes all nodes with the given label and cascade-deletes
// any edges referencing the deleted node IDs.
func (b *GraphBuffer) DeleteNodesByLabel(_, label string) error {
	nodes := b.nodesByLabel[label]
	if len(nodes) == 0 {
		return nil
	}

	// Build set of deleted node IDs
	deleted := make(map[int64]struct{}, len(nodes))
	for _, n := range nodes {
		deleted[n.ID] = struct{}{}
		delete(b.nodeByQN, n.QualifiedName)
		delete(b.nodeByID, n.ID)
		b.removeFromNameIndex(n.Name, n.ID)
	}
	delete(b.nodesByLabel, label)

	// Cascade-delete edges referencing deleted nodes
	b.cascadeDeleteEdges(deleted)
	return nil
}

// cascadeDeleteEdges removes all edges where SourceID or TargetID is in the deleted set.
func (b *GraphBuffer) cascadeDeleteEdges(deletedNodes map[int64]struct{}) {
	// Sweep edges, remove any referencing deleted nodes
	kept := make([]*store.Edge, 0, len(b.edges))
	for _, e := range b.edges {
		_, srcDeleted := deletedNodes[e.SourceID]
		_, tgtDeleted := deletedNodes[e.TargetID]
		if srcDeleted || tgtDeleted {
			// Remove from all edge indexes
			key := edgeKey{e.SourceID, e.TargetID, e.Type}
			delete(b.edgeByKey, key)
			b.removeFromEdgeSourceType(e)
			b.removeFromEdgeTargetType(e)
			b.removeFromEdgeType(e)
		} else {
			kept = append(kept, e)
		}
	}
	b.edges = kept
}

func (b *GraphBuffer) removeFromEdgeSourceType(e *store.Edge) {
	if byType, ok := b.edgesBySourceType[e.SourceID]; ok {
		edges := byType[e.Type]
		for i, ee := range edges {
			if ee.ID == e.ID {
				edges[i] = edges[len(edges)-1]
				byType[e.Type] = edges[:len(edges)-1]
				return
			}
		}
	}
}

func (b *GraphBuffer) removeFromEdgeTargetType(e *store.Edge) {
	if byType, ok := b.edgesByTargetType[e.TargetID]; ok {
		edges := byType[e.Type]
		for i, ee := range edges {
			if ee.ID == e.ID {
				edges[i] = edges[len(edges)-1]
				byType[e.Type] = edges[:len(edges)-1]
				return
			}
		}
	}
}

func (b *GraphBuffer) removeFromEdgeType(e *store.Edge) {
	edges := b.edgesByType[e.Type]
	for i, ee := range edges {
		if ee.ID == e.ID {
			edges[i] = edges[len(edges)-1]
			b.edgesByType[e.Type] = edges[:len(edges)-1]
			return
		}
	}
}

// CountNodes returns the number of nodes in the buffer.
func (b *GraphBuffer) CountNodes(_ string) (int, error) {
	return len(b.nodeByQN), nil
}

// --- StoreBackend: Edge methods ---

// InsertEdge inserts an edge with dedup by (sourceID, targetID, type).
// On conflict, merges properties. Returns the edge ID.
func (b *GraphBuffer) InsertEdge(e *store.Edge) (int64, error) {
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
		return existing.ID, nil
	}

	// New edge: assign temp ID.
	id := b.nextID
	b.nextID++
	e.ID = id
	e.Project = b.project
	b.edges = append(b.edges, e)
	b.edgeByKey[key] = e

	// Update source type index
	if byType, ok := b.edgesBySourceType[e.SourceID]; ok {
		byType[e.Type] = append(byType[e.Type], e)
	} else {
		b.edgesBySourceType[e.SourceID] = map[string][]*store.Edge{e.Type: {e}}
	}

	// Update target type index
	if byType, ok := b.edgesByTargetType[e.TargetID]; ok {
		byType[e.Type] = append(byType[e.Type], e)
	} else {
		b.edgesByTargetType[e.TargetID] = map[string][]*store.Edge{e.Type: {e}}
	}

	// Update type index
	b.edgesByType[e.Type] = append(b.edgesByType[e.Type], e)

	return id, nil
}

// InsertEdgeBatch inserts multiple edges.
func (b *GraphBuffer) InsertEdgeBatch(edges []*store.Edge) error {
	for _, e := range edges {
		if _, err := b.InsertEdge(e); err != nil {
			return err
		}
	}
	return nil
}

// FindEdgesBySourceAndType returns edges from sourceID with the given type.
func (b *GraphBuffer) FindEdgesBySourceAndType(sourceID int64, edgeType string) ([]*store.Edge, error) {
	byType, ok := b.edgesBySourceType[sourceID]
	if !ok {
		return nil, nil
	}
	return byType[edgeType], nil
}

// FindEdgesByTargetAndType returns edges to targetID with the given type.
func (b *GraphBuffer) FindEdgesByTargetAndType(targetID int64, edgeType string) ([]*store.Edge, error) {
	byType, ok := b.edgesByTargetType[targetID]
	if !ok {
		return nil, nil
	}
	return byType[edgeType], nil
}

// FindEdgesByType returns all edges of the given type.
// project param is ignored (buffer is single-project).
func (b *GraphBuffer) FindEdgesByType(_, edgeType string) ([]*store.Edge, error) {
	return b.edgesByType[edgeType], nil
}

// DeleteEdgesByType removes all edges of the given type from all indexes.
func (b *GraphBuffer) DeleteEdgesByType(_, edgeType string) error {
	edges := b.edgesByType[edgeType]
	if len(edges) == 0 {
		return nil
	}

	// Remove from all indexes
	for _, e := range edges {
		key := edgeKey{e.SourceID, e.TargetID, e.Type}
		delete(b.edgeByKey, key)
		b.removeFromEdgeSourceType(e)
		b.removeFromEdgeTargetType(e)
	}
	delete(b.edgesByType, edgeType)

	// Rebuild edges slice without the deleted type
	kept := make([]*store.Edge, 0, len(b.edges)-len(edges))
	for _, e := range b.edges {
		if e.Type != edgeType {
			kept = append(kept, e)
		}
	}
	b.edges = kept
	return nil
}

// CountEdgesByType returns the number of edges of a given type.
func (b *GraphBuffer) CountEdgesByType(_, edgeType string) (int, error) {
	return len(b.edgesByType[edgeType]), nil
}

// CountEdges returns the total number of edges in the buffer.
func (b *GraphBuffer) CountEdges(_ string) (int, error) {
	return len(b.edges), nil
}

// --- StoreBackend: Project methods ---

// GetProject returns a synthetic Project for the buffer.
func (b *GraphBuffer) GetProject(_ string) (*store.Project, error) {
	return &store.Project{
		Name:      b.project,
		IndexedAt: store.Now(),
		RootPath:  b.rootPath,
	}, nil
}

// --- FlushTo (existing, used by incremental path and DumpToSQLite) ---

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

// DumpToSQLite writes the buffer contents directly as a SQLite .db file
// using the C direct page writer. No SQL parser, no INSERTs, no B-tree
// rebalancing. Constructs valid B-tree pages from pre-sorted data.
// releaseIndexes frees secondary indexes that are only needed during passes.
// Called before DumpToSQLite to reduce peak memory during the dump phase.
func (b *GraphBuffer) releaseIndexes() {
	b.nodeByID = nil
	b.nodesByLabel = nil
	b.nodesByName = nil
	b.edges = nil
	b.edgesBySourceType = nil
	b.edgesByTargetType = nil
	b.edgesByType = nil
}

func (b *GraphBuffer) DumpToSQLite(path string) error {
	indexedAt := store.Now()

	// Assign sequential IDs and build lookup for edge remapping.
	tempToFinal := make(map[int64]int64, len(b.nodeByQN))
	dumpNodes := make([]cbm.DumpNode, 0, len(b.nodeByQN))
	finalID := int64(1)
	for _, n := range b.nodeByQN {
		tempToFinal[n.ID] = finalID
		dumpNodes = append(dumpNodes, cbm.DumpNode{
			ID:            finalID,
			Project:       b.project,
			Label:         n.Label,
			Name:          n.Name,
			QualifiedName: n.QualifiedName,
			FilePath:      n.FilePath,
			StartLine:     n.StartLine,
			EndLine:       n.EndLine,
			Properties:    marshalPropsString(n.Properties),
		})
		finalID++
	}

	// Remap edge IDs and collect.
	dumpEdges := make([]cbm.DumpEdge, 0, len(b.edgeByKey))
	edgeID := int64(1)
	for _, e := range b.edgeByKey {
		srcID, okS := tempToFinal[e.SourceID]
		tgtID, okT := tempToFinal[e.TargetID]
		if !okS || !okT {
			continue
		}
		urlPath, _ := e.Properties["url_path"].(string)
		dumpEdges = append(dumpEdges, cbm.DumpEdge{
			ID:         edgeID,
			Project:    b.project,
			SourceID:   srcID,
			TargetID:   tgtID,
			Type:       e.Type,
			Properties: marshalPropsString(e.Properties),
			URLPath:    urlPath,
		})
		edgeID++
	}

	// Release GraphBuffer maps — data is now in dumpNodes/dumpEdges.
	// This frees ~3GB for a Linux kernel-scale index.
	b.nodeByQN = nil
	b.edgeByKey = nil
	runtime.GC()

	return cbm.WriteDB(path, b.project, b.rootPath, indexedAt, dumpNodes, dumpEdges)
}

// marshalPropsString serializes properties to a JSON string.
func marshalPropsString(props map[string]any) string {
	if len(props) == 0 {
		return "{}"
	}
	b, err := json.Marshal(props)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// allNodes returns all nodes in the buffer as a slice.
func (b *GraphBuffer) allNodes() []*store.Node {
	nodes := make([]*store.Node, 0, len(b.nodeByQN))
	for _, n := range b.nodeByQN {
		nodes = append(nodes, n)
	}
	return nodes
}
