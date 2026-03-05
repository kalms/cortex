package lang

func init() {
	Register(&LanguageSpec{
		Language:           Elm,
		FileExtensions:     []string{".elm"},
		FunctionNodeTypes:  []string{"value_declaration", "function_declaration"},
		ClassNodeTypes:     []string{"type_declaration", "type_alias_declaration"},
		ModuleNodeTypes:    []string{"file"},
		CallNodeTypes:      []string{"function_call"},
		ImportNodeTypes:    []string{"import"},
		BranchingNodeTypes: []string{"case_of_expr", "if_else_expr"},
	})
}
