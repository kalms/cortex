package lang

func init() {
	Register(&LanguageSpec{
		Language:          Verilog,
		FileExtensions:    []string{".v", ".sv"},
		FunctionNodeTypes: []string{"function_declaration", "task_declaration"},
		ClassNodeTypes:    []string{"module_declaration", "class_declaration", "interface_declaration"},
		ModuleNodeTypes:   []string{"source_file"},
		CallNodeTypes:     []string{"system_tf_call", "subroutine_call"},
		BranchingNodeTypes: []string{
			"conditional_statement", "case_statement", "loop_statement",
		},
		VariableNodeTypes:   []string{"net_declaration", "data_declaration"},
		AssignmentNodeTypes: []string{"blocking_assignment", "nonblocking_assignment"},
	})
}
