package lang

func init() {
	Register(&LanguageSpec{
		Language:            Magma,
		FileExtensions:      []string{".mag", ".magma"},
		FunctionNodeTypes:   []string{"function_definition", "procedure_definition", "intrinsic_definition"},
		ClassNodeTypes:      []string{},
		ModuleNodeTypes:     []string{"source_file"},
		CallNodeTypes:       []string{"call_expression"},
		ImportNodeTypes:     []string{"load_statement"},
		BranchingNodeTypes:  []string{"if_statement", "for_statement", "while_statement", "repeat_statement", "case_statement"},
		VariableNodeTypes:   []string{"assignment_statement"},
		AssignmentNodeTypes: []string{"assignment_statement"},
	})
}
