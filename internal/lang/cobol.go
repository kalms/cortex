package lang

func init() {
	Register(&LanguageSpec{
		Language:          COBOL,
		FileExtensions:    []string{".cob", ".cbl"},
		FunctionNodeTypes: []string{"program_definition"},
		ModuleNodeTypes:   []string{"source_file"},
		CallNodeTypes:     []string{"call_statement"},
		BranchingNodeTypes: []string{
			"if_statement", "evaluate_statement", "perform_statement",
		},
		VariableNodeTypes: []string{"data_description_entry"},
	})
}
