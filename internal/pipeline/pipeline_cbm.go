package pipeline

import (
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/DeusData/codebase-memory-mcp/internal/cbm"
	"github.com/DeusData/codebase-memory-mcp/internal/discover"
	"github.com/DeusData/codebase-memory-mcp/internal/fqn"
	"github.com/DeusData/codebase-memory-mcp/internal/lang"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// cachedExtraction holds the CBM extraction result for a file.
// Replaces cachedAST for all post-definition passes.
type cachedExtraction struct {
	Result   *cbm.FileResult
	Language lang.Language
}

// fileEntry pairs a file's relative path with its cached extraction.
// Used by passCalls and batch LSP resolution.
type fileEntry struct {
	relPath string
	ext     *cachedExtraction
}

// cbmParseFile reads a file, calls cbm.ExtractFile(), and converts the
// result to the same parseResult format used by the batch write infrastructure.
// Keeps a copy of the source bytes on parseResult.Source for the sourceStore.
func cbmParseFile(projectName string, f discover.FileInfo, flags *cbm.ExtractionFlags) *parseResult {
	source, cleanup, err := mmapFile(f.Path)
	if cleanup != nil {
		defer cleanup()
	}
	r := cbmParseFileFromSource(projectName, f, source, err, flags)
	// Keep a heap copy of the source bytes for the sourceStore.
	// The mmap will be unmapped after this function returns.
	if r.Err == nil && len(source) > 0 {
		kept := make([]byte, len(source))
		copy(kept, source)
		r.Source = kept
	}
	return r
}

// cbmParseFileFromSource is like cbmParseFile but takes pre-read source data.
// Used by the producer-consumer pipeline where I/O and CPU are separated.
func cbmParseFileFromSource(projectName string, f discover.FileInfo, source []byte, readErr error, flags *cbm.ExtractionFlags) *parseResult {
	result := &parseResult{File: f}

	if readErr != nil {
		result.Err = readErr
		return result
	}

	// Strip UTF-8 BOM if present (common in C#/Windows-generated files)
	source = stripBOM(source)

	cbmResult, err := cbm.ExtractFileWithFlags(source, f.Language, projectName, f.RelPath, flags)
	if err != nil {
		slog.Warn("cbm.extract.err", "path", f.RelPath, "lang", f.Language, "err", err)
		result.Err = err
		return result
	}

	result.CBMResult = cbmResult

	moduleQN := fqn.ModuleQN(projectName, f.RelPath)

	// Module node
	moduleNode := &store.Node{
		Project:       projectName,
		Label:         "Module",
		Name:          filepath.Base(f.RelPath),
		QualifiedName: moduleQN,
		FilePath:      f.RelPath,
		Properties:    make(map[string]any),
	}
	result.Nodes = append(result.Nodes, moduleNode)

	// Convert CBM definitions to store.Node objects
	for i := range cbmResult.Definitions {
		node, edge := cbmDefToNode(&cbmResult.Definitions[i], projectName, moduleQN)
		result.Nodes = append(result.Nodes, node)
		result.PendingEdges = append(result.PendingEdges, edge)
	}

	// Enrich module node with properties from CBM result
	enrichModuleNodeCBM(moduleNode, cbmResult, result)

	// Build import map from CBM imports
	if len(cbmResult.Imports) > 0 {
		importMap := make(map[string]string, len(cbmResult.Imports))
		for _, imp := range cbmResult.Imports {
			if imp.LocalName != "" && imp.ModulePath != "" {
				importMap[imp.LocalName] = imp.ModulePath
			}
		}
		result.ImportMap = importMap
	}

	moduleNode.Properties["imports_count"] = cbmResult.ImportCount
	moduleNode.Properties["is_test"] = cbmResult.IsTestFile

	// exports: collect exported symbol names
	var exports []string
	for _, n := range result.Nodes {
		if n.QualifiedName == moduleQN {
			continue
		}
		if exp, ok := n.Properties["is_exported"].(bool); ok && exp {
			exports = append(exports, n.Name)
		}
	}
	if len(exports) > 0 {
		moduleNode.Properties["exports"] = exports
	}

	if symbols := buildSymbolSummary(result.Nodes, moduleQN); len(symbols) > 0 {
		moduleNode.Properties["symbols"] = symbols
	}

	return result
}

// cbmDefToNode converts a CBM Definition to a store.Node and its DEFINES/DEFINES_METHOD edge.
func cbmDefToNode(def *cbm.Definition, projectName, moduleQN string) (*store.Node, pendingEdge) {
	props := map[string]any{}

	if def.Signature != "" {
		props["signature"] = def.Signature
	}
	if def.ReturnType != "" {
		props["return_type"] = def.ReturnType
	}
	if def.Receiver != "" {
		props["receiver"] = def.Receiver
	}
	if def.Docstring != "" {
		props["docstring"] = def.Docstring
	}
	if len(def.Decorators) > 0 {
		props["decorators"] = def.Decorators
		if hasFrameworkDecorator(def.Decorators) {
			props["is_entry_point"] = true
		}
	}
	if len(def.BaseClasses) > 0 {
		props["base_classes"] = def.BaseClasses
	}
	if len(def.ParamNames) > 0 {
		props["param_names"] = def.ParamNames
	}
	if len(def.ParamTypes) > 0 {
		props["param_types"] = def.ParamTypes
	}
	if len(def.ReturnTypes) > 0 {
		props["return_types"] = def.ReturnTypes
	}
	if def.Complexity > 0 {
		props["complexity"] = def.Complexity
	}
	if def.Lines > 0 {
		props["lines"] = def.Lines
	}

	props["is_exported"] = def.IsExported

	if def.IsAbstract {
		props["is_abstract"] = true
	}
	if def.IsTest {
		props["is_test"] = true
	}
	if def.IsEntryPoint {
		props["is_entry_point"] = true
	}

	node := &store.Node{
		Project:       projectName,
		Label:         def.Label,
		Name:          def.Name,
		QualifiedName: def.QualifiedName,
		FilePath:      def.FilePath,
		StartLine:     def.StartLine,
		EndLine:       def.EndLine,
		Properties:    props,
	}

	// Determine edge type and source QN
	edgeType := "DEFINES"
	sourceQN := moduleQN
	if def.Label == "Method" || def.Label == "Field" {
		edgeType = "DEFINES_METHOD"
		if def.Label == "Field" {
			edgeType = "DEFINES_FIELD"
		}
		if def.ParentClass != "" {
			sourceQN = def.ParentClass
		}
	}

	edge := pendingEdge{
		SourceQN: sourceQN,
		TargetQN: def.QualifiedName,
		Type:     edgeType,
	}

	return node, edge
}

// enrichModuleNodeCBM populates module node properties from CBM extraction results.
func enrichModuleNodeCBM(moduleNode *store.Node, cbmResult *cbm.FileResult, _ *parseResult) {
	// Additional module-level properties can be added here if CBM exposes them
	// (e.g., macros, constants, global_vars from CBMFileResult)
}

// inferTypesCBM builds a TypeMap from CBM TypeAssign data + registry resolution.
// Replaces the 14 language-specific infer*Types() functions.
func inferTypesCBM(
	typeAssigns []cbm.TypeAssign,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
) TypeMap {
	types := make(TypeMap, len(typeAssigns))

	for _, ta := range typeAssigns {
		if ta.VarName == "" || ta.TypeName == "" {
			continue
		}
		classQN := resolveAsClass(ta.TypeName, registry, moduleQN, importMap)
		if classQN != "" {
			types[ta.VarName] = classQN
		}
	}

	// Return type propagation is handled by CBM TypeAssigns which already
	// detect constructor patterns. Additional return-type-based inference
	// from the returnTypes map is still useful for non-constructor calls.
	// This would require the call data which we have in CBM Calls.
	// For now, constructor-based inference covers the primary use case.

	return types
}

// resolveFileCallsCBM resolves all call targets using pre-extracted CBM data.
// Cross-file LSP results are pre-populated by batch phase in passCalls().
// This function handles registry + fuzzy resolution only (no CGo).
func (p *Pipeline) resolveFileCallsCBM(relPath string, ext *cachedExtraction) []resolvedEdge {
	moduleQN := fqn.ModuleQN(p.ProjectName, relPath)
	importMap := p.importMaps[moduleQN]

	// Build type map from CBM type assignments
	typeMap := inferTypesCBM(ext.Result.TypeAssigns, p.registry, moduleQN, importMap)

	// LSP-resolved calls take priority (high confidence, type-aware).
	edges, lspCallerMethods := collectLSPResolvedEdges(ext.Result.ResolvedCalls)

	// Resolve remaining calls via registry + fuzzy matching
	for _, call := range ext.Result.Calls {
		if edge, ok := p.resolveCallEdge(call, moduleQN, importMap, typeMap, lspCallerMethods); ok {
			edges = append(edges, edge)
		}
	}

	return edges
}

// batchGoLSPCrossFileResolution collects all Go files needing cross-file LSP,
// prepares their data, and resolves them in ONE CGo call via BatchGoLSPCrossFile.
func (p *Pipeline) batchGoLSPCrossFileResolution(files []fileEntry) {
	if p.goLSPIdx == nil {
		return
	}

	type goLSPFile struct {
		fileIdx int
		input   cbm.BatchLSPInput
	}

	var batch []goLSPFile
	for i, fe := range files {
		if fe.ext.Language != lang.Go || fe.ext.Result == nil {
			continue
		}
		moduleQN := fqn.ModuleQN(p.ProjectName, fe.relPath)
		importMap := p.importMaps[moduleQN]
		crossDefs := p.goLSPIdx.collectCrossFileDefs(importMap)
		if len(crossDefs) == 0 {
			continue
		}
		source := readFileSource(p, fe.relPath)
		if len(source) == 0 {
			continue
		}
		fileDefs := cbm.DefsToLSPDefs(fe.ext.Result.Definitions, moduleQN)
		batch = append(batch, goLSPFile{
			fileIdx: i,
			input: cbm.BatchLSPInput{
				Source:     source,
				ModuleQN:   moduleQN,
				FileDefs:   fileDefs,
				CrossDefs:  crossDefs,
				Imports:    fe.ext.Result.Imports,
				CachedTree: fe.ext.Result.TreeHandle,
			},
		})
	}

	if len(batch) == 0 {
		return
	}

	// Build flat input slice for ONE CGo call
	inputs := make([]cbm.BatchLSPInput, len(batch))
	for i := range batch {
		inputs[i] = batch[i].input
	}

	slog.Info("go_lsp.batch", "files", len(inputs))
	results := cbm.BatchGoLSPCrossFile(inputs)

	// Distribute results back to extraction cache
	for i, result := range results {
		if len(result) > 0 {
			files[batch[i].fileIdx].ext.Result.ResolvedCalls = result
		}
	}
}

// batchCLSPCrossFileResolution collects all C/C++/CUDA files needing cross-file LSP,
// prepares their data, and resolves them in ONE CGo call via BatchCLSPCrossFile.
func (p *Pipeline) batchCLSPCrossFileResolution(files []fileEntry) {
	if p.cLSPIdx == nil {
		return
	}

	type cLSPFile struct {
		fileIdx int
		input   cbm.BatchCLSPInput
	}

	var batch []cLSPFile
	for i, fe := range files {
		if !isCOrCPP(fe.ext.Language) || fe.ext.Result == nil {
			continue
		}
		moduleQN := fqn.ModuleQN(p.ProjectName, fe.relPath)
		incDirs := p.getRelativeIncludeDirs(fe.relPath)
		if incDirs == nil {
			incDirs = p.getAllRelativeIncludeDirs()
		}
		crossDefs := p.cLSPIdx.collectCrossFileDefs(fe.ext.Result.Imports, fe.relPath, incDirs)
		if len(crossDefs) == 0 {
			continue
		}
		source := readFileSource(p, fe.relPath)
		if len(source) == 0 {
			continue
		}
		cppMode := fe.ext.Language == lang.CPP || fe.ext.Language == lang.CUDA
		fileDefs := cbm.DefsToLSPDefs(fe.ext.Result.Definitions, moduleQN)
		batch = append(batch, cLSPFile{
			fileIdx: i,
			input: cbm.BatchCLSPInput{
				Source:     source,
				ModuleQN:   moduleQN,
				CppMode:    cppMode,
				FileDefs:   fileDefs,
				CrossDefs:  crossDefs,
				Includes:   fe.ext.Result.Imports,
				CachedTree: fe.ext.Result.TreeHandle,
			},
		})
	}

	if len(batch) == 0 {
		return
	}

	inputs := make([]cbm.BatchCLSPInput, len(batch))
	for i := range batch {
		inputs[i] = batch[i].input
	}

	slog.Info("c_lsp.batch", "files", len(inputs))
	results := cbm.BatchCLSPCrossFile(inputs)

	for i, result := range results {
		if len(result) > 0 {
			files[batch[i].fileIdx].ext.Result.ResolvedCalls = result
		}
	}
}

// collectLSPResolvedEdges converts LSP-resolved calls to edges and builds a caller+method dedup set.
func collectLSPResolvedEdges(resolvedCalls []cbm.ResolvedCall) (edges []resolvedEdge, lspCallerMethods map[string]bool) {
	lspResolved := make(map[string]bool)
	lspCallerMethods = make(map[string]bool)

	for _, rc := range resolvedCalls {
		if rc.CallerQN == "" || rc.CalleeQN == "" || rc.Confidence == 0 {
			continue
		}
		key := rc.CallerQN + "\x00" + rc.CalleeQN
		if lspResolved[key] {
			continue
		}
		lspResolved[key] = true
		edges = append(edges, resolvedEdge{
			CallerQN: rc.CallerQN,
			TargetQN: rc.CalleeQN,
			Type:     "CALLS",
			Properties: map[string]any{
				"confidence":          float64(rc.Confidence),
				"confidence_band":     confidenceBand(float64(rc.Confidence)),
				"resolution_strategy": rc.Strategy,
			},
		})

		shortName := rc.CalleeQN
		if idx := strings.LastIndex(shortName, "."); idx >= 0 {
			shortName = shortName[idx+1:]
		}
		lspCallerMethods[rc.CallerQN+"\x00"+shortName] = true
	}

	return edges, lspCallerMethods
}

// resolveCallEdge resolves a single call to an edge using the registry and type system.
func (p *Pipeline) resolveCallEdge(
	call cbm.Call, moduleQN string, importMap map[string]string,
	typeMap TypeMap, lspCallerMethods map[string]bool,
) (resolvedEdge, bool) {
	calleeName := call.CalleeName
	callerQN := call.EnclosingFuncQN
	if calleeName == "" {
		return resolvedEdge{}, false
	}
	if callerQN == "" {
		callerQN = moduleQN
	}

	// Skip if LSP already resolved this caller+method
	fuzzyShort := calleeName
	if idx := strings.LastIndex(fuzzyShort, "."); idx >= 0 {
		fuzzyShort = fuzzyShort[idx+1:]
	}
	if lspCallerMethods[callerQN+"\x00"+fuzzyShort] {
		return resolvedEdge{}, false
	}

	// Python self.method() resolution
	if strings.HasPrefix(calleeName, "self.") {
		classQN := extractClassFromMethodQN(callerQN)
		if classQN != "" {
			candidate := classQN + "." + calleeName[5:]
			if p.registry.Exists(candidate) {
				return resolvedEdge{CallerQN: callerQN, TargetQN: candidate, Type: "CALLS"}, true
			}
		}
	}

	// Type-based method dispatch for qualified calls like obj.method()
	result := p.resolveCallWithTypes(calleeName, moduleQN, importMap, typeMap)
	if result.QualifiedName == "" {
		if fuzzyResult, ok := p.registry.FuzzyResolve(calleeName, moduleQN, importMap); ok && fuzzyResult.Confidence >= 0.10 {
			return resolvedEdge{
				CallerQN: callerQN,
				TargetQN: fuzzyResult.QualifiedName,
				Type:     "CALLS",
				Properties: map[string]any{
					"confidence":          fuzzyResult.Confidence,
					"confidence_band":     confidenceBand(fuzzyResult.Confidence),
					"resolution_strategy": fuzzyResult.Strategy,
				},
			}, true
		}
		return resolvedEdge{}, false
	}

	if result.Confidence < 0.10 {
		return resolvedEdge{}, false
	}
	return resolvedEdge{
		CallerQN: callerQN,
		TargetQN: result.QualifiedName,
		Type:     "CALLS",
		Properties: map[string]any{
			"confidence":          result.Confidence,
			"confidence_band":     confidenceBand(result.Confidence),
			"resolution_strategy": result.Strategy,
		},
	}, true
}

// resolveFileUsagesCBM resolves usage references using pre-extracted CBM data.
// Replaces resolveFileUsages() — no AST walking needed.
func (p *Pipeline) resolveFileUsagesCBM(relPath string, ext *cachedExtraction) []resolvedEdge {
	moduleQN := fqn.ModuleQN(p.ProjectName, relPath)
	importMap := p.importMaps[moduleQN]

	var edges []resolvedEdge
	seen := make(map[[2]string]bool)

	for _, usage := range ext.Result.Usages {
		refName := usage.RefName
		callerQN := usage.EnclosingFuncQN
		if refName == "" {
			continue
		}
		if callerQN == "" {
			callerQN = moduleQN
		}

		result := p.registry.Resolve(refName, moduleQN, importMap)
		if result.QualifiedName == "" {
			continue
		}

		key := [2]string{callerQN, result.QualifiedName}
		if seen[key] {
			continue
		}
		seen[key] = true

		edges = append(edges, resolvedEdge{
			CallerQN: callerQN,
			TargetQN: result.QualifiedName,
			Type:     "USAGE",
		})
	}

	return edges
}

// resolveFileThrowsCBM resolves throw/raise targets using pre-extracted CBM data.
// Replaces resolveFileThrows() — no AST walking needed.
func (p *Pipeline) resolveFileThrowsCBM(relPath string, ext *cachedExtraction) []resolvedEdge {
	moduleQN := fqn.ModuleQN(p.ProjectName, relPath)
	importMap := p.importMaps[moduleQN]

	var edges []resolvedEdge
	seen := make(map[[2]string]bool)

	for _, thr := range ext.Result.Throws {
		excName := thr.ExceptionName
		funcQN := thr.EnclosingFuncQN
		if excName == "" || funcQN == "" {
			continue
		}

		key := [2]string{funcQN, excName}
		if seen[key] {
			continue
		}
		seen[key] = true

		// Determine edge type: THROWS for checked exceptions, RAISES for runtime/unchecked
		edgeType := "RAISES"
		if isCheckedException(excName) {
			edgeType = "THROWS"
		}

		// Try to resolve exception class
		result := p.registry.Resolve(excName, moduleQN, importMap)
		targetQN := excName
		if result.QualifiedName != "" {
			targetQN = result.QualifiedName
		}

		edges = append(edges, resolvedEdge{
			CallerQN: funcQN,
			TargetQN: targetQN,
			Type:     edgeType,
		})
	}

	return edges
}

// resolveFileReadsWritesCBM resolves reads/writes using pre-extracted CBM data.
// Replaces resolveFileReadsWrites() — no AST walking needed.
func (p *Pipeline) resolveFileReadsWritesCBM(relPath string, ext *cachedExtraction) []resolvedEdge {
	moduleQN := fqn.ModuleQN(p.ProjectName, relPath)
	importMap := p.importMaps[moduleQN]

	var edges []resolvedEdge
	seen := make(map[[3]string]bool)

	for _, rw := range ext.Result.ReadWrites {
		varName := rw.VarName
		funcQN := rw.EnclosingFuncQN
		if varName == "" || funcQN == "" {
			continue
		}

		edgeType := "READS"
		if rw.IsWrite {
			edgeType = "WRITES"
		}

		key := [3]string{funcQN, varName, edgeType}
		if seen[key] {
			continue
		}
		seen[key] = true

		// Try to resolve variable to a known node
		result := p.registry.Resolve(varName, moduleQN, importMap)
		if result.QualifiedName == "" {
			continue
		}

		edges = append(edges, resolvedEdge{
			CallerQN: funcQN,
			TargetQN: result.QualifiedName,
			Type:     edgeType,
		})
	}

	return edges
}

// resolveFileTypeRefsCBM resolves type references using pre-extracted CBM data.
// Replaces resolveFileTypeRefs() — no AST walking needed.
func (p *Pipeline) resolveFileTypeRefsCBM(relPath string, ext *cachedExtraction) []resolvedEdge {
	moduleQN := fqn.ModuleQN(p.ProjectName, relPath)
	importMap := p.importMaps[moduleQN]

	var edges []resolvedEdge
	seen := make(map[[2]string]bool)

	for _, tr := range ext.Result.TypeRefs {
		typeName := tr.TypeName
		funcQN := tr.EnclosingFuncQN
		if typeName == "" || funcQN == "" {
			continue
		}

		key := [2]string{funcQN, typeName}
		if seen[key] {
			continue
		}
		seen[key] = true

		// Resolve type name to a node QN
		result := p.registry.Resolve(typeName, moduleQN, importMap)
		if result.QualifiedName == "" {
			continue
		}

		edges = append(edges, resolvedEdge{
			CallerQN: funcQN,
			TargetQN: result.QualifiedName,
			Type:     "USES_TYPE",
		})
	}

	return edges
}

// resolveFileConfiguresCBM resolves env access calls using pre-extracted CBM data.
// Replaces resolveFileConfigures() — no AST walking needed.
func (p *Pipeline) resolveFileConfiguresCBM(relPath string, ext *cachedExtraction, envIndex map[string]string) []resolvedEdge {
	moduleQN := fqn.ModuleQN(p.ProjectName, relPath)

	var edges []resolvedEdge
	seen := make(map[[2]string]bool)

	for _, ea := range ext.Result.EnvAccesses {
		envKey := ea.EnvKey
		funcQN := ea.EnclosingFuncQN
		if envKey == "" || funcQN == "" {
			continue
		}

		targetModuleQN, ok := envIndex[envKey]
		if !ok {
			continue
		}

		key := [2]string{funcQN, targetModuleQN}
		if seen[key] {
			continue
		}
		seen[key] = true

		_ = moduleQN
		edges = append(edges, resolvedEdge{
			CallerQN: funcQN,
			TargetQN: targetModuleQN,
			Type:     "CONFIGURES",
			Properties: map[string]any{
				"env_key": envKey,
			},
		})
	}

	return edges
}

// extractClassFromMethodQN extracts the class QN from a method QN.
// E.g., "project.path.ClassName.methodName" -> "project.path.ClassName"
func extractClassFromMethodQN(methodQN string) string {
	idx := strings.LastIndex(methodQN, ".")
	if idx <= 0 {
		return ""
	}
	return methodQN[:idx]
}

// isCheckedException returns true if the exception name looks like a checked exception
// (Java convention: checked exceptions don't extend RuntimeException).
func isCheckedException(excName string) bool {
	// Heuristic: exceptions ending in "Exception" without "Runtime" prefix are checked
	if strings.HasSuffix(excName, "Exception") && !strings.HasPrefix(excName, "Runtime") {
		return true
	}
	return false
}
