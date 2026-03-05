package cbm

import (
	"fmt"
	"testing"

	"github.com/DeusData/codebase-memory-mcp/internal/lang"
)

func TestPythonDocstring(t *testing.T) {
	source := []byte("def compute(x, y):\n    \"\"\"Compute the sum of x and y.\"\"\"\n    return x + y\n")
	result, err := ExtractFile(source, lang.Python, "test", "test.py")
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("Defs: %d\n", len(result.Definitions))
	for _, d := range result.Definitions {
		fmt.Printf("  Name=%q Label=%q QN=%q Doc=%q Sig=%q\n", d.Name, d.Label, d.QualifiedName, d.Docstring, d.Signature)
	}
	if len(result.Definitions) == 0 {
		t.Fatal("no definitions extracted")
	}
	found := false
	for _, d := range result.Definitions {
		if d.Name == "compute" {
			found = true
			if d.Docstring == "" {
				t.Error("docstring is empty for compute")
			}
			t.Logf("docstring: %q", d.Docstring)
		}
	}
	if !found {
		t.Error("compute function not found")
	}
}

func TestGoFunctionExtraction(t *testing.T) {
	source := []byte(`package main

// Greet returns a greeting.
func Greet(name string) string {
	return "Hello, " + name
}

func main() {
	Greet("world")
}
`)
	result, err := ExtractFile(source, lang.Go, "test", "main.go")
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("Defs: %d, Calls: %d, Imports: %d\n", len(result.Definitions), len(result.Calls), len(result.Imports))
	for _, d := range result.Definitions {
		fmt.Printf("  Name=%q Label=%q QN=%q Sig=%q Doc=%q\n", d.Name, d.Label, d.QualifiedName, d.Signature, d.Docstring)
	}
	for _, c := range result.Calls {
		fmt.Printf("  Call: callee=%q enclosing=%q\n", c.CalleeName, c.EnclosingFuncQN)
	}
}

func TestJSArrowFunction(t *testing.T) {
	source := []byte(`const greet = (name) => {
  return "Hello " + name;
};

const result = greet("world");
`)
	result, err := ExtractFile(source, lang.JavaScript, "test", "app.js")
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("Defs: %d\n", len(result.Definitions))
	for _, d := range result.Definitions {
		fmt.Printf("  Name=%q Label=%q QN=%q\n", d.Name, d.Label, d.QualifiedName)
	}
}
