package lang

func init() {
	Register(&LanguageSpec{
		Language:       GraphQL,
		FileExtensions: []string{".graphql", ".gql"},
		ClassNodeTypes: []string{
			"object_type_definition", "input_object_type_definition",
			"enum_type_definition", "interface_type_definition",
			"union_type_definition", "scalar_type_definition",
		},
		FieldNodeTypes:  []string{"field_definition", "input_value_definition"},
		ModuleNodeTypes: []string{"document"},
	})
}
