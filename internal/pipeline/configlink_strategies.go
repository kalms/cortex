package pipeline

import (
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/DeusData/codebase-memory-mcp/internal/cbm"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// configExtensions are file extensions considered "config files".
var configExtensions = map[string]bool{
	".env": true, ".toml": true, ".ini": true, ".yaml": true, ".yml": true,
	".cfg": true, ".properties": true, ".json": true, ".xml": true, ".conf": true,
}

// manifestFiles are package manifest filenames used for dependency→import linking.
var manifestFiles = map[string]bool{
	"Cargo.toml": true, "package.json": true, "go.mod": true,
	"requirements.txt": true, "Gemfile": true, "build.gradle": true,
	"pom.xml": true, "composer.json": true,
}

// depSectionNames are section/key names that indicate dependency lists.
var depSectionNames = map[string]bool{
	"dependencies": true, "devDependencies": true, "peerDependencies": true,
	"dev-dependencies": true, "build-dependencies": true,
}

// configFileRefRe matches string literals referencing config files.
var configFileRefRe = regexp.MustCompile(
	`["']([^"']*\.(toml|yaml|yml|ini|json|xml|conf|cfg|env))["']`)

// passConfigLinker runs 3 post-flush strategies to link config↔code.
func (p *Pipeline) passConfigLinker() {
	t := time.Now()
	t1 := time.Now()
	keyEdges := p.matchConfigKeySymbols()
	slog.Info("configlinker.strategy", "name", "key_symbol", "edges", len(keyEdges), "elapsed", time.Since(t1))

	t2 := time.Now()
	depEdges := p.matchDependencyImports()
	slog.Info("configlinker.strategy", "name", "dep_import", "edges", len(depEdges), "elapsed", time.Since(t2))

	t3 := time.Now()
	refEdges := p.matchConfigFileRefs()
	slog.Info("configlinker.strategy", "name", "file_ref", "edges", len(refEdges), "elapsed", time.Since(t3))

	all := make([]*store.Edge, 0, len(keyEdges)+len(depEdges)+len(refEdges))
	all = append(all, keyEdges...)
	all = append(all, depEdges...)
	all = append(all, refEdges...)

	if len(all) > 0 {
		if err := p.Store.InsertEdgeBatch(all); err != nil {
			slog.Warn("configlinker.write_err", "err", err)
		}
	}

	slog.Info("configlinker.done",
		"key_symbol", len(keyEdges),
		"dep_import", len(depEdges),
		"file_ref", len(refEdges),
		"total", len(all),
		"elapsed", time.Since(t))
}

// --- Strategy 1: Config Key → Code Symbol ---

// normalizeConfigKey splits a config key on camelCase, underscores, dots, hyphens,
// lowercases all tokens, and joins with underscore.
func normalizeConfigKey(key string) (normalized string, tokens []string) {
	// Split on non-alphanumeric chars first
	parts := strings.FieldsFunc(key, func(r rune) bool {
		return r == '_' || r == '-' || r == '.'
	})

	for _, part := range parts {
		camel := splitCamelCase(part)
		for _, w := range camel {
			tokens = append(tokens, strings.ToLower(w))
		}
	}

	normalized = strings.Join(tokens, "_")
	return
}

// configEntry pairs a config node with its normalized key.
type configEntry struct {
	node       *store.Node
	normalized string
}

// collectConfigEntries returns config Variable nodes with min 2 tokens, each ≥3 chars.
func collectConfigEntries(vars []*store.Node) []configEntry {
	var entries []configEntry
	for _, v := range vars {
		if !hasConfigExtension(v.FilePath) {
			continue
		}
		norm, tokens := normalizeConfigKey(v.Name)
		if len(tokens) < 2 {
			continue
		}
		allLong := true
		for _, t := range tokens {
			if len(t) < 3 {
				allLong = false
				break
			}
		}
		if allLong {
			entries = append(entries, configEntry{node: v, normalized: norm})
		}
	}
	return entries
}

// collectCodeNodes returns Function/Variable/Class nodes not from config files.
func (p *Pipeline) collectCodeNodes() []*store.Node {
	var codeNodes []*store.Node
	for _, label := range []string{"Function", "Variable", "Class"} {
		nodes, err := p.Store.FindNodesByLabel(p.ProjectName, label)
		if err != nil {
			continue
		}
		for _, n := range nodes {
			if !hasConfigExtension(n.FilePath) {
				codeNodes = append(codeNodes, n)
			}
		}
	}
	return codeNodes
}

// matchConfigKeySymbols links config Variable nodes to code symbols when
// the normalized config key is a contiguous substring of the normalized code name.
// Pre-normalizes all code node names in O(n) to avoid O(n×m) normalizeConfigKey calls.
func (p *Pipeline) matchConfigKeySymbols() []*store.Edge {
	configVars, err := p.Store.FindNodesByLabel(p.ProjectName, "Variable")
	if err != nil {
		return nil
	}

	entries := collectConfigEntries(configVars)
	if len(entries) == 0 {
		return nil
	}

	codeNodes := p.collectCodeNodes()

	// Pre-normalize: build map[normalizedName] → []*store.Node (single O(n) pass)
	codeByNorm := make(map[string][]*store.Node, len(codeNodes))
	for _, code := range codeNodes {
		norm, _ := normalizeConfigKey(code.Name)
		if norm != "" {
			codeByNorm[norm] = append(codeByNorm[norm], code)
		}
	}
	slog.Info("configlinker.key_symbol.stats",
		"config_entries", len(entries),
		"code_nodes", len(codeNodes),
		"unique_norms", len(codeByNorm))

	var edges []*store.Edge

	// Exact match: O(1) lookup per config entry.
	for _, ce := range entries {
		if matches, ok := codeByNorm[ce.normalized]; ok {
			for _, code := range matches {
				edges = append(edges, &store.Edge{
					Project:  p.ProjectName,
					SourceID: code.ID,
					TargetID: ce.node.ID,
					Type:     "CONFIGURES",
					Properties: map[string]any{
						"strategy":   "key_symbol",
						"confidence": 0.85,
						"config_key": ce.node.Name,
					},
				})
			}
		}
	}

	// Substring match via Aho-Corasick: build AC from config keys, scan code names.
	// This replaces O(entries × unique_norms) string comparisons with O(sum(name_lengths)).
	acPatterns := make([]string, len(entries))
	for i, ce := range entries {
		acPatterns[i] = ce.normalized
	}

	// Build compact-alphabet AC (config keys only contain [a-z0-9_]).
	var alphaMap [256]byte
	idx := byte(1)
	for c := byte('a'); c <= byte('z'); c++ {
		alphaMap[c] = idx
		idx++
	}
	for c := byte('0'); c <= byte('9'); c++ {
		alphaMap[c] = idx
		idx++
	}
	alphaMap['_'] = idx
	alphaSize := int(idx) + 1

	ac := cbm.ACBuildCompact(acPatterns, alphaMap, alphaSize)
	if ac != nil {
		defer ac.Free()

		// Collect unique norms as a flat list for batch scanning.
		normList := make([]string, 0, len(codeByNorm))
		for norm := range codeByNorm {
			normList = append(normList, norm)
		}

		tAC := time.Now()
		matches := ac.ScanBatch(normList)
		slog.Info("configlinker.ac_scan",
			"names", len(normList),
			"matches", len(matches),
			"states", ac.NumStates(),
			"table_kb", ac.TableBytes()/1024,
			"elapsed", time.Since(tAC))

		// Convert AC matches to edges (skip exact matches, already handled above).
		for _, m := range matches {
			norm := normList[m.NameIndex]
			ce := entries[m.PatternID]
			if norm == ce.normalized {
				continue // already added as exact match
			}
			codes := codeByNorm[norm]
			for _, code := range codes {
				edges = append(edges, &store.Edge{
					Project:  p.ProjectName,
					SourceID: code.ID,
					TargetID: ce.node.ID,
					Type:     "CONFIGURES",
					Properties: map[string]any{
						"strategy":   "key_symbol",
						"confidence": 0.75,
						"config_key": ce.node.Name,
					},
				})
			}
		}
	}

	return edges
}

// --- Strategy 2: Dependency Name → Import Match ---

// depEntry pairs a manifest dependency node with its name.
type depEntry struct {
	node *store.Node
	name string
}

// collectManifestDeps returns dependency Variable nodes from package manifest files.
func collectManifestDeps(vars []*store.Node) []depEntry {
	var deps []depEntry
	for _, v := range vars {
		basename := filepath.Base(v.FilePath)
		if !manifestFiles[basename] {
			continue
		}
		isDep := false
		qnLower := strings.ToLower(v.QualifiedName)
		for sec := range depSectionNames {
			if strings.Contains(qnLower, strings.ToLower(sec)) {
				isDep = true
				break
			}
		}
		if !isDep && basename == "Cargo.toml" {
			isDep = isDependencyChild(v)
		}
		if isDep {
			deps = append(deps, depEntry{node: v, name: v.Name})
		}
	}
	return deps
}

// resolveEdgeNodes builds a lookup map for source and target nodes of edges.
// Uses batched FindNodesByIDs instead of per-ID queries.
func (p *Pipeline) resolveEdgeNodes(edges []*store.Edge) (source, target map[int64]*store.Node) {
	seen := make(map[int64]struct{}, len(edges)*2)
	var ids []int64
	for _, e := range edges {
		if _, ok := seen[e.SourceID]; !ok {
			ids = append(ids, e.SourceID)
			seen[e.SourceID] = struct{}{}
		}
		if _, ok := seen[e.TargetID]; !ok {
			ids = append(ids, e.TargetID)
			seen[e.TargetID] = struct{}{}
		}
	}
	lookup, _ := p.Store.FindNodesByIDs(ids)
	if lookup == nil {
		lookup = make(map[int64]*store.Node)
	}
	slog.Info("configlinker.resolve_nodes", "unique_ids", len(ids), "resolved", len(lookup))
	return lookup, lookup
}

// matchDependencyImports links dependency entries in package manifests
// to code modules that import them.
func (p *Pipeline) matchDependencyImports() []*store.Edge {
	configVars, err := p.Store.FindNodesByLabel(p.ProjectName, "Variable")
	if err != nil {
		return nil
	}

	deps := collectManifestDeps(configVars)
	if len(deps) == 0 {
		return nil
	}

	importEdges, err := p.Store.FindEdgesByType(p.ProjectName, "IMPORTS")
	if err != nil {
		return nil
	}

	nodeLookup, _ := p.resolveEdgeNodes(importEdges)

	var edges []*store.Edge
	for _, dep := range deps {
		depNameLower := strings.ToLower(dep.name)
		for _, impEdge := range importEdges {
			target := nodeLookup[impEdge.TargetID]
			source := nodeLookup[impEdge.SourceID]
			if target == nil || source == nil {
				continue
			}

			targetNameLower := strings.ToLower(target.Name)
			targetQNLower := strings.ToLower(target.QualifiedName)

			var confidence float64
			switch {
			case targetNameLower == depNameLower:
				confidence = 0.95
			case strings.Contains(targetQNLower, depNameLower):
				confidence = 0.80
			default:
				continue
			}

			edges = append(edges, &store.Edge{
				Project:  p.ProjectName,
				SourceID: source.ID,
				TargetID: dep.node.ID,
				Type:     "CONFIGURES",
				Properties: map[string]any{
					"strategy":   "dependency_import",
					"confidence": confidence,
					"dep_name":   dep.name,
				},
			})
		}
	}
	return edges
}

// isDependencyChild checks if a Variable node's QN suggests it's under a dependency section.
func isDependencyChild(v *store.Node) bool {
	parts := strings.Split(v.QualifiedName, ".")
	for _, p := range parts {
		pLower := strings.ToLower(p)
		if depSectionNames[pLower] {
			return true
		}
	}
	return false
}

// --- Strategy 3: Config File Path → Code String Reference ---

// fileRefResult holds a matched config file reference for concurrent collection.
type fileRefResult struct {
	sourceQN   string
	targetNode *store.Node
	confidence float64
	refPath    string
}

// matchConfigFileRefs scans source code for string literals referencing config files.
// Parallelizes disk I/O across CPUs for large codebases.
func (p *Pipeline) matchConfigFileRefs() []*store.Edge { //nolint:gocognit,funlen // parallel file scanning with concurrent result collection
	// Collect config Module nodes
	modules, err := p.Store.FindNodesByLabel(p.ProjectName, "Module")
	if err != nil {
		return nil
	}

	configModules := make(map[string]*store.Node)     // basename → Module
	configModulesFull := make(map[string]*store.Node) // relPath → Module
	for _, m := range modules {
		if hasConfigExtension(m.FilePath) {
			configModules[filepath.Base(m.FilePath)] = m
			configModulesFull[m.FilePath] = m
		}
	}
	if len(configModules) == 0 {
		return nil
	}

	// Collect non-config modules to scan
	var toScan []*store.Node
	for _, m := range modules {
		if !hasConfigExtension(m.FilePath) {
			toScan = append(toScan, m)
		}
	}

	slog.Info("configlinker.file_ref.stats",
		"config_modules", len(configModules),
		"files_to_scan", len(toScan),
		"concurrency", runtime.NumCPU())

	// Parallel file scanning with bounded concurrency
	sem := make(chan struct{}, runtime.NumCPU())
	var mu sync.Mutex
	var results []fileRefResult

	var wg sync.WaitGroup
	for _, m := range toScan {
		wg.Add(1)
		go func(mod *store.Node) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			source := p.getSource(mod.FilePath)
			if len(source) == 0 {
				// Disk fallback for incremental mode
				var err error
				source, err = os.ReadFile(filepath.Join(p.RepoPath, mod.FilePath))
				if err != nil {
					return
				}
			}

			matches := configFileRefRe.FindAllStringSubmatch(string(source), -1)
			if len(matches) == 0 {
				return
			}

			var local []fileRefResult
			for _, match := range matches {
				if len(match) < 2 {
					continue
				}
				refPath := match[1]

				var target *store.Node
				var confidence float64
				if t, ok := configModulesFull[refPath]; ok {
					target = t
					confidence = 0.90
				} else {
					refBase := filepath.Base(refPath)
					if t, ok := configModules[refBase]; ok {
						target = t
						confidence = 0.70
					}
				}
				if target == nil {
					continue
				}

				moduleQN := moduleQNForFile(p.ProjectName, mod.FilePath)
				local = append(local, fileRefResult{
					sourceQN:   moduleQN,
					targetNode: target,
					confidence: confidence,
					refPath:    refPath,
				})
			}

			if len(local) > 0 {
				mu.Lock()
				results = append(results, local...)
				mu.Unlock()
			}
		}(m)
	}
	wg.Wait()

	// Batch-resolve source QNs (deduplicate first)
	qnSet := make(map[string]struct{}, len(results))
	for _, r := range results {
		qnSet[r.sourceQN] = struct{}{}
	}
	qnMap := make(map[string]*store.Node, len(qnSet))
	for qn := range qnSet {
		n, err := p.Store.FindNodeByQN(p.ProjectName, qn)
		if err == nil && n != nil {
			qnMap[qn] = n
		}
	}

	var edges []*store.Edge
	for _, r := range results {
		sourceNode := qnMap[r.sourceQN]
		if sourceNode == nil {
			continue
		}
		edges = append(edges, &store.Edge{
			Project:  p.ProjectName,
			SourceID: sourceNode.ID,
			TargetID: r.targetNode.ID,
			Type:     "CONFIGURES",
			Properties: map[string]any{
				"strategy":   "file_reference",
				"confidence": r.confidence,
				"ref_path":   r.refPath,
			},
		})
	}
	return edges
}

// --- Helpers ---

// hasConfigExtension checks if a file path has a config file extension.
func hasConfigExtension(filePath string) bool {
	ext := filepath.Ext(filePath)
	return configExtensions[ext]
}

// moduleQNForFile computes the Module QN for a given file.
func moduleQNForFile(project, relPath string) string {
	// Strip extension, replace / with .
	noExt := strings.TrimSuffix(relPath, filepath.Ext(relPath))
	parts := strings.Split(noExt, "/")

	// Filter empty and special parts
	var filtered []string
	for _, p := range parts {
		if p != "" && p != "__init__" && p != "index" {
			filtered = append(filtered, p)
		}
	}

	return project + "." + strings.Join(filtered, ".")
}
