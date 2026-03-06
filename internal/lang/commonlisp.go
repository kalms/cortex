package lang

func init() {
	Register(&LanguageSpec{
		Language:          CommonLisp,
		FileExtensions:    []string{".lisp", ".lsp", ".cl"},
		FunctionNodeTypes: []string{"defun"},
		ModuleNodeTypes:   []string{"source"},
		CallNodeTypes:     []string{"list_lit"},
	})
}
