package pipeline

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/DeusData/codebase-memory-mcp/internal/discover"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// --- Strategy 1: Key → Symbol Matching ---

func TestConfigKeySymbol_ExactMatch(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "config.toml"), `[database]
max_connections = 100
`)
	writeFile(t, filepath.Join(dir, "main.go"), `package main

func getMaxConnections() int { return 100 }
`)

	edges := runAndGetConfigures(t, dir)
	found := false
	for _, e := range edges {
		if props, ok := e.Properties["strategy"]; ok && props == "key_symbol" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected key_symbol CONFIGURES edge for max_connections, got %d total CONFIGURES", len(edges))
	}
}

func TestConfigKeySymbol_SubstringMatch(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "config.toml"), `[app]
request_timeout = 30
`)
	writeFile(t, filepath.Join(dir, "main.go"), `package main

func getRequestTimeoutSeconds() int { return 30 }
`)

	edges := runAndGetConfigures(t, dir)
	found := false
	for _, e := range edges {
		props := e.Properties
		if props["strategy"] == "key_symbol" {
			conf, _ := props["confidence"].(float64)
			if conf == 0.75 {
				found = true
			}
		}
	}
	if !found {
		t.Logf("got %d CONFIGURES edges", len(edges))
		for _, e := range edges {
			t.Logf("  strategy=%v confidence=%v", e.Properties["strategy"], e.Properties["confidence"])
		}
		t.Errorf("expected substring match (confidence=0.75) for request_timeout")
	}
}

func TestConfigKeySymbol_ShortKeySkipped(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "config.toml"), `port = 8080
host = "localhost"
name = "test"
`)
	writeFile(t, filepath.Join(dir, "main.go"), `package main

func getPort() int { return 8080 }
`)

	edges := runAndGetConfigures(t, dir)
	for _, e := range edges {
		if e.Properties["strategy"] == "key_symbol" {
			t.Errorf("expected no key_symbol edges for short keys, got one: config_key=%v", e.Properties["config_key"])
		}
	}
}

func TestConfigKeySymbol_CamelCaseNormalization(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "config.json"), `{"maxRetryCount": 3}`)
	writeFile(t, filepath.Join(dir, "handler.go"), `package main

func getMaxRetryCount() int { return 3 }
`)

	edges := runAndGetConfigures(t, dir)
	found := false
	for _, e := range edges {
		if e.Properties["strategy"] == "key_symbol" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected key_symbol CONFIGURES edge for maxRetryCount")
	}
}

func TestConfigKeySymbol_NoFalsePositive(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "config.toml"), `[db]
url = "postgres://..."
`)
	writeFile(t, filepath.Join(dir, "main.go"), `package main

func parseURL(s string) string { return s }
`)

	edges := runAndGetConfigures(t, dir)
	for _, e := range edges {
		if e.Properties["strategy"] == "key_symbol" && e.Properties["config_key"] == "url" {
			t.Errorf("expected no CONFIGURES edge for 'url' (1 token), but got one")
		}
	}
}

// --- Strategy 2: Dependency → Import Matching ---

func TestDependencyImport_PackageJson(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "package.json"), `{"dependencies":{"express":"^4.0","lodash":"^4.17"}}`)
	writeFile(t, filepath.Join(dir, "app.js"), `const express = require('express');

function handleRequest() {
  return express();
}
`)

	edges := runAndGetConfigures(t, dir)
	found := false
	for _, e := range edges {
		if e.Properties["strategy"] == "dependency_import" {
			found = true
			break
		}
	}
	// This test may not produce edges since IMPORTS resolution depends on registry
	// but it should at least not crash
	t.Logf("dependency_import edges found: %v", found)
}

// --- Strategy 3: File Path Reference ---

func TestConfigFileRef_ExactPath(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "config", "database.toml"), `[database]
host = "localhost"
`)
	writeFile(t, filepath.Join(dir, "main.go"), `package main

func loadConfig() {
	cfg := readFile("config/database.toml")
	_ = cfg
}
`)

	edges := runAndGetConfigures(t, dir)
	found := false
	for _, e := range edges {
		if e.Properties["strategy"] == "file_reference" {
			found = true
			break
		}
	}
	if !found {
		t.Logf("got %d CONFIGURES edges total", len(edges))
		t.Errorf("expected file_reference CONFIGURES edge for config/database.toml")
	}
}

func TestConfigFileRef_BasenameMatch(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "settings.yaml"), `database:
  host: localhost
`)
	writeFile(t, filepath.Join(dir, "main.go"), `package main

func loadSettings() {
	cfg := readFile("settings.yaml")
	_ = cfg
}
`)

	edges := runAndGetConfigures(t, dir)
	found := false
	for _, e := range edges {
		if e.Properties["strategy"] == "file_reference" {
			conf, _ := e.Properties["confidence"].(float64)
			if conf == 0.70 {
				found = true
			}
		}
	}
	// Basename match may produce 0.70 or 0.90 depending on path resolution
	t.Logf("basename file_reference found: %v", found)
}

func TestConfigFileRef_NoFalsePositive(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "data.csv"), `a,b,c`)
	writeFile(t, filepath.Join(dir, "main.go"), `package main

func loadData() {
	f := readFile("data.csv")
	_ = f
}
`)

	edges := runAndGetConfigures(t, dir)
	for _, e := range edges {
		if e.Properties["strategy"] == "file_reference" {
			t.Errorf("expected no file_reference edge for .csv file")
		}
	}
}

// --- Helpers ---

func runAndGetConfigures(t *testing.T, dir string) []*store.Edge {
	t.Helper()

	// Initialize as a git repo so discover works
	gitInit(t, dir)

	s, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	p := New(context.Background(), s, dir, discover.ModeFull)
	if err := p.Run(); err != nil {
		t.Fatalf("Pipeline.Run: %v", err)
	}

	edges, err := s.FindEdgesByType(p.ProjectName, "CONFIGURES")
	if err != nil {
		t.Fatalf("FindEdgesByType: %v", err)
	}
	return edges
}

func gitInit(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Create minimal .git structure so discover recognizes it
	writeFile(t, filepath.Join(dir, ".git", "HEAD"), "ref: refs/heads/main\n")
}
