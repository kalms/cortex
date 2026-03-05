package lang

func init() {
	Register(&LanguageSpec{
		Language:        XML,
		FileExtensions:  []string{".xml", ".xsl", ".xsd", ".svg"},
		ModuleNodeTypes: []string{"document"},
	})
}
