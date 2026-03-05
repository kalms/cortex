package pipeline

// TypeMap maps variable names to their resolved class QN.
type TypeMap map[string]string

// ReturnTypeMap maps function QN to the return type name.
type ReturnTypeMap map[string]string

// resolveAsClass checks if a name refers to a Class/Type node in the registry.
func resolveAsClass(name string, registry *FunctionRegistry, moduleQN string, importMap map[string]string) string {
	result := registry.Resolve(name, moduleQN, importMap)
	if result.QualifiedName == "" {
		return ""
	}

	registry.mu.RLock()
	defer registry.mu.RUnlock()

	label, exists := registry.exact[result.QualifiedName]
	if !exists {
		return ""
	}

	// Only return if it's a class-like node
	switch label {
	case "Class", "Type", "Interface", "Enum":
		return result.QualifiedName
	}
	return ""
}
