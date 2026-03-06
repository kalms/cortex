package pipeline

import (
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

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
	keyEdges := p.matchConfigKeySymbols()
	slog.Info("configlinker.strategy", "name", "key_symbol", "edges", len(keyEdges))

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

	var edges []*store.Edge
	for _, ce := range entries {
		for _, code := range codeNodes {
			codeNorm, _ := normalizeConfigKey(code.Name)
			if codeNorm == "" {
				continue
			}

			var confidence float64
			switch {
			case codeNorm == ce.normalized:
				confidence = 0.85 // exact match
			case strings.Contains(codeNorm, ce.normalized):
				confidence = 0.75 // substring match
			default:
				continue
			}

			edges = append(edges, &store.Edge{
				Project:  p.ProjectName,
				SourceID: code.ID,
				TargetID: ce.node.ID,
				Type:     "CONFIGURES",
				Properties: map[string]any{
					"strategy":   "key_symbol",
					"confidence": confidence,
					"config_key": ce.node.Name,
				},
			})
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

// resolveEdgeNodes builds lookup maps for source and target nodes of edges.
func (p *Pipeline) resolveEdgeNodes(edges []*store.Edge) (source, target map[int64]*store.Node) {
	ids := make(map[int64]struct{})
	for _, e := range edges {
		ids[e.SourceID] = struct{}{}
		ids[e.TargetID] = struct{}{}
	}
	lookup := make(map[int64]*store.Node, len(ids))
	for id := range ids {
		n, err := p.Store.FindNodeByID(id)
		if err == nil && n != nil {
			lookup[id] = n
		}
	}
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

// matchConfigFileRefs scans source code for string literals referencing config files.
func (p *Pipeline) matchConfigFileRefs() []*store.Edge {
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

	// Scan source files for config file references (use Module nodes from DB)
	var edges []*store.Edge
	for _, m := range modules {
		relPath := m.FilePath
		if hasConfigExtension(relPath) {
			continue // Skip config files themselves
		}

		// Read source from disk for string literal scanning
		fullPath := filepath.Join(p.RepoPath, relPath)
		source, err := os.ReadFile(fullPath)
		if err != nil {
			continue
		}

		matches := configFileRefRe.FindAllStringSubmatch(string(source), -1)
		for _, match := range matches {
			if len(match) < 2 {
				continue
			}
			refPath := match[1]

			// Try full path match first
			var target *store.Node
			var confidence float64
			if m, ok := configModulesFull[refPath]; ok {
				target = m
				confidence = 0.90
			} else {
				// Try basename match
				refBase := filepath.Base(refPath)
				if m, ok := configModules[refBase]; ok {
					target = m
					confidence = 0.70
				}
			}
			if target == nil {
				continue
			}

			// Find the source module/function
			moduleQN := moduleQNForFile(p.ProjectName, relPath)
			sourceNode, err := p.Store.FindNodeByQN(p.ProjectName, moduleQN)
			if err != nil || sourceNode == nil {
				continue
			}

			edges = append(edges, &store.Edge{
				Project:  p.ProjectName,
				SourceID: sourceNode.ID,
				TargetID: target.ID,
				Type:     "CONFIGURES",
				Properties: map[string]any{
					"strategy":   "file_reference",
					"confidence": confidence,
					"ref_path":   refPath,
				},
			})
		}
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
