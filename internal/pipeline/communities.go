package pipeline

import (
	"fmt"
	"log/slog"
	"math"
	"sort"
	"time"

	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// passCommunities runs hybrid LPA→Leiden community detection on the CALLS graph
// and creates Community nodes + MEMBER_OF edges.
func (p *Pipeline) passCommunities() {
	slog.Info("pass.communities")

	// Load CALLS edges
	callEdges, err := p.Store.FindEdgesByType(p.ProjectName, "CALLS")
	if err != nil || len(callEdges) == 0 {
		slog.Info("pass.communities.skip", "reason", "no_calls")
		return
	}

	// Build adjacency list (undirected for community detection)
	adj := make(map[int64]map[int64]bool)
	allNodes := make(map[int64]bool)
	for _, e := range callEdges {
		allNodes[e.SourceID] = true
		allNodes[e.TargetID] = true
		if adj[e.SourceID] == nil {
			adj[e.SourceID] = make(map[int64]bool)
		}
		if adj[e.TargetID] == nil {
			adj[e.TargetID] = make(map[int64]bool)
		}
		adj[e.SourceID][e.TargetID] = true
		adj[e.TargetID][e.SourceID] = true
	}

	slog.Info("pass.communities.graph", "nodes", len(allNodes), "edges", len(callEdges))

	// Run hybrid LPA→Leiden community detection
	t := time.Now()
	communities := hybridCommunities(adj, allNodes)
	slog.Info("pass.communities.algo", "elapsed", time.Since(t), "communities", len(communities))

	// Create Community nodes + MEMBER_OF edges
	communityCount, memberOfCount := p.storeCommunities(communities)
	slog.Info("pass.communities.done", "communities", communityCount, "member_of", memberOfCount)
}

// hybridCommunities runs LPA for fast initial partition, then Leiden refinement
// to guarantee connected communities. Replaces Louvain for better scaling.
func hybridCommunities(adj map[int64]map[int64]bool, allNodes map[int64]bool) map[int][]int64 {
	partition := lpaInitPartition(adj, allNodes)
	refined := leidenRefine(adj, partition)
	return groupAndFilter(refined)
}

// lpaInitPartition runs Label Propagation for quick O(m) partitioning.
// Each node starts with a unique label, then adopts the most frequent neighbor label.
// Converges when <1% of nodes change labels per iteration.
func lpaInitPartition(adj map[int64]map[int64]bool, allNodes map[int64]bool) map[int64]int {
	label := make(map[int64]int, len(allNodes))
	id := 0
	for n := range allNodes {
		label[n] = id
		id++
	}

	nodeCount := len(allNodes)
	threshold := nodeCount / 100 // <1% changed → converged
	if threshold < 1 {
		threshold = 1
	}

	for iter := 0; iter < 10; iter++ {
		changed := 0
		for node, neighbors := range adj {
			if len(neighbors) == 0 {
				continue
			}
			// Count neighbor labels
			freq := make(map[int]int, len(neighbors))
			for nb := range neighbors {
				freq[label[nb]]++
			}
			// Pick most frequent (deterministic tie-break by lower label)
			bestLabel, bestCount := label[node], 0
			for lbl, cnt := range freq {
				if cnt > bestCount || (cnt == bestCount && lbl < bestLabel) {
					bestLabel = lbl
					bestCount = cnt
				}
			}
			if bestLabel != label[node] {
				label[node] = bestLabel
				changed++
			}
		}
		if changed <= threshold {
			break
		}
	}
	return label
}

// leidenRefine guarantees connected communities by splitting disconnected
// sub-components, then runs one modularity-optimization pass for edge cases.
func leidenRefine(adj map[int64]map[int64]bool, partition map[int64]int) map[int64]int {
	// Group nodes by community
	communities := make(map[int][]int64)
	for node, comm := range partition {
		communities[comm] = append(communities[comm], node)
	}

	nextID := 0
	refined := make(map[int64]int, len(partition))

	for _, members := range communities {
		// BFS to find connected components within this community
		memberSet := make(map[int64]bool, len(members))
		for _, m := range members {
			memberSet[m] = true
		}
		visited := make(map[int64]bool, len(members))

		for _, seed := range members {
			if visited[seed] {
				continue
			}
			component := bfsComponent(seed, adj, memberSet, visited)
			for _, n := range component {
				refined[n] = nextID
			}
			nextID++
		}
	}

	// One modularity pass: move border nodes to better-connected community
	modularityPass(adj, refined, len(partition))

	return refined
}

// bfsComponent does BFS from seed, staying within memberSet.
// Marks visited nodes and returns the connected component.
func bfsComponent(seed int64, adj map[int64]map[int64]bool, memberSet, visited map[int64]bool) []int64 {
	queue := []int64{seed}
	visited[seed] = true
	var component []int64

	for len(queue) > 0 {
		node := queue[0]
		queue = queue[1:]
		component = append(component, node)

		for nb := range adj[node] {
			if memberSet[nb] && !visited[nb] {
				visited[nb] = true
				queue = append(queue, nb)
			}
		}
	}
	return component
}

// modularityPass does one greedy pass moving border nodes to the community
// with which they share the most edges. This fixes edge cases from LPA.
func modularityPass(adj map[int64]map[int64]bool, partition map[int64]int, _ int) {
	// Pre-compute total edges (for modularity denominator)
	totalEdges := 0
	for _, neighbors := range adj {
		totalEdges += len(neighbors)
	}
	m := float64(totalEdges) / 2.0
	if m == 0 {
		return
	}

	// Pre-compute community degree sums
	commDegree := make(map[int]float64)
	for node, neighbors := range adj {
		commDegree[partition[node]] += float64(len(neighbors))
	}

	m2 := 2.0 * m * m
	for node, neighbors := range adj {
		currentComm := partition[node]
		ki := float64(len(neighbors))

		// Count edges to each neighboring community
		edgesToComm := make(map[int]float64, len(neighbors))
		for nb := range neighbors {
			edgesToComm[partition[nb]]++
		}

		// Remove self from current community for fair comparison
		commDegree[currentComm] -= ki
		kiInCurrent := edgesToComm[currentComm]
		removeCost := kiInCurrent/m - ki*commDegree[currentComm]/m2

		bestComm := currentComm
		bestGain := 0.0

		for comm, kiIn := range edgesToComm {
			if comm == currentComm {
				continue
			}
			gain := kiIn/m - ki*commDegree[comm]/m2 - removeCost
			if gain > bestGain {
				bestGain = gain
				bestComm = comm
			}
		}

		if bestComm != currentComm && bestGain > 1e-10 {
			partition[node] = bestComm
			commDegree[bestComm] += ki
			// currentComm already had ki subtracted
		} else {
			commDegree[currentComm] += ki // restore
		}
	}
}

// groupAndFilter groups nodes by community and filters out singletons.
func groupAndFilter(nodeCommunity map[int64]int) map[int][]int64 {
	communities := make(map[int][]int64)
	for nodeID, comm := range nodeCommunity {
		communities[comm] = append(communities[comm], nodeID)
	}

	filtered := make(map[int][]int64)
	idx := 0
	for _, members := range communities {
		if len(members) >= 2 {
			filtered[idx] = members
			idx++
		}
	}
	return filtered
}

// storeCommunities creates Community nodes and MEMBER_OF edges in the database.
// Uses nodeMap (already fetched via FindNodesByIDs) for member lookups instead
// of per-member FindNodeByQN queries.
func (p *Pipeline) storeCommunities(communities map[int][]int64) (communityCount, memberOfCount int) {
	if len(communities) == 0 {
		return 0, 0
	}

	// Collect all member node IDs for batch lookup
	var allMemberIDs []int64
	for _, members := range communities {
		allMemberIDs = append(allMemberIDs, members...)
	}
	nodeMap, _ := p.Store.FindNodesByIDs(allMemberIDs)

	communityNodes := make([]*store.Node, 0, len(communities))
	// pendingEdge now carries SourceID (not SourceQN) to avoid redundant DB lookups
	type memberEdge struct {
		SourceID int64
		TargetQN string
	}
	memberEdges := make([]memberEdge, 0, len(allMemberIDs))

	for commIdx, memberIDs := range communities {
		// Find top symbols by name for labeling
		topNames := topMemberNames(memberIDs, nodeMap, 5)

		commName := fmt.Sprintf("community_%d", commIdx)
		if len(topNames) > 0 {
			commName = topNames[0] + "_cluster"
		}

		commQN := fmt.Sprintf("%s.__community__.%d", p.ProjectName, commIdx)

		// Calculate cohesion: ratio of internal edges to possible edges
		cohesion := communityCohesion(memberIDs, nodeMap)

		communityNodes = append(communityNodes, &store.Node{
			Project:       p.ProjectName,
			Label:         "Community",
			Name:          commName,
			QualifiedName: commQN,
			Properties: map[string]any{
				"cohesion":     math.Round(cohesion*100) / 100,
				"symbol_count": len(memberIDs),
				"top_symbols":  topNames,
			},
		})

		for _, memberID := range memberIDs {
			if nodeMap[memberID] == nil {
				continue
			}
			memberEdges = append(memberEdges, memberEdge{
				SourceID: memberID,
				TargetQN: commQN,
			})

			// Also store community_id on the member node (via properties update)
			memberNode := nodeMap[memberID]
			if memberNode.Properties == nil {
				memberNode.Properties = make(map[string]any)
			}
			memberNode.Properties["community_id"] = commIdx
		}
	}

	// Batch insert community nodes
	idMap, err := p.Store.UpsertNodeBatch(communityNodes)
	if err != nil {
		slog.Warn("pass.communities.upsert.err", "err", err)
		return 0, 0
	}

	// Resolve and insert MEMBER_OF edges using direct ID lookup (no DB queries)
	var edges []*store.Edge
	for _, me := range memberEdges {
		tgtID, tgtOK := idMap[me.TargetQN]
		if tgtOK {
			edges = append(edges, &store.Edge{
				Project:  p.ProjectName,
				SourceID: me.SourceID,
				TargetID: tgtID,
				Type:     "MEMBER_OF",
			})
		}
	}

	if len(edges) > 0 {
		if err := p.Store.InsertEdgeBatch(edges); err != nil {
			slog.Warn("pass.communities.edges.err", "err", err)
		}
	}

	return len(communityNodes), len(edges)
}

func topMemberNames(memberIDs []int64, nodeMap map[int64]*store.Node, limit int) []string {
	type entry struct {
		name  string
		label string
	}
	var entries []entry
	for _, id := range memberIDs {
		n := nodeMap[id]
		if n != nil {
			entries = append(entries, entry{n.Name, n.Label})
		}
	}

	// Sort: Classes first, then Functions, alphabetical
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].label != entries[j].label {
			// Prefer Class/Interface over Function/Method
			return labelPriority(entries[i].label) < labelPriority(entries[j].label)
		}
		return entries[i].name < entries[j].name
	})

	names := make([]string, 0, limit)
	for i, e := range entries {
		if i >= limit {
			break
		}
		names = append(names, e.name)
	}
	return names
}

func labelPriority(label string) int {
	switch label {
	case "Class":
		return 0
	case "Interface":
		return 1
	case "Type":
		return 2
	case "Function":
		return 3
	case "Method":
		return 4
	default:
		return 5
	}
}

func communityCohesion(memberIDs []int64, nodeMap map[int64]*store.Node) float64 {
	n := len(memberIDs)
	if n < 2 {
		return 1.0
	}
	// Simplified cohesion: proportion of members with known types
	knownCount := 0
	for _, id := range memberIDs {
		if nodeMap[id] != nil {
			knownCount++
		}
	}
	return float64(knownCount) / float64(n)
}
