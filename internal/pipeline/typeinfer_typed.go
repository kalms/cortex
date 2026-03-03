package pipeline

import (
	"strings"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"

	"github.com/DeusData/codebase-memory-mcp/internal/parser"
)

// inferTypeScriptTypes handles TypeScript/TSX patterns:
//
//	const x: ClassName = ...   (type annotation)
//	const x = new ClassName()  (new expression)
//	let x: ClassName           (type annotation without value)
func inferTypeScriptTypes(
	root *tree_sitter.Node,
	source []byte,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
	types TypeMap,
) {
	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "variable_declarator" {
			return true
		}

		nameNode := node.ChildByFieldName("name")
		if nameNode == nil || nameNode.Kind() != "identifier" {
			return false
		}
		varName := parser.NodeText(nameNode, source)

		// Try type annotation first
		typeNode := node.ChildByFieldName("type")
		if typeNode != nil {
			typeName := extractTypeAnnotationName(typeNode, source)
			if typeName != "" {
				if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
					types[varName] = classQN
					return false
				}
			}
		}

		// Try new expression
		valueNode := node.ChildByFieldName("value")
		if valueNode != nil && valueNode.Kind() == "new_expression" {
			typeName := extractNewExpressionName(valueNode, source)
			if typeName != "" {
				if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
					types[varName] = classQN
					return false
				}
			}
		}

		return false
	})
}

// inferJavaTypes handles Java patterns:
//
//	ClassName x = new ClassName()  (explicit type declaration)
//	ClassName x = factory()        (type is explicit regardless of RHS)
func inferJavaTypes(
	root *tree_sitter.Node,
	source []byte,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
	types TypeMap,
) {
	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "local_variable_declaration" {
			return true
		}

		typeNode := node.ChildByFieldName("type")
		if typeNode == nil {
			return false
		}
		typeName := extractSimpleTypeName(typeNode, source)
		if typeName == "" {
			return false
		}

		// Walk variable_declarator children
		for i := uint(0); i < node.NamedChildCount(); i++ {
			child := node.NamedChild(i)
			if child != nil && child.Kind() == "variable_declarator" {
				declNameNode := child.ChildByFieldName("name")
				if declNameNode != nil {
					varName := parser.NodeText(declNameNode, source)
					if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
						types[varName] = classQN
					}
				}
			}
		}

		return false
	})
}

// inferCSharpTypes handles C# patterns:
//
//	ClassName x = new ClassName()  (explicit type)
//	var x = new ClassName()        (var with new expression)
func inferCSharpTypes(
	root *tree_sitter.Node,
	source []byte,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
	types TypeMap,
) {
	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "local_declaration_statement" {
			return true
		}

		varDecl := findChildByKind(node, "variable_declaration")
		if varDecl == nil {
			return false
		}

		typeNode := varDecl.ChildByFieldName("type")
		if typeNode == nil {
			return false
		}
		explicitType := extractSimpleTypeName(typeNode, source)

		inferCSharpVarDeclarators(varDecl, source, explicitType, registry, moduleQN, importMap, types)

		return false
	})
}

// inferKotlinTypes handles Kotlin patterns:
//
//	val x: ClassName = ...     (type annotation)
//	val x = ClassName()        (constructor call — no "new" keyword)
func inferKotlinTypes(
	root *tree_sitter.Node,
	source []byte,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
	types TypeMap,
) {
	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "property_declaration" {
			return true
		}

		varDecl := findChildByKind(node, "variable_declaration")
		if varDecl == nil {
			return false
		}
		nameNode := findChildByKind(varDecl, "simple_identifier")
		if nameNode == nil {
			return false
		}
		varName := parser.NodeText(nameNode, source)

		// Try type annotation on variable_declaration
		typeNode := findChildByKind(varDecl, "user_type")
		if typeNode != nil {
			typeName := extractSimpleTypeName(typeNode, source)
			if typeName != "" {
				if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
					types[varName] = classQN
					return false
				}
			}
		}

		// Try call expression (constructor without "new")
		valueNode := findKotlinPropertyValue(node, source)
		if valueNode != nil && valueNode.Kind() == "call_expression" {
			calleeName := extractCalleeForTypeInfer(valueNode, source)
			if calleeName != "" {
				if classQN := resolveAsClass(calleeName, registry, moduleQN, importMap); classQN != "" {
					types[varName] = classQN
				}
			}
		}

		return false
	})
}

// inferScalaTypes handles Scala patterns:
//
//	val x: ClassName = ...     (type ascription)
//	val x = ClassName()        (constructor call)
func inferScalaTypes(
	root *tree_sitter.Node,
	source []byte,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
	types TypeMap,
) {
	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "val_definition" {
			return true
		}

		patNode := node.ChildByFieldName("pattern")
		if patNode == nil {
			return false
		}
		varName := parser.NodeText(patNode, source)

		// Try type ascription — look for ":" followed by type
		for i := uint(0); i < node.ChildCount(); i++ {
			child := node.Child(i)
			if child == nil {
				continue
			}
			if child.Kind() == "type_identifier" {
				typeName := parser.NodeText(child, source)
				if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
					types[varName] = classQN
					return false
				}
			}
		}

		// Try constructor call
		valueNode := node.ChildByFieldName("value")
		if valueNode != nil && valueNode.Kind() == "call_expression" {
			funcNode := valueNode.ChildByFieldName("function")
			if funcNode != nil {
				typeName := parser.NodeText(funcNode, source)
				if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
					types[varName] = classQN
				}
			}
		}

		return false
	})
}

// inferRustTypes handles Rust patterns:
//
//	let x: Type = ...           (type annotation)
//	let x = Type { ... }        (struct literal)
//	let x = Type::new()         (scoped constructor)
func inferRustTypes(
	root *tree_sitter.Node,
	source []byte,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
	types TypeMap,
) {
	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "let_declaration" {
			return true
		}

		patNode := node.ChildByFieldName("pattern")
		if patNode == nil {
			return false
		}
		varName := parser.NodeText(patNode, source)
		if varName == "_" {
			return false
		}

		// Try explicit type annotation
		typeNode := node.ChildByFieldName("type")
		if typeNode != nil {
			typeName := extractSimpleTypeName(typeNode, source)
			typeName = strings.TrimPrefix(typeName, "&")
			typeName = strings.TrimPrefix(typeName, "&mut ")
			if typeName != "" {
				if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
					types[varName] = classQN
					return false
				}
			}
		}

		// Try struct literal or scoped call
		valueNode := node.ChildByFieldName("value")
		if valueNode != nil {
			typeName := extractRustValueType(valueNode, source)
			if typeName != "" {
				if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
					types[varName] = classQN
				}
			}
		}

		return false
	})
}

// --- Shared helpers ---

// extractTypeAnnotationName extracts a simple type name from a type annotation node.
// Handles: type_annotation (TS), type_identifier, generic_type.
func extractTypeAnnotationName(node *tree_sitter.Node, source []byte) string {
	if node == nil {
		return ""
	}
	// type_annotation wraps the actual type
	if node.Kind() == "type_annotation" {
		for i := uint(0); i < node.NamedChildCount(); i++ {
			child := node.NamedChild(i)
			if child != nil {
				return extractTypeAnnotationName(child, source)
			}
		}
		return ""
	}
	// generic_type: take the type name before <...>
	if node.Kind() == "generic_type" {
		nameNode := node.NamedChild(0)
		if nameNode != nil {
			return parser.NodeText(nameNode, source)
		}
		return ""
	}
	// Direct type identifiers
	switch node.Kind() {
	case "type_identifier", "identifier", "simple_identifier":
		return parser.NodeText(node, source)
	}
	return ""
}

// extractNewExpressionName extracts the class name from a `new ClassName(args)` node.
func extractNewExpressionName(node *tree_sitter.Node, source []byte) string {
	if node == nil {
		return ""
	}
	// new_expression / object_creation_expression
	for i := uint(0); i < node.NamedChildCount(); i++ {
		child := node.NamedChild(i)
		if child == nil {
			continue
		}
		switch child.Kind() {
		case "identifier", "type_identifier", "simple_identifier":
			return parser.NodeText(child, source)
		case "generic_type":
			nameNode := child.NamedChild(0)
			if nameNode != nil {
				return parser.NodeText(nameNode, source)
			}
		case "member_expression", "scoped_identifier":
			return parser.NodeText(child, source)
		}
	}
	return ""
}

// extractSimpleTypeName extracts a simple (non-generic) type name.
func extractSimpleTypeName(node *tree_sitter.Node, source []byte) string {
	if node == nil {
		return ""
	}
	switch node.Kind() {
	case "type_identifier", "identifier", "simple_identifier":
		return parser.NodeText(node, source)
	case "generic_type":
		if node.NamedChildCount() > 0 {
			return parser.NodeText(node.NamedChild(0), source)
		}
	case "user_type":
		// Kotlin user_type — find the simple_identifier child
		ident := findChildByKind(node, "simple_identifier")
		if ident != nil {
			return parser.NodeText(ident, source)
		}
		// Fall back to first named child
		if node.NamedChildCount() > 0 {
			return parser.NodeText(node.NamedChild(0), source)
		}
	}
	return parser.NodeText(node, source)
}

// extractRustValueType extracts a type name from Rust value expressions.
// Handles struct literals (Type { ... }) and scoped calls (Type::new()).
func extractRustValueType(node *tree_sitter.Node, source []byte) string {
	switch node.Kind() {
	case "struct_expression":
		nameNode := node.ChildByFieldName("name")
		if nameNode != nil {
			return parser.NodeText(nameNode, source)
		}
	case "call_expression":
		funcNode := node.ChildByFieldName("function")
		if funcNode != nil && funcNode.Kind() == "scoped_identifier" {
			pathNode := funcNode.ChildByFieldName("path")
			if pathNode != nil {
				return parser.NodeText(pathNode, source)
			}
		}
	}
	return ""
}

// findKotlinPropertyValue finds the value expression in a Kotlin property_declaration.
// The value comes after the "=" token.
func findKotlinPropertyValue(node *tree_sitter.Node, source []byte) *tree_sitter.Node {
	foundEquals := false
	for i := uint(0); i < node.ChildCount(); i++ {
		child := node.Child(i)
		if child == nil {
			continue
		}
		if parser.NodeText(child, source) == "=" {
			foundEquals = true
			continue
		}
		if foundEquals && child.IsNamed() {
			return child
		}
	}
	return nil
}

// inferCSharpVarDeclarators processes variable declarators within a C# variable_declaration.
func inferCSharpVarDeclarators(
	varDecl *tree_sitter.Node,
	source []byte,
	explicitType string,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
	types TypeMap,
) {
	for i := uint(0); i < varDecl.NamedChildCount(); i++ {
		child := varDecl.NamedChild(i)
		if child == nil || child.Kind() != "variable_declarator" {
			continue
		}
		declNameNode := child.ChildByFieldName("name")
		if declNameNode == nil {
			continue
		}
		varName := parser.NodeText(declNameNode, source)

		typeName := explicitType
		if typeName == "var" {
			valueNode := findValueAfterEquals(child)
			if valueNode != nil && valueNode.Kind() == "object_creation_expression" {
				typeName = extractNewExpressionName(valueNode, source)
			} else {
				typeName = ""
			}
		}

		if typeName != "" {
			if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
				types[varName] = classQN
			}
		}
	}
}
