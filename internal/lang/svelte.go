package lang

func init() {
	Register(&LanguageSpec{
		Language:           Svelte,
		FileExtensions:     []string{".svelte"},
		ModuleNodeTypes:    []string{"document"},
		BranchingNodeTypes: []string{"if_statement", "each_statement", "await_statement"},
	})
}
