package lang

func init() {
	Register(&LanguageSpec{
		Language:        JSON,
		FileExtensions:  []string{".json"},
		ModuleNodeTypes: []string{"document"},
	})
}
