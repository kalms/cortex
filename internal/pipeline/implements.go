package pipeline

import (
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/DeusData/codebase-memory-mcp/internal/fqn"
	"github.com/DeusData/codebase-memory-mcp/internal/lang"
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

	// Explicit implements/extends via CBM base_classes data
	l, o = p.implementsExplicitCBM()
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
	interfaces, findErr := p.findNodesByLabel(p.ProjectName, "Interface")
	if findErr != nil || len(interfaces) == 0 {
		return nil
	}

	var ifaces []ifaceInfo
	for _, iface := range interfaces {
		if !strings.HasSuffix(iface.FilePath, ".go") {
			continue
		}

		edges, edgeErr := p.findEdgesBySourceAndType(iface.ID, "DEFINES_METHOD")
		if edgeErr != nil || len(edges) == 0 {
			continue
		}

		var methods []ifaceMethodInfo
		for _, e := range edges {
			methodNode, _ := p.findNodeByID(e.TargetID)
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
	methodNodes, findErr := p.findNodesByLabel(p.ProjectName, "Method")
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

			_ = p.insertEdge(&store.Edge{
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
		structMethodQN := prefix + "." + im.name
		structMethodNode, _ := p.findNodeByQN(p.ProjectName, structMethodQN)
		if structMethodNode == nil {
			continue
		}

		ifaceMethodNode, _ := p.findNodeByQN(p.ProjectName, im.qualifiedName)
		if ifaceMethodNode == nil {
			continue
		}

		_ = p.insertEdge(&store.Edge{
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
		if n, _ := p.findNodeByQN(p.ProjectName, structQN); n != nil {
			return n
		}
	}

	classes, _ := p.findNodesByLabel(p.ProjectName, "Class")
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

// --- Explicit implements via CBM base_classes data ---

// explicitImplementsExts maps languages to the extensions to check.
var explicitImplementsExts = map[lang.Language]string{
	lang.TypeScript: ".ts",
	lang.TSX:        ".tsx",
	lang.Java:       ".java",
	lang.CSharp:     ".cs",
	lang.Kotlin:     ".kt",
	lang.Scala:      ".scala",
	lang.PHP:        ".php",
}

// implementsExplicitCBM detects explicit implements/extends relationships
// using CBM-extracted base_classes data from Class/Interface nodes.
func (p *Pipeline) implementsExplicitCBM() (linkCount, overrideCount int) {
	for _, label := range []string{"Class", "Interface"} {
		nodes, err := p.findNodesByLabel(p.ProjectName, label)
		if err != nil {
			continue
		}
		for _, classNode := range nodes {
			lc, oc := p.processExplicitBases(classNode)
			linkCount += lc
			overrideCount += oc
		}
	}
	return
}

// processExplicitBases links one class/interface node to all its base types.
func (p *Pipeline) processExplicitBases(classNode *store.Node) (linkCount, overrideCount int) {
	ext := strings.ToLower(filepath.Ext(classNode.FilePath))
	fileLang, hasLang := lang.LanguageForExtension(ext)
	if !hasLang {
		return
	}
	if _, isExplicit := explicitImplementsExts[fileLang]; !isExplicit {
		return
	}

	baseClasses, ok := classNode.Properties["base_classes"]
	if !ok {
		return
	}
	baseList, ok := baseClasses.([]any)
	if !ok {
		return
	}

	moduleQN := fqn.ModuleQN(p.ProjectName, classNode.FilePath)
	importMap := p.importMaps[moduleQN]

	for _, bc := range baseList {
		baseName, ok := bc.(string)
		if !ok || baseName == "" {
			continue
		}
		ifaceQN := resolveAsClass(baseName, p.registry, moduleQN, importMap)
		if ifaceQN == "" {
			continue
		}
		ifaceNode, _ := p.findNodeByQN(p.ProjectName, ifaceQN)
		if ifaceNode == nil {
			continue
		}
		_ = p.insertEdge(&store.Edge{
			Project:  p.ProjectName,
			SourceID: classNode.ID,
			TargetID: ifaceNode.ID,
			Type:     "IMPLEMENTS",
		})
		linkCount++
		overrideCount += p.createOverrideEdgesExplicit(classNode, ifaceNode)
	}
	return
}

// createOverrideEdgesExplicit creates OVERRIDE edges by matching method names
// between a class and an interface.
func (p *Pipeline) createOverrideEdgesExplicit(classNode, ifaceNode *store.Node) int {
	// Get interface methods
	ifaceEdges, err := p.findEdgesBySourceAndType(ifaceNode.ID, "DEFINES_METHOD")
	if err != nil || len(ifaceEdges) == 0 {
		return 0
	}

	// Get class methods
	classEdges, err := p.findEdgesBySourceAndType(classNode.ID, "DEFINES_METHOD")
	if err != nil || len(classEdges) == 0 {
		return 0
	}

	// Build class method name -> node ID map
	classMethodByName := make(map[string]int64)
	for _, e := range classEdges {
		methodNode, _ := p.findNodeByID(e.TargetID)
		if methodNode != nil {
			classMethodByName[methodNode.Name] = methodNode.ID
		}
	}

	count := 0
	for _, e := range ifaceEdges {
		ifaceMethodNode, _ := p.findNodeByID(e.TargetID)
		if ifaceMethodNode == nil {
			continue
		}
		classMethodID, ok := classMethodByName[ifaceMethodNode.Name]
		if !ok {
			continue
		}

		_ = p.insertEdge(&store.Edge{
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

// implementsRust detects `impl Trait for Struct` from CBM extraction data.
func (p *Pipeline) implementsRust() (linkCount, overrideCount int) {
	for relPath, ext := range p.extractionCache {
		if ext.Language != lang.Rust || ext.Result == nil {
			continue
		}
		if len(ext.Result.ImplTraits) == 0 {
			continue
		}

		moduleQN := fqn.ModuleQN(p.ProjectName, relPath)
		importMap := p.importMaps[moduleQN]

		for _, it := range ext.Result.ImplTraits {
			traitQN := resolveAsClass(it.TraitName, p.registry, moduleQN, importMap)
			if traitQN == "" {
				continue
			}
			structQN := resolveAsClass(it.StructName, p.registry, moduleQN, importMap)
			if structQN == "" {
				continue
			}

			traitDBNode, _ := p.findNodeByQN(p.ProjectName, traitQN)
			structDBNode, _ := p.findNodeByQN(p.ProjectName, structQN)
			if traitDBNode == nil || structDBNode == nil {
				continue
			}

			_ = p.insertEdge(&store.Edge{
				Project:  p.ProjectName,
				SourceID: structDBNode.ID,
				TargetID: traitDBNode.ID,
				Type:     "IMPLEMENTS",
			})
			linkCount++

			overrideCount += p.createOverrideEdgesExplicit(structDBNode, traitDBNode)
		}
	}
	return
}
