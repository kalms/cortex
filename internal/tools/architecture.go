package tools

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/DeusData/codebase-memory-mcp/internal/store"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// validArchAspects lists all recognized aspect names.
var validArchAspects = map[string]bool{
	"all": true, "languages": true, "packages": true, "entry_points": true,
	"routes": true, "hotspots": true, "boundaries": true, "services": true,
	"layers": true, "clusters": true, "file_tree": true, "adr": true,
}

func (s *Server) handleGetArchitecture(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args, err := parseArgs(req)
	if err != nil {
		return errResult(err.Error()), nil
	}

	aspects, validErr := parseAspects(args)
	if validErr != nil {
		return errResult(validErr.Error()), nil
	}

	project := getStringArg(args, "project")
	st, err := s.resolveStore(project)
	if err != nil {
		return errResult(fmt.Sprintf("resolve store: %v", err)), nil
	}

	projName := s.resolveProjectName(project)
	projects, _ := st.ListProjects()
	if len(projects) > 0 {
		projName = projects[0].Name
	}

	info, err := st.GetArchitecture(projName, aspects)
	if err != nil {
		return errResult(fmt.Sprintf("architecture: %v", err)), nil
	}

	responseData := buildArchResponse(projName, info)
	addADRToResponse(responseData, aspects, st, projName)

	s.addIndexStatus(responseData)
	result := jsonResult(responseData)
	s.addUpdateNotice(result)
	return result, nil
}

// parseAspects extracts and validates the aspects array from tool arguments.
func parseAspects(args map[string]any) ([]string, error) {
	rawAspects, ok := args["aspects"]
	if !ok {
		return []string{"all"}, nil
	}
	arr, ok := rawAspects.([]any)
	if !ok {
		return []string{"all"}, nil
	}
	var aspects []string
	for _, a := range arr {
		str, ok := a.(string)
		if !ok {
			continue
		}
		if !validArchAspects[str] {
			return nil, fmt.Errorf("unknown aspect: %q", str)
		}
		aspects = append(aspects, str)
	}
	if len(aspects) == 0 {
		return []string{"all"}, nil
	}
	return aspects, nil
}

// buildArchResponse converts ArchitectureInfo fields into a response map,
// including only non-nil aspects.
func buildArchResponse(projName string, info *store.ArchitectureInfo) map[string]any {
	data := map[string]any{"project": projName}
	if info.Languages != nil {
		data["languages"] = info.Languages
	}
	if info.Packages != nil {
		data["packages"] = info.Packages
	}
	if info.EntryPoints != nil {
		data["entry_points"] = info.EntryPoints
	}
	if info.Routes != nil {
		data["routes"] = info.Routes
	}
	if info.Hotspots != nil {
		data["hotspots"] = info.Hotspots
	}
	if info.Boundaries != nil {
		data["boundaries"] = info.Boundaries
	}
	if info.Services != nil {
		data["services"] = info.Services
	}
	if info.Layers != nil {
		data["layers"] = info.Layers
	}
	if info.Clusters != nil {
		data["clusters"] = info.Clusters
	}
	if info.FileTree != nil {
		data["file_tree"] = info.FileTree
	}
	return data
}

// addADRToResponse includes the stored ADR in the response when requested.
func addADRToResponse(data map[string]any, aspects []string, st *store.Store, projName string) {
	wantADR := false
	for _, a := range aspects {
		if a == "adr" || a == "all" {
			wantADR = true
			break
		}
	}
	if !wantADR {
		return
	}
	adr, getErr := st.GetADR(projName)
	if getErr != nil || adr == nil {
		data["adr"] = nil
		hint := "No ADR yet. Create one with manage_adr(mode='store', content='## PURPOSE\\n...\\n\\n## STACK\\n...'). For guided creation: explore the codebase, enter plan mode, draft collaboratively, then store. Sections: PURPOSE, STACK, ARCHITECTURE, PATTERNS, TRADEOFFS, PHILOSOPHY."
		if docs, err := st.FindArchitectureDocs(projName); err == nil && len(docs) > 0 {
			hint += fmt.Sprintf(" Existing architecture docs found: %v — consider reading these first.", docs)
		}
		data["adr_hint"] = hint
		return
	}
	data["adr"] = map[string]any{
		"text":       adr.Content,
		"updated_at": adr.UpdatedAt,
	}
}

func (s *Server) handleManageADR(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args, err := parseArgs(req)
	if err != nil {
		return errResult(err.Error()), nil
	}

	mode := getStringArg(args, "mode")
	if mode == "" {
		return errResult("mode is required ('get', 'store', 'update', or 'delete')"), nil
	}

	project := getStringArg(args, "project")
	st, err := s.resolveStore(project)
	if err != nil {
		return errResult(fmt.Sprintf("resolve store: %v", err)), nil
	}

	projName := s.resolveProjectName(project)
	projects, _ := st.ListProjects()
	if len(projects) > 0 {
		projName = projects[0].Name
	}

	switch mode {
	case "get":
		include := parseStringArray(args, "include")
		if err := validateSectionFilter(include); err != nil {
			return errResult(err.Error()), nil
		}
		return s.handleADRGet(st, projName, include)
	case "store":
		content := getStringArg(args, "content")
		return s.handleADRStore(st, projName, content)
	case "update":
		sections := getMapStringArg(args, "sections")
		return s.handleADRUpdate(st, projName, sections)
	case "delete":
		return s.handleADRDelete(st, projName)
	default:
		return errResult(fmt.Sprintf("invalid mode: %q (use 'get', 'store', 'update', or 'delete')", mode)), nil
	}
}

func (s *Server) handleADRGet(st *store.Store, projName string, include []string) (*mcp.CallToolResult, error) {
	adr, err := st.GetADR(projName)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("get ADR: %w", err)
		}
		hint := "No ADR yet. Create one with manage_adr(mode='store', content='## PURPOSE\\n...\\n\\n## STACK\\n...\\n\\n## ARCHITECTURE\\n...\\n\\n## PATTERNS\\n...\\n\\n## TRADEOFFS\\n...\\n\\n## PHILOSOPHY\\n...'). All 6 sections required: PURPOSE, STACK, ARCHITECTURE, PATTERNS, TRADEOFFS, PHILOSOPHY."
		if docs, findErr := st.FindArchitectureDocs(projName); findErr == nil && len(docs) > 0 {
			hint += fmt.Sprintf(" Existing architecture docs found: %v — consider reading these first.", docs)
		}
		return jsonResult(map[string]any{
			"project":  projName,
			"adr":      nil,
			"adr_hint": hint,
		}), nil
	}

	sections := store.ParseADRSections(adr.Content)

	const alignHint = "If you are drafting or finalizing a plan, validate it against the ADR: " +
		"check ARCHITECTURE for structural fit, PATTERNS for convention compliance, " +
		"STACK for technology alignment, and PHILOSOPHY for principle adherence. " +
		"Flag any conflicts before proceeding."

	// Filter sections if include list is provided.
	if len(include) > 0 {
		filtered := make(map[string]string, len(include))
		for _, name := range include {
			if content, ok := sections[name]; ok {
				filtered[name] = content
			}
		}
		return jsonResult(map[string]any{
			"project":        projName,
			"sections":       filtered,
			"updated_at":     adr.UpdatedAt,
			"alignment_hint": alignHint,
		}), nil
	}

	return jsonResult(map[string]any{
		"project":        projName,
		"sections":       sections,
		"text":           adr.Content,
		"updated_at":     adr.UpdatedAt,
		"alignment_hint": alignHint,
	}), nil
}

func (s *Server) handleADRStore(st *store.Store, projName, content string) (*mcp.CallToolResult, error) {
	if content == "" {
		return errResult("content is required for mode='store'"), nil
	}
	if len(content) > store.MaxADRLength() {
		return errResult(fmt.Sprintf("ADR too long (%d chars, max %d)", len(content), store.MaxADRLength())), nil
	}
	if err := store.ValidateADRContent(content); err != nil {
		return errResult(err.Error()), nil
	}
	if err := st.StoreADR(projName, content); err != nil {
		return errResult(fmt.Sprintf("store ADR: %v", err)), nil
	}
	return jsonResult(map[string]any{
		"status":     "stored",
		"project":    projName,
		"updated_at": store.Now(),
	}), nil
}

func (s *Server) handleADRUpdate(st *store.Store, projName string, sections map[string]string) (*mcp.CallToolResult, error) {
	if len(sections) == 0 {
		return errResult("sections is required for mode='update' — e.g. {\"PURPOSE\": \"...\", \"STACK\": \"...\"}"), nil
	}
	if err := store.ValidateADRSectionKeys(sections); err != nil {
		return errResult(err.Error()), nil
	}
	adr, err := st.UpdateADRSections(projName, sections)
	if err != nil {
		return errResult(fmt.Sprintf("update ADR: %v", err)), nil
	}
	parsed := store.ParseADRSections(adr.Content)
	return jsonResult(map[string]any{
		"status":     "updated",
		"project":    projName,
		"sections":   parsed,
		"text":       adr.Content,
		"updated_at": adr.UpdatedAt,
	}), nil
}

func (s *Server) handleADRDelete(st *store.Store, projName string) (*mcp.CallToolResult, error) {
	if err := st.DeleteADR(projName); err != nil {
		return errResult(fmt.Sprintf("delete ADR: %v", err)), nil
	}
	return jsonResult(map[string]any{
		"status":  "deleted",
		"project": projName,
	}), nil
}

// parseStringArray extracts a string array from tool arguments.
func parseStringArray(args map[string]any, key string) []string {
	raw, ok := args[key]
	if !ok {
		return nil
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil
	}
	var result []string
	for _, v := range arr {
		if s, ok := v.(string); ok {
			result = append(result, s)
		}
	}
	return result
}

// validateSectionFilter checks that all names in the include filter are canonical sections.
func validateSectionFilter(include []string) error {
	if len(include) == 0 {
		return nil
	}
	return store.ValidateADRSectionKeys(stringsToMap(include))
}

// stringsToMap converts a string slice to a map[string]string for key validation.
func stringsToMap(ss []string) map[string]string {
	m := make(map[string]string, len(ss))
	for _, s := range ss {
		m[s] = ""
	}
	return m
}
