package pipeline

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DeusData/codebase-memory-mcp/internal/discover"
	"github.com/DeusData/codebase-memory-mcp/internal/lang"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

func writeLangTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestDocstringIntegration verifies the pipeline stores docstring properties on nodes.
func TestDocstringIntegration(t *testing.T) {
	tests := []struct {
		name     string
		language lang.Language
		ext      string
		source   string
		label    string // "Function" or "Class"
		wantName string // node name to find
		want     string // docstring substring
	}{
		{
			"Go_function",
			lang.Go, ".go",
			"package main\n\n// Compute does something.\nfunc Compute() {}\n",
			"Function", "Compute", "Compute does something.",
		},
		{
			"Python_function",
			lang.Python, ".py",
			"def compute():\n\t\"\"\"Does something.\"\"\"\n\tpass\n",
			"Function", "compute", "Does something.",
		},
		{
			"Java_method",
			lang.Java, ".java",
			"class A {\n\t/** Computes result. */\n\tvoid compute() {}\n}\n",
			"Method", "compute", "Computes result.",
		},
		{
			"Kotlin_function",
			lang.Kotlin, ".kt",
			"/** Computes result. */\nfun compute() {}\n",
			"Function", "compute", "Computes result.",
		},
		{
			"Go_class",
			lang.Go, ".go",
			"package main\n\n// MyStruct is documented.\ntype MyStruct struct{}\n",
			"Class", "MyStruct", "MyStruct is documented.",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			writeLangTestFile(t, filepath.Join(dir, "main"+tt.ext), tt.source)

			s, err := store.OpenMemory()
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()

			p := New(context.Background(), s, dir, discover.ModeFull)
			if err := p.Run(); err != nil {
				t.Fatal(err)
			}

			nodes, err := s.FindNodesByLabel(p.ProjectName, tt.label)
			if err != nil {
				t.Fatal(err)
			}

			var found bool
			for _, n := range nodes {
				if n.Name != tt.wantName {
					continue
				}
				found = true
				doc, ok := n.Properties["docstring"].(string)
				if !ok || doc == "" {
					t.Errorf("node %q has no docstring property", n.QualifiedName)
					continue
				}
				if !strings.Contains(doc, tt.want) {
					t.Errorf("node %q docstring = %q, want substring %q", n.QualifiedName, doc, tt.want)
				}
			}
			if !found {
				t.Errorf("no %s node named %q found", tt.label, tt.wantName)
			}
		})
	}
}
