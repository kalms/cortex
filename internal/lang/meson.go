package lang

func init() {
	Register(&LanguageSpec{
		Language:           Meson,
		FileExtensions:     []string{".meson"},
		FunctionNodeTypes:  []string{"function_expression"},
		ModuleNodeTypes:    []string{"source_file"},
		CallNodeTypes:      []string{"function_expression"},
		BranchingNodeTypes: []string{"if_statement", "foreach_statement"},
		VariableNodeTypes:  []string{"assignment_statement"},
	})
}
