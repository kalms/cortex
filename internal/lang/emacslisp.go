package lang

func init() {
	Register(&LanguageSpec{
		Language:          EmacsLisp,
		FileExtensions:    []string{".el"},
		FunctionNodeTypes: []string{"function_definition", "macro_definition"},
		ModuleNodeTypes:   []string{"source_file"},
		CallNodeTypes:     []string{"list"},
	})
}
