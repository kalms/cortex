package lang

func init() {
	Register(&LanguageSpec{
		Language:          VimScript,
		FileExtensions:    []string{".vim", ".vimrc"},
		FunctionNodeTypes: []string{"function_definition"},
		ModuleNodeTypes:   []string{"script_file"},
		CallNodeTypes:     []string{"call_expression"},
		BranchingNodeTypes: []string{
			"if_statement", "for_statement", "while_statement", "try_statement",
		},
		VariableNodeTypes: []string{"let_statement"},
	})
}
