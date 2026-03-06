package lang

func init() {
	Register(&LanguageSpec{
		Language:          Makefile,
		FileExtensions:    []string{".mk"},
		FunctionNodeTypes: []string{"rule"},
		ModuleNodeTypes:   []string{"makefile"},
		CallNodeTypes:     []string{"function_call"},
		ImportNodeTypes:   []string{"include_directive"},
		VariableNodeTypes: []string{"variable_assignment"},
	})
}
