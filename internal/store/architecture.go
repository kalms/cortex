package store

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// ArchitectureInfo holds the result of a codebase architecture analysis.
type ArchitectureInfo struct {
	Languages   []LanguageCount    `json:"languages,omitempty"`
	Packages    []PackageSummary   `json:"packages,omitempty"`
	EntryPoints []EntryPointInfo   `json:"entry_points,omitempty"`
	Routes      []RouteInfo        `json:"routes,omitempty"`
	Hotspots    []HotspotFunction  `json:"hotspots,omitempty"`
	Boundaries  []CrossPkgBoundary `json:"boundaries,omitempty"`
	Services    []ServiceLink      `json:"services,omitempty"`
	Layers      []PackageLayer     `json:"layers,omitempty"`
	Clusters    []ClusterInfo      `json:"clusters,omitempty"`
	FileTree    []FileTreeEntry    `json:"file_tree,omitempty"`
}

// LanguageCount counts files per language.
type LanguageCount struct {
	Language  string `json:"language"`
	FileCount int    `json:"file_count"`
}

// PackageSummary summarizes a package with its connectivity.
type PackageSummary struct {
	Name      string `json:"name"`
	NodeCount int    `json:"node_count"`
	FanIn     int    `json:"fan_in"`
	FanOut    int    `json:"fan_out"`
}

// EntryPointInfo describes an entry point function.
type EntryPointInfo struct {
	Name          string `json:"name"`
	QualifiedName string `json:"qualified_name"`
	File          string `json:"file"`
}

// RouteInfo describes an HTTP route.
type RouteInfo struct {
	Method  string `json:"method"`
	Path    string `json:"path"`
	Handler string `json:"handler"`
}

// HotspotFunction is a function with high fan-in.
type HotspotFunction struct {
	Name          string `json:"name"`
	QualifiedName string `json:"qualified_name"`
	FanIn         int    `json:"fan_in"`
}

// CrossPkgBoundary represents cross-package call volume.
type CrossPkgBoundary struct {
	From      string `json:"from"`
	To        string `json:"to"`
	CallCount int    `json:"call_count"`
}

// ServiceLink represents a cross-service link (HTTP or async).
type ServiceLink struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Type  string `json:"type"`
	Count int    `json:"count"`
}

// PackageLayer classifies a package into an architectural layer.
type PackageLayer struct {
	Name   string `json:"name"`
	Layer  string `json:"layer"`
	Reason string `json:"reason"`
}

// ClusterInfo describes a community detected by the Louvain algorithm.
type ClusterInfo struct {
	ID        int      `json:"id"`
	Label     string   `json:"label"`
	Members   int      `json:"members"`
	Cohesion  float64  `json:"cohesion"`
	TopNodes  []string `json:"top_nodes"`
	Packages  []string `json:"packages"`
	EdgeTypes []string `json:"edge_types"`
}

// FileTreeEntry describes a node in the condensed file tree.
type FileTreeEntry struct {
	Path     string `json:"path"`
	Type     string `json:"type"`
	Children int    `json:"children"`
}

// buildAspectSet converts the aspects slice into a lookup set.
// An empty list or a list containing "all" means every aspect is wanted.
func buildAspectSet(aspects []string) map[string]bool {
	set := make(map[string]bool, len(aspects))
	for _, a := range aspects {
		set[a] = true
	}
	if len(set) == 0 || set["all"] {
		for _, name := range []string{
			"languages", "packages", "entry_points", "routes", "hotspots",
			"boundaries", "services", "layers", "clusters", "file_tree",
		} {
			set[name] = true
		}
	}
	return set
}

// fetchAspects dispatches each requested aspect to its query method.
func (s *Store) fetchAspects(project string, info *ArchitectureInfo, want map[string]bool) error {
	type aspectEntry struct {
		name string
		fn   func() error
	}
	entries := []aspectEntry{
		{"languages", func() error { var e error; info.Languages, e = s.archLanguages(project); return e }},
		{"packages", func() error { var e error; info.Packages, e = s.archPackages(project); return e }},
		{"entry_points", func() error { var e error; info.EntryPoints, e = s.archEntryPoints(project); return e }},
		{"routes", func() error { var e error; info.Routes, e = s.archRoutes(project); return e }},
		{"hotspots", func() error { var e error; info.Hotspots, e = s.archHotspots(project); return e }},
		{"boundaries", func() error { var e error; info.Boundaries, e = s.archBoundaries(project); return e }},
		{"services", func() error { var e error; info.Services, e = s.archServices(project); return e }},
		{"layers", func() error { var e error; info.Layers, e = s.archLayers(project); return e }},
		{"clusters", func() error { var e error; info.Clusters, e = s.archClusters(project); return e }},
		{"file_tree", func() error { var e error; info.FileTree, e = s.archFileTree(project); return e }},
	}
	for _, entry := range entries {
		if !want[entry.name] {
			continue
		}
		if err := entry.fn(); err != nil {
			return fmt.Errorf("%s: %w", entry.name, err)
		}
	}
	return nil
}

// GetArchitecture computes architecture aspects for a project.
// When aspects contains "all" or is empty, all aspects are computed.
func (s *Store) GetArchitecture(project string, aspects []string) (*ArchitectureInfo, error) {
	want := buildAspectSet(aspects)
	info := &ArchitectureInfo{}
	if err := s.fetchAspects(project, info, want); err != nil {
		return nil, err
	}
	return info, nil
}

// --- Aspect implementations ---

// extToLang maps file extensions to language names.
var extToLang = map[string]string{
	".py": "Python", ".go": "Go", ".js": "JavaScript", ".ts": "TypeScript",
	".tsx": "TypeScript", ".jsx": "JavaScript", ".rs": "Rust", ".java": "Java",
	".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".c": "C", ".h": "C",
	".cs": "C#", ".php": "PHP", ".lua": "Lua", ".scala": "Scala",
	".kt": "Kotlin", ".rb": "Ruby", ".sh": "Bash", ".bash": "Bash",
	".zig": "Zig", ".ex": "Elixir", ".exs": "Elixir", ".hs": "Haskell",
	".ml": "OCaml", ".mli": "OCaml", ".html": "HTML", ".css": "CSS",
	".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".hcl": "HCL",
	".tf": "HCL", ".sql": "SQL", ".erl": "Erlang", ".swift": "Swift",
	".dart": "Dart", ".groovy": "Groovy", ".pl": "Perl", ".r": "R",
	".scss": "SCSS", ".vue": "Vue", ".svelte": "Svelte",
}

func (s *Store) archLanguages(project string) ([]LanguageCount, error) {
	rows, err := s.q.Query(`SELECT file_path FROM nodes WHERE project=? AND label='File'`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := map[string]int{}
	for rows.Next() {
		var fp string
		if err := rows.Scan(&fp); err != nil {
			return nil, err
		}
		ext := strings.ToLower(filepath.Ext(fp))
		lang := extToLang[ext]
		if lang == "" {
			continue
		}
		counts[lang]++
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	result := make([]LanguageCount, 0, len(counts))
	for lang, cnt := range counts {
		result = append(result, LanguageCount{Language: lang, FileCount: cnt})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].FileCount > result[j].FileCount })
	if len(result) > 10 {
		result = result[:10]
	}
	return result, nil
}

func (s *Store) archPackages(project string) ([]PackageSummary, error) {
	// Get all packages with node counts
	rows, err := s.q.Query(`
		SELECT n.name, COUNT(*) as cnt
		FROM nodes n
		WHERE n.project=? AND n.label='Package'
		GROUP BY n.name
		ORDER BY cnt DESC LIMIT 15`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// First get package names
	type pkgRaw struct {
		name  string
		count int
	}
	var pkgs []pkgRaw
	for rows.Next() {
		var p pkgRaw
		if err := rows.Scan(&p.name, &p.count); err != nil {
			return nil, err
		}
		pkgs = append(pkgs, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Fallback: count nodes per QN prefix segment if no Package nodes
	if len(pkgs) == 0 {
		return s.archPackagesByQN(project)
	}

	result := make([]PackageSummary, len(pkgs))
	for i, p := range pkgs {
		result[i] = PackageSummary{Name: p.name, NodeCount: p.count}
	}
	return result, nil
}

// archPackagesByQN groups nodes by the sub-package segment of their qualified name.
func (s *Store) archPackagesByQN(project string) ([]PackageSummary, error) {
	rows, err := s.q.Query(`SELECT qualified_name FROM nodes WHERE project=? AND label IN ('Function','Method','Class')`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := map[string]int{}
	for rows.Next() {
		var qn string
		if err := rows.Scan(&qn); err != nil {
			return nil, err
		}
		pkg := qnToPackage(qn)
		if pkg == "" {
			continue
		}
		counts[pkg]++
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	result := make([]PackageSummary, 0, len(counts))
	for name, cnt := range counts {
		result = append(result, PackageSummary{Name: name, NodeCount: cnt})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].NodeCount > result[j].NodeCount })
	if len(result) > 15 {
		result = result[:15]
	}
	return result, nil
}

func (s *Store) archEntryPoints(project string) ([]EntryPointInfo, error) {
	rows, err := s.q.Query(`
		SELECT name, qualified_name, file_path FROM nodes
		WHERE project=? AND json_extract(properties, '$.is_entry_point') = 1
		AND (json_extract(properties, '$.is_test') IS NULL OR json_extract(properties, '$.is_test') != 1)
		AND file_path NOT LIKE '%test%'
		LIMIT 20`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []EntryPointInfo
	for rows.Next() {
		var ep EntryPointInfo
		if err := rows.Scan(&ep.Name, &ep.QualifiedName, &ep.File); err != nil {
			return nil, err
		}
		result = append(result, ep)
	}
	return result, rows.Err()
}

func (s *Store) archRoutes(project string) ([]RouteInfo, error) {
	rows, err := s.q.Query(`
		SELECT name, properties, COALESCE(file_path, '') FROM nodes
		WHERE project=? AND label='Route'
		AND (json_extract(properties, '$.is_test') IS NULL OR json_extract(properties, '$.is_test') != 1)
		LIMIT 20`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []RouteInfo
	for rows.Next() {
		var name, props, fp string
		if err := rows.Scan(&name, &props, &fp); err != nil {
			return nil, err
		}
		if isTestFilePath(fp) {
			continue
		}
		p := unmarshalProps(props)
		ri := RouteInfo{
			Path: name,
		}
		if m, ok := p["method"].(string); ok {
			ri.Method = m
		}
		if path, ok := p["path"].(string); ok {
			ri.Path = path
		}
		if h, ok := p["handler"].(string); ok {
			ri.Handler = h
		}
		result = append(result, ri)
	}
	return result, rows.Err()
}

func (s *Store) archHotspots(project string) ([]HotspotFunction, error) {
	rows, err := s.q.Query(`
		SELECT n.name, n.qualified_name, COUNT(*) as fan_in
		FROM nodes n
		JOIN edges e ON e.target_id = n.id AND e.type = 'CALLS'
		WHERE n.project=? AND n.label IN ('Function', 'Method')
		AND (json_extract(n.properties, '$.is_test') IS NULL OR json_extract(n.properties, '$.is_test') != 1)
		AND n.file_path NOT LIKE '%test%'
		GROUP BY n.id
		ORDER BY fan_in DESC
		LIMIT 10`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []HotspotFunction
	for rows.Next() {
		var h HotspotFunction
		if err := rows.Scan(&h.Name, &h.QualifiedName, &h.FanIn); err != nil {
			return nil, err
		}
		result = append(result, h)
	}
	return result, rows.Err()
}

func (s *Store) archBoundaries(project string) ([]CrossPkgBoundary, error) {
	// Build node ID → package name map via QN prefix (only callable nodes)
	nodeRows, err := s.q.Query(`SELECT id, qualified_name FROM nodes WHERE project=? AND label IN ('Function','Method','Class')`, project)
	if err != nil {
		return nil, err
	}
	defer nodeRows.Close()

	nodePkg := map[int64]string{}
	for nodeRows.Next() {
		var id int64
		var qn string
		if err := nodeRows.Scan(&id, &qn); err != nil {
			return nil, err
		}
		nodePkg[id] = qnToPackage(qn)
	}
	if err := nodeRows.Err(); err != nil {
		return nil, err
	}

	// Single-pass edge scan grouping cross-package calls
	edgeRows, err := s.q.Query(`SELECT source_id, target_id FROM edges WHERE project=? AND type='CALLS'`, project)
	if err != nil {
		return nil, err
	}
	defer edgeRows.Close()

	type boundaryKey struct{ from, to string }
	counts := map[boundaryKey]int{}
	for edgeRows.Next() {
		var srcID, tgtID int64
		if err := edgeRows.Scan(&srcID, &tgtID); err != nil {
			return nil, err
		}
		srcPkg := nodePkg[srcID]
		tgtPkg := nodePkg[tgtID]
		if srcPkg != tgtPkg && srcPkg != "" && tgtPkg != "" {
			counts[boundaryKey{srcPkg, tgtPkg}]++
		}
	}
	if err := edgeRows.Err(); err != nil {
		return nil, err
	}

	result := make([]CrossPkgBoundary, 0, len(counts))
	for k, cnt := range counts {
		result = append(result, CrossPkgBoundary{From: k.from, To: k.to, CallCount: cnt})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CallCount > result[j].CallCount })
	if len(result) > 10 {
		result = result[:10]
	}
	return result, nil
}

func (s *Store) archServices(project string) ([]ServiceLink, error) {
	// Build node ID → top-level package map first (before opening edge cursor)
	nodePkg, err := s.loadNodePackageMap(project)
	if err != nil {
		return nil, err
	}

	// Query edges
	type linkKey struct{ from, to, typ string }
	counts := map[linkKey]int{}

	edgeRows, err := s.q.Query(`
		SELECT source_id, target_id, type
		FROM edges WHERE project=? AND type IN ('HTTP_CALLS', 'ASYNC_CALLS')`, project)
	if err != nil {
		return nil, err
	}
	defer edgeRows.Close()

	for edgeRows.Next() {
		var srcID, tgtID int64
		var edgeType string
		if err := edgeRows.Scan(&srcID, &tgtID, &edgeType); err != nil {
			return nil, err
		}
		from := nodePkg[srcID]
		to := nodePkg[tgtID]
		if from != "" && to != "" {
			counts[linkKey{from, to, edgeType}]++
		}
	}
	if err := edgeRows.Err(); err != nil {
		return nil, err
	}

	result := make([]ServiceLink, 0, len(counts))
	for k, cnt := range counts {
		result = append(result, ServiceLink{From: k.from, To: k.to, Type: k.typ, Count: cnt})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Count > result[j].Count })
	if len(result) > 10 {
		result = result[:10]
	}
	return result, nil
}

func (s *Store) archLayers(project string) ([]PackageLayer, error) {
	// Get boundaries for fan-in/out analysis
	boundaries, err := s.archBoundaries(project)
	if err != nil {
		return nil, err
	}

	// Check which packages have Route nodes
	routePkgs := map[string]bool{}
	routeRows, err := s.q.Query(`SELECT qualified_name FROM nodes WHERE project=? AND label='Route'`, project)
	if err != nil {
		return nil, err
	}
	defer routeRows.Close()
	for routeRows.Next() {
		var qn string
		if err := routeRows.Scan(&qn); err != nil {
			return nil, err
		}
		routePkgs[qnToPackage(qn)] = true
	}
	if err := routeRows.Err(); err != nil {
		return nil, err
	}

	// Check which packages have entry points
	entryPkgs := map[string]bool{}
	entryRows, err := s.q.Query(`
		SELECT qualified_name FROM nodes
		WHERE project=? AND json_extract(properties, '$.is_entry_point') = 1`, project)
	if err != nil {
		return nil, err
	}
	defer entryRows.Close()
	for entryRows.Next() {
		var qn string
		if err := entryRows.Scan(&qn); err != nil {
			return nil, err
		}
		entryPkgs[qnToPackage(qn)] = true
	}
	if err := entryRows.Err(); err != nil {
		return nil, err
	}

	// Compute fan-in/out per package from boundaries
	fanIn := map[string]int{}
	fanOut := map[string]int{}
	allPkgs := map[string]bool{}
	for _, b := range boundaries {
		fanOut[b.From] += b.CallCount
		fanIn[b.To] += b.CallCount
		allPkgs[b.From] = true
		allPkgs[b.To] = true
	}

	// Also include packages from entry points and routes
	for pkg := range entryPkgs {
		allPkgs[pkg] = true
	}
	for pkg := range routePkgs {
		allPkgs[pkg] = true
	}

	var result []PackageLayer
	for pkg := range allPkgs {
		layer, reason := classifyLayer(pkg, fanIn[pkg], fanOut[pkg], routePkgs[pkg], entryPkgs[pkg])
		result = append(result, PackageLayer{Name: pkg, Layer: layer, Reason: reason})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func classifyLayer(_ string, in, out int, hasRoutes, hasEntryPoints bool) (layer, reason string) {
	if hasEntryPoints && out > 0 && in == 0 {
		return "entry", "has entry points, only outbound calls"
	}
	if hasRoutes {
		return "api", "has HTTP route definitions"
	}
	if in > out && in > 3 {
		return "core", fmt.Sprintf("high fan-in (%d in, %d out)", in, out)
	}
	if out == 0 && in > 0 {
		return "leaf", "only inbound calls, no outbound"
	}
	if in == 0 && out > 0 {
		return "entry", "only outbound calls"
	}
	return "internal", fmt.Sprintf("fan-in=%d, fan-out=%d", in, out)
}

// clusterNodeInfo holds node metadata for the clustering algorithm.
type clusterNodeInfo struct {
	id   int64
	name string
	qn   string
}

func (s *Store) archClusters(project string) ([]ClusterInfo, error) {
	// Load all function/method nodes
	nodeRows, err := s.q.Query(`SELECT id, name, qualified_name FROM nodes WHERE project=? AND label IN ('Function', 'Method')`, project)
	if err != nil {
		return nil, err
	}
	defer nodeRows.Close()

	var nodeList []clusterNodeInfo
	nodeIDSet := map[int64]bool{}
	for nodeRows.Next() {
		var ni clusterNodeInfo
		if err := nodeRows.Scan(&ni.id, &ni.name, &ni.qn); err != nil {
			return nil, err
		}
		nodeList = append(nodeList, ni)
		nodeIDSet[ni.id] = true
	}
	if err := nodeRows.Err(); err != nil {
		return nil, err
	}

	if len(nodeList) < 3 {
		return nil, nil // too few nodes for meaningful clustering
	}

	// Load edges (CALLS + HTTP_CALLS + ASYNC_CALLS)
	edgeRows, err := s.q.Query(`
		SELECT source_id, target_id, type FROM edges
		WHERE project=? AND type IN ('CALLS', 'HTTP_CALLS', 'ASYNC_CALLS')`, project)
	if err != nil {
		return nil, err
	}
	defer edgeRows.Close()

	var edges []louvainEdge
	for edgeRows.Next() {
		var e louvainEdge
		if err := edgeRows.Scan(&e.src, &e.dst, &e.edgeType); err != nil {
			return nil, err
		}
		// Only include edges between function/method nodes
		if nodeIDSet[e.src] && nodeIDSet[e.dst] {
			edges = append(edges, e)
		}
	}
	if err := edgeRows.Err(); err != nil {
		return nil, err
	}

	if len(edges) < 3 {
		return nil, nil
	}

	// Build node ID list
	nodeIDs := make([]int64, len(nodeList))
	for i, ni := range nodeList {
		nodeIDs[i] = ni.id
	}

	// Run Louvain algorithm
	partition := louvain(nodeIDs, edges)

	// Build lookup maps
	nodeByID := map[int64]clusterNodeInfo{}
	for _, ni := range nodeList {
		nodeByID[ni.id] = ni
	}

	// Group nodes by community
	communities := map[int][]int64{}
	for nodeID, comm := range partition {
		communities[comm] = append(communities[comm], nodeID)
	}

	// Build edge type sets per community
	commEdgeTypes := map[int]map[string]bool{}
	for _, e := range edges {
		srcComm := partition[e.src]
		dstComm := partition[e.dst]
		if srcComm == dstComm {
			if commEdgeTypes[srcComm] == nil {
				commEdgeTypes[srcComm] = map[string]bool{}
			}
			commEdgeTypes[srcComm][e.edgeType] = true
		}
	}

	// Compute fan-in per node for ranking
	fanIn := map[int64]int{}
	for _, e := range edges {
		fanIn[e.dst]++
	}

	clusters := buildClusterInfos(communities, edges, commEdgeTypes, fanIn, nodeByID)
	return clusters, nil
}

// buildClusterInfos converts community assignments into sorted, capped ClusterInfo slices.
func buildClusterInfos(communities map[int][]int64, edges []louvainEdge, commEdgeTypes map[int]map[string]bool, fanIn map[int64]int, nodeByID map[int64]clusterNodeInfo) []ClusterInfo {
	var clusters []ClusterInfo
	for commID, members := range communities {
		if len(members) < 2 {
			continue
		}
		ci := buildOneCluster(commID, members, edges, commEdgeTypes[commID], fanIn, nodeByID)
		clusters = append(clusters, ci)
	}
	sort.Slice(clusters, func(i, j int) bool { return clusters[i].Members > clusters[j].Members })
	if len(clusters) > 15 {
		clusters = clusters[:15]
	}
	for i := range clusters {
		clusters[i].ID = i + 1
	}
	return clusters
}

// buildOneCluster computes a ClusterInfo for a single community.
func buildOneCluster(commID int, members []int64, edges []louvainEdge, edgeTypes map[string]bool, fanIn map[int64]int, nodeByID map[int64]clusterNodeInfo) ClusterInfo {
	memberSet := map[int64]bool{}
	for _, id := range members {
		memberSet[id] = true
	}

	var internalEdges, totalEdges int
	for _, e := range edges {
		isSrc := memberSet[e.src]
		isDst := memberSet[e.dst]
		if isSrc || isDst {
			totalEdges++
		}
		if isSrc && isDst {
			internalEdges++
		}
	}
	cohesion := 0.0
	if totalEdges > 0 {
		cohesion = float64(internalEdges) / float64(totalEdges)
	}

	sort.Slice(members, func(i, j int) bool { return fanIn[members[i]] > fanIn[members[j]] })
	topN := 5
	if len(members) < topN {
		topN = len(members)
	}
	topNodes := make([]string, topN)
	for i := 0; i < topN; i++ {
		topNodes[i] = nodeByID[members[i]].name
	}

	pkgSet := map[string]bool{}
	for _, id := range members {
		if pkg := qnToPackage(nodeByID[id].qn); pkg != "" {
			pkgSet[pkg] = true
		}
	}
	pkgs := make([]string, 0, len(pkgSet))
	for pkg := range pkgSet {
		pkgs = append(pkgs, pkg)
	}
	sort.Strings(pkgs)

	etypes := make([]string, 0, len(edgeTypes))
	for et := range edgeTypes {
		etypes = append(etypes, et)
	}
	sort.Strings(etypes)

	return ClusterInfo{
		ID:        commID,
		Label:     autoNameCluster(members, nodeByID),
		Members:   len(members),
		Cohesion:  cohesion,
		TopNodes:  topNodes,
		Packages:  pkgs,
		EdgeTypes: etypes,
	}
}

func autoNameCluster(members []int64, nodeByID map[int64]clusterNodeInfo) string {
	pkgCounts := map[string]int{}
	for _, id := range members {
		pkg := qnToPackage(nodeByID[id].qn)
		if pkg != "" {
			pkgCounts[pkg]++
		}
	}
	bestPkg := ""
	bestCount := 0
	for pkg, cnt := range pkgCounts {
		if cnt > bestCount {
			bestPkg = pkg
			bestCount = cnt
		}
	}
	if bestPkg != "" {
		return bestPkg
	}
	return fmt.Sprintf("cluster-%d", len(members))
}

func (s *Store) archFileTree(project string) ([]FileTreeEntry, error) {
	rows, err := s.q.Query(`SELECT file_path FROM nodes WHERE project=? AND label='File'`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	dirChildren := map[string]map[string]bool{}
	fileSet := map[string]bool{}

	for rows.Next() {
		var fp string
		if err := rows.Scan(&fp); err != nil {
			return nil, err
		}
		fileSet[fp] = true
		registerFilePath(fp, dirChildren)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	result := collectTreeEntries(dirChildren, fileSet)
	sort.Slice(result, func(i, j int) bool { return result[i].Path < result[j].Path })
	return result, nil
}

// registerFilePath registers a file path in the directory tree up to 3 levels deep.
func registerFilePath(fp string, dirChildren map[string]map[string]bool) {
	parts := strings.Split(fp, "/")
	for depth := 0; depth < len(parts)-1 && depth < 3; depth++ {
		dir := strings.Join(parts[:depth+1], "/")
		child := ""
		if depth+1 < len(parts) {
			child = parts[depth+1]
		}
		if dirChildren[dir] == nil {
			dirChildren[dir] = map[string]bool{}
		}
		if child != "" {
			dirChildren[dir][child] = true
		}
	}
	if len(parts) > 0 {
		if dirChildren[""] == nil {
			dirChildren[""] = map[string]bool{}
		}
		dirChildren[""][parts[0]] = true
	}
}

// collectTreeEntries builds FileTreeEntry slices from the directory map.
func collectTreeEntries(dirChildren map[string]map[string]bool, fileSet map[string]bool) []FileTreeEntry {
	var result []FileTreeEntry
	if rootChildren, ok := dirChildren[""]; ok {
		for child := range rootChildren {
			entryType := "dir"
			if fileSet[child] {
				entryType = "file"
			}
			result = append(result, FileTreeEntry{Path: child, Type: entryType, Children: len(dirChildren[child])})
		}
	}
	for dir, children := range dirChildren {
		if dir == "" || strings.Count(dir, "/") >= 3 {
			continue
		}
		for child := range children {
			path := dir + "/" + child
			entryType := "dir"
			if fileSet[path] {
				entryType = "file"
			}
			result = append(result, FileTreeEntry{Path: path, Type: entryType, Children: len(dirChildren[path])})
		}
	}
	return result
}

// --- Helpers ---

// loadNodePackageMap returns nodeID → top-level package for all nodes in a project.
func (s *Store) loadNodePackageMap(project string) (map[int64]string, error) {
	nodePkg := map[int64]string{}
	rows, err := s.q.Query(`SELECT id, qualified_name FROM nodes WHERE project=?`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var qn string
		if err := rows.Scan(&id, &qn); err != nil {
			return nil, err
		}
		nodePkg[id] = qnToTopPackage(qn)
	}
	return nodePkg, rows.Err()
}

// qnToPackage extracts the meaningful sub-package from a qualified name.
// QN format: project.dir1.dir2.filestem.Symbol — segment[2] is the sub-package.
// For shallow layouts (project.dir.symbol), falls back to segment[1].
func qnToPackage(qn string) string {
	parts := strings.SplitN(qn, ".", 5)
	if len(parts) >= 4 {
		return parts[2] // sub-package (e.g., "store" from "project.internal.store.search.Search")
	}
	if len(parts) >= 2 {
		return parts[1] // flat layout fallback
	}
	return ""
}

// qnToTopPackage extracts the top-level directory from a qualified name (segment[1]).
// Used for coarse-grained grouping in service detection.
func qnToTopPackage(qn string) string {
	parts := strings.SplitN(qn, ".", 3)
	if len(parts) >= 2 {
		return parts[1]
	}
	return ""
}

// --- Architecture Decision Record (ADR) ---

// maxADRLength is the maximum allowed length for an ADR in characters.
const maxADRLength = 8000

// MaxADRLength returns the maximum allowed ADR length for use by tool handlers.
func MaxADRLength() int { return maxADRLength }

// canonicalSections defines the fixed set of ADR section headers in canonical order.
var canonicalSections = []string{"PURPOSE", "STACK", "ARCHITECTURE", "PATTERNS", "TRADEOFFS", "PHILOSOPHY"}

// canonicalSet is a lookup for canonical section names.
var canonicalSet = map[string]bool{
	"PURPOSE": true, "STACK": true, "ARCHITECTURE": true,
	"PATTERNS": true, "TRADEOFFS": true, "PHILOSOPHY": true,
}

// ValidateADRContent checks that content contains all 6 canonical sections.
// Returns an error listing any missing sections.
func ValidateADRContent(content string) error {
	sections := ParseADRSections(content)
	var missing []string
	for _, name := range canonicalSections {
		if _, ok := sections[name]; !ok {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing required sections: %s. All 6 required: %s",
			strings.Join(missing, ", "), strings.Join(canonicalSections, ", "))
	}
	return nil
}

// ValidateADRSectionKeys checks that all keys in the map are canonical section names.
// Returns an error listing any invalid keys.
func ValidateADRSectionKeys(sections map[string]string) error {
	var invalid []string
	for k := range sections {
		if !canonicalSet[k] {
			invalid = append(invalid, k)
		}
	}
	if len(invalid) > 0 {
		sort.Strings(invalid)
		return fmt.Errorf("invalid section names: %s. Valid sections: %s",
			strings.Join(invalid, ", "), strings.Join(canonicalSections, ", "))
	}
	return nil
}

// CanonicalSectionNames returns the ordered list of canonical ADR section names.
func CanonicalSectionNames() []string { return canonicalSections }

// ADRecord holds a stored Architecture Decision Record.
type ADRecord struct {
	Project   string `json:"project"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// StoreADR persists an ADR (upsert). The source_hash column is kept as a dead
// column to avoid ALTER TABLE issues — we write an empty string.
func (s *Store) StoreADR(project, content string) error {
	now := Now()
	_, err := s.q.Exec(`
		INSERT INTO project_summaries (project, summary, source_hash, created_at, updated_at)
		VALUES (?, ?, '', ?, ?)
		ON CONFLICT(project) DO UPDATE SET
			summary = excluded.summary,
			updated_at = excluded.updated_at`,
		project, content, now, now)
	return err
}

// GetADR retrieves a stored ADR for a project.
func (s *Store) GetADR(project string) (*ADRecord, error) {
	row := s.q.QueryRow(`SELECT project, summary, created_at, updated_at FROM project_summaries WHERE project=?`, project)
	var r ADRecord
	if err := row.Scan(&r.Project, &r.Content, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

// DeleteADR removes a stored ADR for a project.
func (s *Store) DeleteADR(project string) error {
	res, err := s.q.Exec(`DELETE FROM project_summaries WHERE project=?`, project)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("no ADR found for project %q", project)
	}
	return nil
}

// UpdateADRSections merges the provided sections into the existing ADR.
// Unmentioned sections are preserved. Returns the updated record.
// Returns an error if the merged content exceeds maxADRLength.
func (s *Store) UpdateADRSections(project string, sections map[string]string) (*ADRecord, error) {
	existing, err := s.GetADR(project)
	if err != nil {
		return nil, fmt.Errorf("no existing ADR to update: %w", err)
	}

	parsed := ParseADRSections(existing.Content)
	for k, v := range sections {
		parsed[k] = v
	}

	merged := RenderADR(parsed)
	if len(merged) > maxADRLength {
		return nil, fmt.Errorf("merged ADR exceeds %d chars (%d chars); reduce section content before updating", maxADRLength, len(merged))
	}

	if err := s.StoreADR(project, merged); err != nil {
		return nil, err
	}

	return s.GetADR(project)
}

// ParseADRSections splits ADR content by canonical section headers.
// Only canonical headers (PURPOSE, STACK, ARCHITECTURE, PATTERNS, TRADEOFFS, PHILOSOPHY)
// are recognized as split boundaries. Other ## headers within content are treated as
// literal text within the current section.
func ParseADRSections(content string) map[string]string {
	sections := make(map[string]string)
	if content == "" {
		return sections
	}

	lines := strings.Split(content, "\n")
	currentSection := ""
	var currentContent []string

	for _, line := range lines {
		if strings.HasPrefix(line, "## ") {
			header := strings.TrimSpace(strings.TrimPrefix(line, "## "))
			if canonicalSet[header] {
				if currentSection != "" {
					sections[currentSection] = strings.TrimSpace(strings.Join(currentContent, "\n"))
				}
				currentSection = header
				currentContent = nil
				continue
			}
		}
		currentContent = append(currentContent, line)
	}

	if currentSection != "" {
		sections[currentSection] = strings.TrimSpace(strings.Join(currentContent, "\n"))
	}

	return sections
}

// RenderADR joins sections into markdown with canonical sections first (in order),
// followed by any non-canonical sections alphabetically.
func RenderADR(sections map[string]string) string {
	var parts []string
	rendered := make(map[string]bool)

	// Canonical sections first, in order
	for _, name := range canonicalSections {
		if content, ok := sections[name]; ok {
			parts = append(parts, "## "+name+"\n"+content)
			rendered[name] = true
		}
	}

	// Non-canonical sections alphabetically
	var extra []string
	for name := range sections {
		if !rendered[name] {
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	for _, name := range extra {
		parts = append(parts, "## "+name+"\n"+sections[name])
	}

	return strings.Join(parts, "\n\n")
}

// isTestFilePath returns true if the file path appears to be in a test directory.
// Used as a fallback for nodes that may not have the is_test property set.
func isTestFilePath(fp string) bool {
	return fp != "" && strings.Contains(fp, "test")
}

// FindArchitectureDocs discovers existing architecture documentation files in a project.
// Returns file paths matching common architecture doc patterns.
func (s *Store) FindArchitectureDocs(project string) ([]string, error) {
	rows, err := s.q.Query(`
		SELECT file_path FROM nodes
		WHERE project=? AND label='File'
		AND (
			file_path LIKE '%ARCHITECTURE.md' OR
			file_path LIKE '%ADR.md' OR
			file_path LIKE '%DECISIONS.md' OR
			file_path LIKE 'docs/adr/%' OR
			file_path LIKE 'doc/adr/%' OR
			file_path LIKE 'adr/%'
		)
		ORDER BY file_path LIMIT 20`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var docs []string
	for rows.Next() {
		var fp string
		if err := rows.Scan(&fp); err != nil {
			return nil, err
		}
		docs = append(docs, fp)
	}
	return docs, rows.Err()
}
