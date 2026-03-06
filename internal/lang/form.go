package lang

func init() {
	Register(&LanguageSpec{
		Language:            FORM,
		FileExtensions:      []string{".frm", ".prc"},
		FunctionNodeTypes:   []string{"procedure_definition"},
		ClassNodeTypes:      []string{},
		ModuleNodeTypes:     []string{"source_file"},
		CallNodeTypes:       []string{"call_statement"},
		ImportNodeTypes:     []string{"include_directive"},
		BranchingNodeTypes:  []string{"if_statement", "repeat_statement", "do_loop"},
		VariableNodeTypes:   []string{"declaration_statement"},
		AssignmentNodeTypes: []string{"substitution_statement"},
	})
}
