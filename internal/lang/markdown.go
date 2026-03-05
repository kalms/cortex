package lang

func init() {
	Register(&LanguageSpec{
		Language:        Markdown,
		FileExtensions:  []string{".md", ".mdx"},
		ModuleNodeTypes: []string{"document"},
	})
}
