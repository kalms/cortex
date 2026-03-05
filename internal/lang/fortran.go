package lang

func init() {
	Register(&LanguageSpec{
		Language:          Fortran,
		FileExtensions:    []string{".f90", ".f95", ".f03", ".f08"},
		FunctionNodeTypes: []string{"function", "subroutine"},
		ClassNodeTypes:    []string{"derived_type_definition"},
		ModuleNodeTypes:   []string{"translation_unit"},
		CallNodeTypes:     []string{"call_expression", "keyword_argument"},
		ImportNodeTypes:   []string{"use_statement", "include_statement"},
		BranchingNodeTypes: []string{
			"if_statement", "do_loop_statement", "where_statement", "select_case_statement",
		},
		VariableNodeTypes:   []string{"variable_declaration"},
		AssignmentNodeTypes: []string{"assignment_statement"},
		EnvAccessFunctions:  []string{"get_environment_variable"},
	})
}
