package lang

func init() {
	Register(&LanguageSpec{
		Language:       CUDA,
		FileExtensions: []string{".cu", ".cuh"},
		FunctionNodeTypes: []string{
			"function_definition", "declaration", "field_declaration",
			"template_declaration", "lambda_expression",
		},
		ClassNodeTypes: []string{
			"class_specifier", "struct_specifier", "union_specifier", "enum_specifier",
		},
		FieldNodeTypes:  []string{"field_declaration"},
		ModuleNodeTypes: []string{"translation_unit", "namespace_definition", "linkage_specification", "declaration"},
		CallNodeTypes: []string{
			"call_expression", "field_expression", "subscript_expression",
			"new_expression", "delete_expression",
		},
		ImportNodeTypes: []string{"preproc_include"},
		BranchingNodeTypes: []string{
			"if_statement", "for_statement", "for_range_loop", "while_statement",
			"switch_statement", "case_statement", "try_statement", "catch_clause",
		},
		VariableNodeTypes:   []string{"declaration"},
		AssignmentNodeTypes: []string{"assignment_expression"},
		ThrowNodeTypes:      []string{"throw_statement"},
		EnvAccessFunctions:  []string{"getenv", "std::getenv"},
	})
}
