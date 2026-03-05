package lang

func init() {
	Register(&LanguageSpec{
		Language:           Nix,
		FileExtensions:     []string{".nix"},
		FunctionNodeTypes:  []string{"function_expression"},
		ModuleNodeTypes:    []string{"source_expression"},
		CallNodeTypes:      []string{"apply_expression"},
		BranchingNodeTypes: []string{"if_expression"},
		VariableNodeTypes:  []string{"binding"},
		EnvAccessFunctions: []string{"builtins.getEnv"},
	})
}
