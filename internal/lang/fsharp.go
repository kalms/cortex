package lang

func init() {
	Register(&LanguageSpec{
		Language:          FSharp,
		FileExtensions:    []string{".fs", ".fsi", ".fsx"},
		FunctionNodeTypes: []string{"function_declaration", "value_declaration"},
		ClassNodeTypes:    []string{"type_definition", "exception_definition"},
		ModuleNodeTypes:   []string{"file"},
		CallNodeTypes:     []string{"application_expression", "dot_expression"},
		ImportNodeTypes:   []string{"import_decl", "open_expression"},
		BranchingNodeTypes: []string{
			"if_expression", "for_expression", "while_expression",
			"match_expression", "elif_expression",
		},
		VariableNodeTypes:   []string{"value_declaration"},
		AssignmentNodeTypes: []string{"value_declaration"},
		EnvAccessFunctions:  []string{"Environment.GetEnvironmentVariable"},
	})
}
