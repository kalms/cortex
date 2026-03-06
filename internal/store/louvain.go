package store

import "math/rand" // WHY: graph algorithm randomness — not cryptographic use, math/rand is correct here

// louvainEdge represents an edge for the Louvain algorithm.
type louvainEdge struct {
	src      int64
	dst      int64
	edgeType string // for post-processing only
}

// louvain implements community detection using the Louvain algorithm.
// Input: node IDs + edges (treated as undirected).
// Output: map[nodeID] → communityID.
func louvain(nodes []int64, edges []louvainEdge) map[int64]int {
	const resolution = 1.0
	if len(nodes) == 0 {
		return map[int64]int{}
	}

	// Build compact index: nodeID → sequential index
	idxOf := make(map[int64]int, len(nodes))
	for i, id := range nodes {
		idxOf[id] = i
	}
	n := len(nodes)

	// Build adjacency list (undirected, weighted by edge count)
	adj := make([][]int, n)
	weight := make([][]float64, n)
	totalWeight := 0.0

	edgeWeight := map[[2]int]float64{}
	for _, e := range edges {
		si, ok1 := idxOf[e.src]
		di, ok2 := idxOf[e.dst]
		if !ok1 || !ok2 || si == di {
			continue
		}
		key := [2]int{si, di}
		if si > di {
			key = [2]int{di, si}
		}
		edgeWeight[key]++
	}

	for key, w := range edgeWeight {
		si, di := key[0], key[1]
		adj[si] = append(adj[si], di)
		weight[si] = append(weight[si], w)
		adj[di] = append(adj[di], si)
		weight[di] = append(weight[di], w)
		totalWeight += w
	}

	if totalWeight == 0 {
		// No edges: each node is its own community
		result := make(map[int64]int, n)
		for i, id := range nodes {
			result[id] = i
		}
		return result
	}

	// Initialize: each node in its own community
	community := make([]int, n)
	for i := range community {
		community[i] = i
	}

	// Degree (weighted sum for each node)
	degree := make([]float64, n)
	for i := 0; i < n; i++ {
		for _, w := range weight[i] {
			degree[i] += w
		}
	}

	// Main Louvain loop
	maxIter := 10
	for iter := 0; iter < maxIter; iter++ {
		improved := louvainLocalMoving(n, adj, weight, degree, community, totalWeight, resolution)
		louvainRefine(n, adj, weight, degree, community, totalWeight, resolution)

		if !improved {
			break
		}
	}

	// Map back to original IDs
	result := make(map[int64]int, n)
	for i, id := range nodes {
		result[id] = community[i]
	}
	return result
}

// louvainLocalMoving greedily moves each node to the community that maximizes modularity gain.
// Returns true if any node was moved.
func louvainLocalMoving(n int, adj [][]int, weight [][]float64, degree []float64, community []int, totalWeight, resolution float64) bool {
	improved := false

	// Community total degree
	commDegree := make(map[int]float64)
	for i := 0; i < n; i++ {
		commDegree[community[i]] += degree[i]
	}

	// Random order for convergence stability
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	rand.Shuffle(n, func(i, j int) { order[i], order[j] = order[j], order[i] })

	for _, i := range order {
		curComm := community[i]

		// Compute weights to each neighboring community
		neighborComm := map[int]float64{}
		for j, neighbor := range adj[i] {
			nc := community[neighbor]
			neighborComm[nc] += weight[i][j]
		}

		// Remove node from its community
		commDegree[curComm] -= degree[i]

		bestComm := curComm
		bestGain := 0.0

		for comm, wIn := range neighborComm {
			// Modularity gain formula
			gain := wIn - resolution*degree[i]*commDegree[comm]/(2*totalWeight)
			if gain > bestGain {
				bestGain = gain
				bestComm = comm
			}
		}

		// Also consider staying in current community
		wInCur := neighborComm[curComm]
		curGain := wInCur - resolution*degree[i]*commDegree[curComm]/(2*totalWeight)
		if curGain >= bestGain {
			bestComm = curComm
		}

		community[i] = bestComm
		commDegree[bestComm] += degree[i]

		if bestComm != curComm {
			improved = true
		}
	}

	return improved
}

// louvainRefine checks each community for well-connectedness and potentially splits
// poorly-connected ones.
func louvainRefine(n int, adj [][]int, weight [][]float64, degree []float64, community []int, totalWeight, resolution float64) {
	commMembers := map[int][]int{}
	for i := 0; i < n; i++ {
		commMembers[community[i]] = append(commMembers[community[i]], i)
	}
	for _, members := range commMembers {
		if len(members) <= 2 {
			continue
		}
		refineCommunity(members, adj, weight, degree, community, n, totalWeight, resolution)
	}
}

// refineCommunity checks one community for well-connectedness and splits if density is too low.
func refineCommunity(members []int, adj [][]int, weight [][]float64, degree []float64, community []int, n int, totalWeight, resolution float64) {
	memberSet := map[int]bool{}
	for _, m := range members {
		memberSet[m] = true
	}

	var internalWeight float64
	for _, m := range members {
		for j, neighbor := range adj[m] {
			if memberSet[neighbor] {
				internalWeight += weight[m][j]
			}
		}
	}
	internalWeight /= 2 // each edge counted twice

	maxInternal := float64(len(members)*(len(members)-1)) / 2
	if maxInternal == 0 {
		return
	}
	density := internalWeight / maxInternal
	if density >= 0.01 || len(members) <= 5 {
		return
	}

	nextComm := maxCommunity(community, n) + 1
	for _, m := range members {
		var wInternal float64
		for j, neighbor := range adj[m] {
			if memberSet[neighbor] {
				wInternal += weight[m][j]
			}
		}
		expectedInternal := resolution * degree[m] * (internalWeight * 2 / totalWeight)
		if wInternal < expectedInternal*0.5 {
			community[m] = nextComm
			nextComm++
		}
	}
}

func maxCommunity(community []int, n int) int {
	maxVal := 0
	for i := 0; i < n; i++ {
		if community[i] > maxVal {
			maxVal = community[i]
		}
	}
	return maxVal
}
