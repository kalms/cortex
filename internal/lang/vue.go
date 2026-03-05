package lang

func init() {
	Register(&LanguageSpec{
		Language:        Vue,
		FileExtensions:  []string{".vue"},
		ModuleNodeTypes: []string{"document"},
	})
}
