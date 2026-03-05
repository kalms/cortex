package lang

func init() {
	Register(&LanguageSpec{
		Language:          Julia,
		FileExtensions:    []string{".jl"},
		FunctionNodeTypes: []string{"function_definition", "short_function_definition"},
		ClassNodeTypes:    []string{"struct_definition", "abstract_definition"},
		ModuleNodeTypes:   []string{"source_file"},
		CallNodeTypes:     []string{"call_expression", "broadcast_call_expression"},
		ImportNodeTypes:   []string{"import_statement", "using_statement"},
		BranchingNodeTypes: []string{
			"if_statement", "for_statement", "while_statement", "try_statement",
		},
		VariableNodeTypes:       []string{"const_statement", "assignment"},
		AssignmentNodeTypes:     []string{"assignment", "compound_assignment_expression"},
		ThrowNodeTypes:          []string{"throw_statement"},
		EnvAccessMemberPatterns: []string{"ENV"},
	})
}
