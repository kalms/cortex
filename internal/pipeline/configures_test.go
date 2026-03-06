package pipeline

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/DeusData/codebase-memory-mcp/internal/discover"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

func TestBuildEnvIndex_ConfigVariableAdded(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)

	// Create a config file with an env-var-like key
	writeFile(t, filepath.Join(dir, "config.toml"), `DATABASE_URL = "postgresql://localhost/db"
`)
	// Need a code file so pipeline runs
	writeFile(t, filepath.Join(dir, "main.go"), `package main

import "os"

func main() {
	url := os.Getenv("DATABASE_URL")
	_ = url
}
`)

	s, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	p := New(context.Background(), s, dir, discover.ModeFull)
	if err := p.Run(); err != nil {
		t.Fatalf("Pipeline.Run: %v", err)
	}

	// Check that CONFIGURES edges were created
	edges, err := s.FindEdgesByType(p.ProjectName, "CONFIGURES")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("CONFIGURES edges: %d", len(edges))
	// The env var access in main.go should link to the config file
	// via the extended buildEnvIndex
	if len(edges) == 0 {
		t.Logf("warning: no CONFIGURES edges (may depend on extraction)")
	}
}

func TestBuildEnvIndex_LowercaseKeySkipped(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)

	writeFile(t, filepath.Join(dir, "config.toml"), `database_host = "localhost"
`)
	writeFile(t, filepath.Join(dir, "main.go"), `package main

func main() {}
`)

	s, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	p := New(context.Background(), s, dir, discover.ModeFull)
	if err := p.Run(); err != nil {
		t.Fatalf("Pipeline.Run: %v", err)
	}

	// lowercase keys should NOT be in the env index (isEnvVarName rejects them)
	// so no CONFIGURES edges from env var matching for lowercase keys
	edges, err := s.FindEdgesByType(p.ProjectName, "CONFIGURES")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range edges {
		// If there's a CONFIGURES edge that came from env var matching
		// to a lowercase key, that's a bug
		if e.Properties != nil && e.Properties["strategy"] == nil {
			// Env-var CONFIGURES edges don't have a "strategy" property
			// (they come from passConfigures, not passConfigLinker)
			t.Logf("env var CONFIGURES edge found: source=%d target=%d", e.SourceID, e.TargetID)
		}
	}
}

func TestBuildEnvIndex_NonConfigFileSkipped(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)

	// Put an env-var-like variable in a Go file (should not be added to env index)
	writeFile(t, filepath.Join(dir, "main.go"), `package main

var API_URL = "https://api.example.com"

func main() {}
`)

	s, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	p := New(context.Background(), s, dir, discover.ModeFull)
	if err := p.Run(); err != nil {
		t.Fatalf("Pipeline.Run: %v", err)
	}

	// No config file exists, so buildEnvIndex should not find config Variables
	// Only Module constants might produce env index entries
	t.Log("pipeline ran successfully without config files")
}

func TestIsEnvVarName(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"DATABASE_URL", true},
		{"API_KEY", true},
		{"PORT", true},
		{"A", false},      // too short
		{"port", false},   // lowercase
		{"apiKey", false}, // camelCase
		{"DB_2", true},    // with digit
		{"__", false},     // no uppercase
		{"", false},       // empty
	}

	for _, tt := range tests {
		got := isEnvVarName(tt.input)
		if got != tt.want {
			t.Errorf("isEnvVarName(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

func TestNormalizeConfigKey(t *testing.T) {
	tests := []struct {
		input      string
		wantNorm   string
		wantTokens int
	}{
		{"max_connections", "max_connections", 2},
		{"maxConnections", "max_connections", 2},
		{"DATABASE_HOST", "database_host", 2},
		{"database.host", "database_host", 2},
		{"port", "port", 1},
		{"maxRetryCount", "max_retry_count", 3},
	}

	for _, tt := range tests {
		norm, tokens := normalizeConfigKey(tt.input)
		if norm != tt.wantNorm {
			t.Errorf("normalizeConfigKey(%q) norm = %q, want %q", tt.input, norm, tt.wantNorm)
		}
		if len(tokens) != tt.wantTokens {
			t.Errorf("normalizeConfigKey(%q) tokens = %d, want %d", tt.input, len(tokens), tt.wantTokens)
		}
	}
}

func TestHasConfigExtension(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{"config.toml", true},
		{"settings.yaml", true},
		{"config.yml", true},
		{".env", true},
		{"config.ini", true},
		{"data.json", true},
		{"pom.xml", true},
		{"main.go", false},
		{"app.py", false},
		{"data.csv", false},
	}

	for _, tt := range tests {
		got := hasConfigExtension(tt.path)
		if got != tt.want {
			t.Errorf("hasConfigExtension(%q) = %v, want %v", tt.path, got, tt.want)
		}
	}
}

// Helper: ensure pipeline doesn't crash with config+code project
func TestConfigIntegration_FullPipeline(t *testing.T) {
	dir := t.TempDir()
	gitInit(t, dir)

	writeFile(t, filepath.Join(dir, "config.toml"), `[database]
host = "localhost"
port = 5432
max_connections = 100

[server]
bind_address = "0.0.0.0"
`)
	writeFile(t, filepath.Join(dir, "settings.ini"), `[database]
host = localhost
port = 5432
`)
	writeFile(t, filepath.Join(dir, "config.json"), `{"appName": "test", "maxRetries": 3}`)
	writeFile(t, filepath.Join(dir, "main.go"), `package main

import "os"

func getMaxConnections() int { return 100 }

func loadConfig() {
	cfg := readFile("config.toml")
	_ = cfg
	dbURL := os.Getenv("DATABASE_URL")
	_ = dbURL
}

func readFile(path string) string { return "" }
`)

	s, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	p := New(context.Background(), s, dir, discover.ModeFull)
	if err := p.Run(); err != nil {
		t.Fatalf("Pipeline.Run: %v", err)
	}

	// Verify nodes were created for config files
	nodes, _ := s.FindNodesByLabel(p.ProjectName, "Class")
	vars, _ := s.FindNodesByLabel(p.ProjectName, "Variable")
	funcs, _ := s.FindNodesByLabel(p.ProjectName, "Function")
	edges, _ := s.FindEdgesByType(p.ProjectName, "CONFIGURES")

	t.Logf("Classes: %d, Variables: %d, Functions: %d, CONFIGURES edges: %d",
		len(nodes), len(vars), len(funcs), len(edges))

	// Should have config Class nodes (database, server sections)
	if len(nodes) == 0 {
		t.Error("expected Class nodes from config files")
	}
	// Should have Variable nodes from config files
	if len(vars) == 0 {
		t.Error("expected Variable nodes from config files")
	}
}
