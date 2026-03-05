package lang

func init() {
	Register(&LanguageSpec{
		Language:        INI,
		FileExtensions:  []string{".ini", ".cfg", ".conf"},
		ModuleNodeTypes: []string{"document"},
	})
}
