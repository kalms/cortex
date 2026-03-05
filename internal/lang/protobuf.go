package lang

func init() {
	Register(&LanguageSpec{
		Language:        Protobuf,
		FileExtensions:  []string{".proto"},
		ClassNodeTypes:  []string{"message", "enum"},
		FieldNodeTypes:  []string{"field", "map_field", "oneof_field"},
		ModuleNodeTypes: []string{"source_file"},
		ImportNodeTypes: []string{"import"},
	})
}
