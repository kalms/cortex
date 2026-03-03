package pipeline

import (
	"log/slog"
	"strings"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"

	"github.com/DeusData/codebase-memory-mcp/internal/fqn"
	"github.com/DeusData/codebase-memory-mcp/internal/lang"
	"github.com/DeusData/codebase-memory-mcp/internal/parser"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// ifaceMethodInfo holds a method name and its qualified name for OVERRIDE edge creation.
type ifaceMethodInfo struct {
	name          string
	qualifiedName string
}

// ifaceInfo holds an interface node and its required methods.
type ifaceInfo struct {
	node    *store.Node
	methods []ifaceMethodInfo
}

// passImplements detects interface satisfaction and creates IMPLEMENTS edges.
// Supports Go (implicit, method-set matching) and explicit implements for
// TypeScript, Java, C#, Kotlin, Scala, and Rust.
func (p *Pipeline) passImplements() {
	slog.Info("pass5.implements")

	var linkCount, overrideCount int

	// Go: implicit interface satisfaction (existing)
	l, o := p.implementsGo()
	linkCount += l
	overrideCount += o

	// Explicit implements/extends (TS, Java, C#, Kotlin, Scala)
	l, o = p.implementsExplicit()
	linkCount += l
	overrideCount += o

	// Rust: impl Trait for Struct
	l, o = p.implementsRust()
	linkCount += l
	overrideCount += o

	slog.Info("pass5.implements.done", "links", linkCount, "overrides", overrideCount)
}

// implementsGo handles Go's implicit interface satisfaction via method sets.
func (p *Pipeline) implementsGo() (linkCount, overrideCount int) {
	ifaces := p.collectGoInterfaces()
	if len(ifaces) == 0 {
		return 0, 0
	}

	structMethods, structQNPrefix := p.collectStructMethods()
	return p.matchImplements(ifaces, structMethods, structQNPrefix)
}

// collectGoInterfaces returns Go interfaces with their method names.
func (p *Pipeline) collectGoInterfaces() []ifaceInfo {
	interfaces, findErr := p.Store.FindNodesByLabel(p.ProjectName, "Interface")
	if findErr != nil || len(interfaces) == 0 {
		return nil
	}

	var ifaces []ifaceInfo
	for _, iface := range interfaces {
		if !strings.HasSuffix(iface.FilePath, ".go") {
			continue
		}

		edges, edgeErr := p.Store.FindEdgesBySourceAndType(iface.ID, "DEFINES_METHOD")
		if edgeErr != nil || len(edges) == 0 {
			continue
		}

		var methods []ifaceMethodInfo
		for _, e := range edges {
			methodNode, _ := p.Store.FindNodeByID(e.TargetID)
			if methodNode != nil {
				methods = append(methods, ifaceMethodInfo{
					name:          methodNode.Name,
					qualifiedName: methodNode.QualifiedName,
				})
			}
		}

		if len(methods) > 0 {
			ifaces = append(ifaces, ifaceInfo{node: iface, methods: methods})
		}
	}
	return ifaces
}

// collectStructMethods builds maps of receiver type -> method names and QN prefixes
// from Go methods with receiver properties.
func (p *Pipeline) collectStructMethods() (structMethods map[string]map[string]bool, structQNPrefix map[string]string) {
	methodNodes, findErr := p.Store.FindNodesByLabel(p.ProjectName, "Method")
	if findErr != nil {
		return nil, nil
	}

	structMethods = make(map[string]map[string]bool)
	structQNPrefix = make(map[string]string)

	for _, m := range methodNodes {
		if !strings.HasSuffix(m.FilePath, ".go") {
			continue
		}
		recv, ok := m.Properties["receiver"]
		if !ok {
			continue
		}
		recvStr, ok := recv.(string)
		if !ok || recvStr == "" {
			continue
		}

		typeName := extractReceiverType(recvStr)
		if typeName == "" {
			continue
		}

		if structMethods[typeName] == nil {
			structMethods[typeName] = make(map[string]bool)
		}
		structMethods[typeName][m.Name] = true

		if _, exists := structQNPrefix[typeName]; !exists {
			if idx := strings.LastIndex(m.QualifiedName, "."); idx > 0 {
				structQNPrefix[typeName] = m.QualifiedName[:idx]
			}
		}
	}
	return
}

// matchImplements checks each struct against each interface and creates IMPLEMENTS + OVERRIDE edges.
func (p *Pipeline) matchImplements(
	ifaces []ifaceInfo,
	structMethods map[string]map[string]bool,
	structQNPrefix map[string]string,
) (linkCount, overrideCount int) {
	for _, iface := range ifaces {
		for typeName, methodSet := range structMethods {
			if !satisfies(iface.methods, methodSet) {
				continue
			}

			structNode := p.findStructNode(typeName, structQNPrefix)
			if structNode == nil {
				continue
			}

			_, _ = p.Store.InsertEdge(&store.Edge{
				Project:  p.ProjectName,
				SourceID: structNode.ID,
				TargetID: iface.node.ID,
				Type:     "IMPLEMENTS",
			})
			linkCount++

			overrideCount += p.createOverrideEdges(iface.methods, typeName, structQNPrefix)
		}
	}
	return linkCount, overrideCount
}

// createOverrideEdges creates OVERRIDE edges from struct methods to interface methods.
func (p *Pipeline) createOverrideEdges(
	ifaceMethods []ifaceMethodInfo,
	typeName string,
	structQNPrefix map[string]string,
) int {
	prefix, ok := structQNPrefix[typeName]
	if !ok {
		return 0
	}

	count := 0
	for _, im := range ifaceMethods {
		// prefix already includes the type name (e.g., "pkg.FileReader" from "pkg.FileReader.Read")
		structMethodQN := prefix + "." + im.name
		structMethodNode, _ := p.Store.FindNodeByQN(p.ProjectName, structMethodQN)
		if structMethodNode == nil {
			continue
		}

		ifaceMethodNode, _ := p.Store.FindNodeByQN(p.ProjectName, im.qualifiedName)
		if ifaceMethodNode == nil {
			continue
		}

		_, _ = p.Store.InsertEdge(&store.Edge{
			Project:  p.ProjectName,
			SourceID: structMethodNode.ID,
			TargetID: ifaceMethodNode.ID,
			Type:     "OVERRIDE",
		})
		count++
	}
	return count
}

// findStructNode looks up the struct/class node for a given receiver type name.
func (p *Pipeline) findStructNode(typeName string, structQNPrefix map[string]string) *store.Node {
	if prefix, ok := structQNPrefix[typeName]; ok {
		structQN := prefix + "." + typeName
		if n, _ := p.Store.FindNodeByQN(p.ProjectName, structQN); n != nil {
			return n
		}
	}

	classes, _ := p.Store.FindNodesByLabel(p.ProjectName, "Class")
	for _, c := range classes {
		if c.Name == typeName && strings.HasSuffix(c.FilePath, ".go") {
			return c
		}
	}
	return nil
}

// extractReceiverType extracts the type name from a Go receiver string.
// "(h *Handlers)" -> "Handlers", "(s Store)" -> "Store"
func extractReceiverType(recv string) string {
	recv = strings.TrimSpace(recv)
	recv = strings.Trim(recv, "()")
	parts := strings.Fields(recv)
	if len(parts) == 0 {
		return ""
	}
	// Last field is the type, possibly with * prefix
	typeName := parts[len(parts)-1]
	typeName = strings.TrimPrefix(typeName, "*")
	return typeName
}

// satisfies checks if a set of method names includes all interface methods.
func satisfies(ifaceMethods []ifaceMethodInfo, structMethodSet map[string]bool) bool {
	for _, m := range ifaceMethods {
		if !structMethodSet[m.name] {
			return false
		}
	}
	return true
}

// --- Explicit implements (TS, Java, C#, Kotlin, Scala) ---

// explicitImplementsLangs maps languages to the extensions to check.
var explicitImplementsExts = map[lang.Language]string{
	lang.TypeScript: ".ts",
	lang.TSX:        ".tsx",
	lang.Java:       ".java",
	lang.CSharp:     ".cs",
	lang.Kotlin:     ".kt",
	lang.Scala:      ".scala",
	lang.PHP:        ".php",
}

// implementsExplicit walks ASTs for TS/Java/C#/Kotlin/Scala files and detects
// explicit `implements`/`extends` clauses.
func (p *Pipeline) implementsExplicit() (linkCount, overrideCount int) {
	for relPath, cached := range p.astCache {
		ext, isExplicit := explicitImplementsExts[cached.Language]
		if !isExplicit {
			continue
		}
		if !strings.HasSuffix(relPath, ext) && cached.Language != lang.TSX {
			continue
		}

		moduleQN := fqn.ModuleQN(p.ProjectName, relPath)
		importMap := p.importMaps[moduleQN]
		root := cached.Tree.RootNode()

		parser.Walk(root, func(node *tree_sitter.Node) bool {
			if !isClassDeclaration(node.Kind(), cached.Language) {
				return true
			}

			nameNode := node.ChildByFieldName("name")
			if nameNode == nil {
				return false
			}
			className := parser.NodeText(nameNode, source(cached))

			classQN := fqn.Compute(p.ProjectName, relPath, className)
			classNode, _ := p.Store.FindNodeByQN(p.ProjectName, classQN)
			if classNode == nil {
				return false
			}

			// Extract implemented interface names
			ifaceNames := extractImplementsClause(node, cached.Source, cached.Language)
			for _, ifaceName := range ifaceNames {
				ifaceQN := resolveAsClass(ifaceName, p.registry, moduleQN, importMap)
				if ifaceQN == "" {
					continue
				}
				ifaceNode, _ := p.Store.FindNodeByQN(p.ProjectName, ifaceQN)
				if ifaceNode == nil {
					continue
				}

				_, _ = p.Store.InsertEdge(&store.Edge{
					Project:  p.ProjectName,
					SourceID: classNode.ID,
					TargetID: ifaceNode.ID,
					Type:     "IMPLEMENTS",
				})
				linkCount++

				// Create OVERRIDE edges for matching methods
				overrideCount += p.createOverrideEdgesExplicit(classNode, ifaceNode)
			}

			return false
		})
	}
	return
}

// source is a helper to get cached source bytes.
func source(c *cachedAST) []byte { return c.Source }

// isClassDeclaration checks if a node kind is a class declaration for the given language.
// Language-aware to prevent cross-language false positives.
func isClassDeclaration(kind string, language lang.Language) bool {
	// Common across many languages
	switch kind {
	case "class_declaration", "class_definition":
		return true
	}

	// Language-specific node types
	switch language {
	case lang.TypeScript, lang.TSX:
		switch kind {
		case "abstract_class_declaration", "interface_declaration":
			return true
		}
	case lang.Java:
		switch kind {
		case "interface_declaration", "enum_declaration",
			"annotation_type_declaration", "record_declaration":
			return true
		}
	case lang.CSharp:
		switch kind {
		case "struct_declaration", "interface_declaration", "enum_declaration":
			return true
		}
	case lang.Scala:
		switch kind {
		case "object_definition", "trait_definition":
			return true
		}
	case lang.Kotlin:
		switch kind {
		case "object_declaration", "companion_object":
			return true
		}
	case lang.PHP:
		switch kind {
		case "trait_declaration", "interface_declaration", "enum_declaration":
			return true
		}
	}
	return false
}

// extractImplementsClause extracts interface/trait names from a class declaration.
func extractImplementsClause(classNode *tree_sitter.Node, src []byte, language lang.Language) []string {
	var names []string

	for i := uint(0); i < classNode.ChildCount(); i++ {
		child := classNode.Child(i)
		if child == nil {
			continue
		}
		kind := child.Kind()

		switch kind {
		case "implements_clause", "interfaces", "super_interfaces",
			"base_list", "delegation_specifiers", "extends_clause",
			"class_interface_clause":
			names = append(names, extractTypeListNames(child, src)...)
		}
	}

	// Some languages put it in a specific field
	if len(names) == 0 {
		switch language {
		case lang.TypeScript, lang.TSX:
			if clause := findDescendantByKind(classNode, "implements_clause"); clause != nil {
				names = extractTypeListNames(clause, src)
			}
		case lang.Java:
			if clause := findChildByKind(classNode, "super_interfaces"); clause != nil {
				names = extractTypeListNames(clause, src)
			}
		case lang.PHP:
			if clause := findChildByKind(classNode, "class_interface_clause"); clause != nil {
				names = extractTypeListNames(clause, src)
			}
		}
	}

	return names
}

// extractTypeListNames extracts type identifier names from a type list clause.
func extractTypeListNames(clause *tree_sitter.Node, src []byte) []string {
	var names []string
	for i := uint(0); i < clause.NamedChildCount(); i++ {
		child := clause.NamedChild(i)
		if child == nil {
			continue
		}
		switch child.Kind() {
		case "type_identifier", "identifier", "simple_identifier", "name":
			names = append(names, parser.NodeText(child, src))
		case "qualified_name":
			// PHP qualified names: extract last segment
			text := parser.NodeText(child, src)
			names = append(names, lastBackslashOrDotSegment(text))
		case "generic_type":
			if child.NamedChildCount() > 0 {
				nameNode := child.NamedChild(0)
				if nameNode != nil {
					names = append(names, parser.NodeText(nameNode, src))
				}
			}
		case "delegation_specifier", "annotated_delegation_specifier":
			// Kotlin wraps each type in a delegation_specifier
			ident := findDescendantByKind(child, "simple_identifier")
			if ident == nil {
				ident = findDescendantByKind(child, "identifier")
			}
			if ident != nil {
				names = append(names, parser.NodeText(ident, src))
			}
		default:
			// Recurse into type_list or interface_type_list
			if child.NamedChildCount() > 0 {
				names = append(names, extractTypeListNames(child, src)...)
			}
		}
	}
	return names
}

// createOverrideEdgesExplicit creates OVERRIDE edges by matching method names
// between a class and an interface.
func (p *Pipeline) createOverrideEdgesExplicit(classNode, ifaceNode *store.Node) int {
	// Get interface methods
	ifaceEdges, err := p.Store.FindEdgesBySourceAndType(ifaceNode.ID, "DEFINES_METHOD")
	if err != nil || len(ifaceEdges) == 0 {
		return 0
	}

	// Get class methods
	classEdges, err := p.Store.FindEdgesBySourceAndType(classNode.ID, "DEFINES_METHOD")
	if err != nil || len(classEdges) == 0 {
		return 0
	}

	// Build class method name -> node ID map
	classMethodByName := make(map[string]int64)
	for _, e := range classEdges {
		methodNode, _ := p.Store.FindNodeByID(e.TargetID)
		if methodNode != nil {
			classMethodByName[methodNode.Name] = methodNode.ID
		}
	}

	count := 0
	for _, e := range ifaceEdges {
		ifaceMethodNode, _ := p.Store.FindNodeByID(e.TargetID)
		if ifaceMethodNode == nil {
			continue
		}
		classMethodID, ok := classMethodByName[ifaceMethodNode.Name]
		if !ok {
			continue
		}

		_, _ = p.Store.InsertEdge(&store.Edge{
			Project:  p.ProjectName,
			SourceID: classMethodID,
			TargetID: ifaceMethodNode.ID,
			Type:     "OVERRIDE",
		})
		count++
	}
	return count
}

// --- Rust: impl Trait for Struct ---

// implementsRust walks Rust ASTs for `impl Trait for Struct` patterns.
func (p *Pipeline) implementsRust() (linkCount, overrideCount int) {
	for relPath, cached := range p.astCache {
		if cached.Language != lang.Rust {
			continue
		}

		moduleQN := fqn.ModuleQN(p.ProjectName, relPath)
		importMap := p.importMaps[moduleQN]
		root := cached.Tree.RootNode()

		parser.Walk(root, func(node *tree_sitter.Node) bool {
			if node.Kind() != "impl_item" {
				return true
			}

			// impl_item has "trait" and "type" fields when it's an impl Trait for Type
			traitNode := node.ChildByFieldName("trait")
			typeNode := node.ChildByFieldName("type")
			if traitNode == nil || typeNode == nil {
				return false
			}

			traitName := parser.NodeText(traitNode, cached.Source)
			structName := parser.NodeText(typeNode, cached.Source)

			traitQN := resolveAsClass(traitName, p.registry, moduleQN, importMap)
			if traitQN == "" {
				return false
			}
			structQN := resolveAsClass(structName, p.registry, moduleQN, importMap)
			if structQN == "" {
				return false
			}

			traitDBNode, _ := p.Store.FindNodeByQN(p.ProjectName, traitQN)
			structDBNode, _ := p.Store.FindNodeByQN(p.ProjectName, structQN)
			if traitDBNode == nil || structDBNode == nil {
				return false
			}

			_, _ = p.Store.InsertEdge(&store.Edge{
				Project:  p.ProjectName,
				SourceID: structDBNode.ID,
				TargetID: traitDBNode.ID,
				Type:     "IMPLEMENTS",
			})
			linkCount++

			overrideCount += p.createOverrideEdgesExplicit(structDBNode, traitDBNode)
			return false
		})
	}
	return
}

// lastBackslashOrDotSegment returns the last segment of a name separated by \ or .
func lastBackslashOrDotSegment(name string) string {
	if idx := strings.LastIndex(name, "\\"); idx >= 0 {
		return name[idx+1:]
	}
	if idx := strings.LastIndex(name, "."); idx >= 0 {
		return name[idx+1:]
	}
	return name
}
