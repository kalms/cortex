package lang

func init() {
	Register(&LanguageSpec{
		Language:        CMake,
		FileExtensions:  []string{".cmake"},
		ModuleNodeTypes: []string{"source_file"},
		CallNodeTypes:   []string{"normal_command"},
	})
}
