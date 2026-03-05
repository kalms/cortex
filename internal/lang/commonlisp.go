package lang

func init() {
	Register(&LanguageSpec{
		Language:        CommonLisp,
		FileExtensions:  []string{".lisp", ".lsp", ".cl"},
		ModuleNodeTypes: []string{"source"},
		CallNodeTypes:   []string{"list_lit"},
	})
}
