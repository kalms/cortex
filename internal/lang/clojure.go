package lang

func init() {
	Register(&LanguageSpec{
		Language:        Clojure,
		FileExtensions:  []string{".clj", ".cljs", ".cljc"},
		ModuleNodeTypes: []string{"source"},
		CallNodeTypes:   []string{"list_lit"},
	})
}
