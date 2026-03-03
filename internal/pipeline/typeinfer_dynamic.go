package pipeline

import (
	"strings"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"

	"github.com/DeusData/codebase-memory-mcp/internal/parser"
)

// inferCPPTypes handles C++ patterns:
//
//	Type x(args);          (direct initialization)
//	Type x{...};           (brace initialization)
//	auto x = Type(args);   (auto with constructor)
func inferCPPTypes(
	root *tree_sitter.Node,
	source []byte,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
	types TypeMap,
) {
	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "declaration" {
			return true
		}

		typeNode := node.ChildByFieldName("type")
		if typeNode == nil {
			return false
		}

		initDecl := findChildByKind(node, "init_declarator")
		if initDecl == nil {
			return false
		}

		declNode := initDecl.ChildByFieldName("declarator")
		if declNode == nil {
			return false
		}
		varName := parser.NodeText(declNode, source)
		// Strip pointer/ref: *x, &x
		varName = strings.TrimLeft(varName, "*&")

		typeName := extractSimpleTypeName(typeNode, source)
		if typeName == "auto" {
			// Look at RHS for constructor call
			valueNode := initDecl.ChildByFieldName("value")
			if valueNode != nil && valueNode.Kind() == "call_expression" {
				funcNode := valueNode.ChildByFieldName("function")
				if funcNode != nil {
					typeName = parser.NodeText(funcNode, source)
				}
			}
		}

		if typeName != "" && typeName != "auto" {
			if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
				types[varName] = classQN
			}
		}

		return false
	})
}

// inferPHPTypes handles PHP patterns:
//
//	$x = new ClassName()
func inferPHPTypes(
	root *tree_sitter.Node,
	source []byte,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
	types TypeMap,
) {
	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "assignment_expression" {
			return true
		}

		leftNode := node.ChildByFieldName("left")
		rightNode := node.ChildByFieldName("right")
		if leftNode == nil || rightNode == nil {
			return false
		}

		if leftNode.Kind() != "variable_name" {
			return false
		}
		varName := extractPHPVarNameForInfer(leftNode, source)
		if varName == "" {
			return false
		}

		if rightNode.Kind() == "object_creation_expression" {
			typeName := extractNewExpressionName(rightNode, source)
			if typeName != "" {
				if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
					types[varName] = classQN
				}
			}
		}

		return false
	})
}

// inferRubyTypes handles Ruby patterns:
//
//	x = ClassName.new
func inferRubyTypes(
	root *tree_sitter.Node,
	source []byte,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
	types TypeMap,
) {
	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "assignment" {
			return true
		}

		leftNode := node.ChildByFieldName("left")
		rightNode := node.ChildByFieldName("right")
		if leftNode == nil || rightNode == nil {
			return false
		}

		if leftNode.Kind() != "identifier" {
			return false
		}
		varName := parser.NodeText(leftNode, source)

		// Check for ClassName.new pattern (call with method == "new")
		if typeName := extractRubyNewType(rightNode, source); typeName != "" {
			if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
				types[varName] = classQN
			}
		}

		return false
	})
}

// inferJavaScriptTypes handles JavaScript patterns:
//
//	const x = new ClassName()
func inferJavaScriptTypes(
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

		valueNode := node.ChildByFieldName("value")
		if valueNode != nil && valueNode.Kind() == "new_expression" {
			typeName := extractNewExpressionName(valueNode, source)
			if typeName != "" {
				if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
					types[varName] = classQN
				}
			}
		}

		return false
	})
}

// inferZigTypes handles Zig patterns:
//
//	var x: Type = ...
//	const x: Type = ...
func inferZigTypes(
	root *tree_sitter.Node,
	source []byte,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
	types TypeMap,
) {
	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "VarDecl" {
			return true
		}

		nameNode := node.ChildByFieldName("name")
		if nameNode == nil {
			return false
		}
		varName := parser.NodeText(nameNode, source)

		typeNode := node.ChildByFieldName("type_expr")
		if typeNode != nil {
			typeName := extractSimpleTypeName(typeNode, source)
			if typeName != "" {
				if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
					types[varName] = classQN
				}
			}
		}

		return false
	})
}

// inferElixirTypes handles Elixir patterns:
//
//	x = %StructName{key: val}
func inferElixirTypes(
	root *tree_sitter.Node,
	source []byte,
	_ *FunctionRegistry,
	_ string,
	_ map[string]string,
	_ TypeMap,
) {
	// Elixir struct instantiation uses %ModuleName{} syntax.
	// Tree-sitter-elixir represents this as a binary_operator (=) with a
	// map/struct on the RHS. The struct detection is complex and type dispatch
	// is uncommon in Elixir's functional style. Placeholder for future work.
	_ = root
	_ = source
}

// inferCTypes handles C patterns:
//
//	struct Type x;
//	Type* x = ...;
func inferCTypes(
	root *tree_sitter.Node,
	source []byte,
	registry *FunctionRegistry,
	moduleQN string,
	importMap map[string]string,
	types TypeMap,
) {
	parser.Walk(root, func(node *tree_sitter.Node) bool {
		if node.Kind() != "declaration" {
			return true
		}

		typeNode := node.ChildByFieldName("type")
		if typeNode == nil {
			return false
		}

		var typeName string
		if typeNode.Kind() == "struct_specifier" {
			nameChild := typeNode.ChildByFieldName("name")
			if nameChild != nil {
				typeName = parser.NodeText(nameChild, source)
			}
		} else {
			typeName = extractSimpleTypeName(typeNode, source)
		}
		if typeName == "" {
			return false
		}

		// Extract variable name from declarator
		declNode := node.ChildByFieldName("declarator")
		if declNode == nil {
			return false
		}
		varName := parser.NodeText(declNode, source)
		varName = strings.TrimLeft(varName, "*")

		if classQN := resolveAsClass(typeName, registry, moduleQN, importMap); classQN != "" {
			types[varName] = classQN
		}

		return false
	})
}

// extractRubyNewType extracts the class name from a Ruby ClassName.new call.
func extractRubyNewType(callNode *tree_sitter.Node, source []byte) string {
	if callNode.Kind() != "call" {
		return ""
	}
	methodNode := callNode.ChildByFieldName("method")
	receiverNode := callNode.ChildByFieldName("receiver")
	if methodNode == nil || receiverNode == nil {
		return ""
	}
	if parser.NodeText(methodNode, source) != "new" {
		return ""
	}
	return parser.NodeText(receiverNode, source)
}

// extractPHPVarNameForInfer extracts the name from a PHP variable_name node for type inference.
func extractPHPVarNameForInfer(node *tree_sitter.Node, source []byte) string {
	if node.Kind() != "variable_name" {
		return ""
	}
	text := parser.NodeText(node, source)
	return strings.TrimPrefix(text, "$")
}
