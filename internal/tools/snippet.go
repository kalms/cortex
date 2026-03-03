package tools

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/DeusData/codebase-memory-mcp/internal/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// snippetMatch holds a resolved node with metadata about how it was found.
type snippetMatch struct {
	node    *store.Node
	project string
	method  string // "exact", "suffix", "name"
}

func (s *Server) handleGetCodeSnippet(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args, err := parseArgs(req)
	if err != nil {
		return errResult(err.Error()), nil
	}

	qn := getStringArg(args, "qualified_name")
	if qn == "" {
		return errResult("qualified_name is required"), nil
	}

	project := getStringArg(args, "project")
	effectiveProject := s.resolveProjectName(project)
	autoResolve := getBoolArg(args, "auto_resolve")
	includeNeighbors := getBoolArg(args, "include_neighbors")

	// 4-tier resolution: exact QN -> suffix -> short name -> fuzzy suggestions
	match, candidates, resolveErr := s.resolveSnippetNode(qn, effectiveProject)
	if resolveErr != nil {
		return errResult(resolveErr.Error()), nil
	}

	// Ambiguous: try auto-resolve or return suggestions
	if match == nil && len(candidates) > 0 {
		if autoResolve && len(candidates) <= 2 {
			match = s.autoResolveBest(candidates, effectiveProject)
		}
		if match == nil {
			return s.snippetSuggestions(qn, candidates), nil
		}
		// Build alternatives list (candidates that were NOT picked)
		alternatives := make([]map[string]string, 0, len(candidates)-1)
		for _, c := range candidates {
			if c.ID != match.node.ID {
				alternatives = append(alternatives, map[string]string{
					"qualified_name": c.QualifiedName,
					"file_path":      c.FilePath,
				})
			}
		}
		return s.buildSnippetResponse(match, includeNeighbors, alternatives)
	}

	// Nothing found at all: try fuzzy suggestions (with last-segment extraction)
	if match == nil {
		searchName := qn
		if idx := strings.LastIndex(qn, "."); idx >= 0 {
			searchName = qn[idx+1:]
		}
		suggestions := s.findSimilarNodes(searchName, effectiveProject, 5)
		if len(suggestions) > 0 {
			return s.snippetSuggestions(qn, suggestions), nil
		}
		return errResult(fmt.Sprintf("node not found: %s", qn)), nil
	}

	return s.buildSnippetResponse(match, includeNeighbors, nil)
}

// buildSnippetResponse reads source and builds the enriched JSON response for a resolved match.
func (s *Server) buildSnippetResponse(match *snippetMatch, includeNeighbors bool, alternatives []map[string]string) (*mcp.CallToolResult, error) {
	node := match.node
	foundProject := match.project

	if node.FilePath == "" {
		return errResult("node has no file path"), nil
	}
	if node.StartLine == 0 || node.EndLine == 0 {
		return errResult("node has no line range"), nil
	}

	// Get the store for the found project to look up root path
	st, stErr := s.router.ForProject(foundProject)
	if stErr != nil {
		return errResult(fmt.Sprintf("store: %v", stErr)), nil
	}

	proj, _ := st.GetProject(foundProject)
	if proj == nil {
		return errResult(fmt.Sprintf("project not found: %s", foundProject)), nil
	}

	absPath := filepath.Join(proj.RootPath, node.FilePath)

	// Read the source file and extract lines
	source, readErr := readLines(absPath, node.StartLine, node.EndLine)
	if readErr != nil {
		return errResult(fmt.Sprintf("read file: %v", readErr)), nil
	}

	// Build enriched response
	responseData := map[string]any{
		"qualified_name": node.QualifiedName,
		"name":           node.Name,
		"label":          node.Label,
		"file_path":      absPath,
		"start_line":     node.StartLine,
		"end_line":       node.EndLine,
		"source":         source,
	}

	// Add all non-empty node properties
	for k, v := range node.Properties {
		if v != nil {
			responseData[k] = v
		}
	}

	// Show match_method for non-exact resolutions
	if match.method != "exact" {
		responseData["match_method"] = match.method
	}

	// Add caller/callee counts
	inDegree, outDegree := st.NodeDegree(node.ID)
	responseData["callers"] = inDegree
	responseData["callees"] = outDegree

	// Opt-in: include neighbor names
	if includeNeighbors {
		callerNames, calleeNames := st.NodeNeighborNames(node.ID, 10)
		if len(callerNames) > 0 {
			responseData["caller_names"] = callerNames
		}
		if len(calleeNames) > 0 {
			responseData["callee_names"] = calleeNames
		}
	}

	// Include alternatives when auto-resolved
	if alternatives != nil {
		responseData["alternatives"] = alternatives
	}

	return jsonResult(responseData), nil
}

// autoResolveBest picks the best candidate from a small set (<=2).
// Heuristic: highest total degree (in+out across all edge types), preferring non-test files.
func (s *Server) autoResolveBest(candidates []*store.Node, projectFilter string) *snippetMatch {
	filter := s.resolveProjectName(projectFilter)
	st, err := s.router.ForProject(filter)
	if err != nil {
		return nil
	}
	projects, _ := st.ListProjects()
	if len(projects) == 0 {
		return nil
	}
	projName := projects[0].Name

	type scored struct {
		node   *store.Node
		degree int
		isTest bool
	}

	scored_ := make([]scored, len(candidates))
	for i, c := range candidates {
		in, out := st.NodeDegree(c.ID)
		isTest := strings.Contains(c.FilePath, "_test")
		scored_[i] = scored{node: c, degree: in + out, isTest: isTest}
	}

	best := scored_[0]
	for _, s := range scored_[1:] {
		// Prefer non-test over test
		if best.isTest && !s.isTest {
			best = s
			continue
		}
		if !best.isTest && s.isTest {
			continue
		}
		// Higher degree wins
		if s.degree > best.degree {
			best = s
			continue
		}
		// Tiebreaker: alphabetical QN
		if s.degree == best.degree && s.node.QualifiedName < best.node.QualifiedName {
			best = s
		}
	}

	slog.Info("snippet.auto_resolved", "input", candidates[0].Name, "picked", best.node.QualifiedName, "candidates", len(candidates))
	return &snippetMatch{node: best.node, project: projName, method: "auto_best"}
}

// resolveSnippetNode implements a 4-tier lookup:
//
//	Tier 1: Exact QN match
//	Tier 2: QN suffix match (dot-boundary)
//	Tier 3: Short name match
//	Tier 4: (caller handles fuzzy via findSimilarNodes)
//
// Returns (match, nil, nil) on unique hit, (nil, candidates, nil) on ambiguous,
// (nil, nil, nil) when nothing found, or (nil, nil, err) on infrastructure error.
func (s *Server) resolveSnippetNode(input, projectFilter string) (*snippetMatch, []*store.Node, error) {
	filter := s.sessionProject
	if projectFilter != "" {
		if projectFilter == "*" || projectFilter == "all" {
			return nil, nil, fmt.Errorf("cross-project queries are not supported; use list_projects to find a specific project name, or omit the project parameter to use the current session project")
		}
		filter = projectFilter
	}
	if filter == "" {
		return nil, nil, fmt.Errorf("no project specified and no session project detected")
	}
	if !s.router.HasProject(filter) {
		return nil, nil, fmt.Errorf("project %q not found; use list_projects to see available projects", filter)
	}

	st, err := s.router.ForProject(filter)
	if err != nil {
		return nil, nil, err
	}
	projects, _ := st.ListProjects()
	if len(projects) == 0 {
		return nil, nil, fmt.Errorf("no projects in store")
	}
	projName := projects[0].Name

	// Tier 1: Exact QN match
	node, findErr := st.FindNodeByQN(projName, input)
	if findErr == nil && node != nil {
		return &snippetMatch{node: node, project: projName, method: "exact"}, nil, nil
	}

	// Tier 2: QN suffix match (dot-boundary)
	suffixMatches, err := st.FindNodesByQNSuffix(projName, input)
	if err == nil && len(suffixMatches) == 1 {
		return &snippetMatch{node: suffixMatches[0], project: projName, method: "suffix"}, nil, nil
	}

	// Tier 3: Short name match
	nameMatches, err := st.FindNodesByName(projName, input)
	if err == nil && len(nameMatches) == 1 {
		return &snippetMatch{node: nameMatches[0], project: projName, method: "name"}, nil, nil
	}

	// Collect all candidates for suggestions (deduped)
	candidates := dedupNodes(suffixMatches, nameMatches)
	if len(candidates) > 0 {
		return nil, candidates, nil
	}

	// Nothing found at any tier
	return nil, nil, nil
}

// snippetSuggestions returns a structured suggestion response for ambiguous or not-found lookups.
func (s *Server) snippetSuggestions(input string, nodes []*store.Node) *mcp.CallToolResult {
	suggList := make([]map[string]string, 0, len(nodes))
	for _, n := range nodes {
		suggList = append(suggList, map[string]string{
			"qualified_name": n.QualifiedName,
			"name":           n.Name,
			"label":          n.Label,
			"file_path":      n.FilePath,
		})
	}
	return jsonResult(map[string]any{
		"status":      "ambiguous",
		"message":     fmt.Sprintf("%d matches found for %q — use a qualified_name from the suggestions to disambiguate", len(nodes), input),
		"suggestions": suggList,
	})
}

// dedupNodes merges multiple node slices, deduplicating by node ID.
func dedupNodes(slices ...[]*store.Node) []*store.Node {
	seen := make(map[int64]bool)
	var result []*store.Node
	for _, s := range slices {
		for _, n := range s {
			if n != nil && !seen[n.ID] {
				seen[n.ID] = true
				result = append(result, n)
			}
		}
	}
	return result
}

// readLines reads specific lines from a file, returning them with line numbers.
func readLines(path string, startLine, endLine int) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open: %w", err)
	}
	defer f.Close()

	var sb strings.Builder
	scanner := bufio.NewScanner(f)
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		if lineNum > endLine {
			break
		}
		if lineNum >= startLine {
			fmt.Fprintf(&sb, "%4d | %s\n", lineNum, scanner.Text())
		}
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("scan: %w", err)
	}

	if sb.Len() == 0 {
		return "", fmt.Errorf("no lines found in range %d-%d (file has %d lines)", startLine, endLine, lineNum)
	}

	return sb.String(), nil
}
