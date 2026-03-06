package cbm

import (
	"testing"

	"github.com/DeusData/codebase-memory-mcp/internal/lang"
)

// --- TOML Tests ---

func TestTOMLBasicTableAndPair(t *testing.T) {
	source := []byte("[database]\nhost = \"localhost\"\nport = 5432\n")
	result, err := ExtractFile(source, lang.TOML, "test", "config.toml")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	vars := defsWithLabel(result, "Variable")
	if len(classes) != 1 || classes[0].Name != "database" {
		t.Errorf("expected 1 Class 'database', got %d: %v", len(classes), names(classes))
	}
	if len(vars) < 2 {
		t.Errorf("expected >=2 Variables (host, port), got %d: %v", len(vars), names(vars))
	}
	assertHasName(t, vars, "host")
	assertHasName(t, vars, "port")
}

func TestTOMLNestedTable(t *testing.T) {
	source := []byte("[server.http]\nport = 8080\n")
	result, err := ExtractFile(source, lang.TOML, "test", "config.toml")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	if len(classes) < 1 {
		t.Errorf("expected >=1 Class for nested table, got %d", len(classes))
	}
}

func TestTOMLTableArrayElement(t *testing.T) {
	source := []byte("[[servers]]\nname = \"alpha\"\n[[servers]]\nname = \"beta\"\n")
	result, err := ExtractFile(source, lang.TOML, "test", "config.toml")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	vars := defsWithLabel(result, "Variable")
	if len(classes) < 2 {
		t.Errorf("expected >=2 Classes for table array, got %d: %v", len(classes), names(classes))
	}
	if len(vars) < 2 {
		t.Errorf("expected >=2 Variables, got %d: %v", len(vars), names(vars))
	}
}

func TestTOMLDottedKey(t *testing.T) {
	source := []byte("database.host = \"localhost\"\n")
	result, err := ExtractFile(source, lang.TOML, "test", "config.toml")
	if err != nil {
		t.Fatal(err)
	}
	vars := defsWithLabel(result, "Variable")
	if len(vars) < 1 {
		t.Errorf("expected >=1 Variable for dotted key, got %d", len(vars))
	}
}

func TestTOMLQuotedKey(t *testing.T) {
	source := []byte("\"unusual-key\" = \"value\"\n")
	result, err := ExtractFile(source, lang.TOML, "test", "config.toml")
	if err != nil {
		t.Fatal(err)
	}
	vars := defsWithLabel(result, "Variable")
	if len(vars) < 1 {
		t.Errorf("expected >=1 Variable for quoted key, got %d", len(vars))
	}
}

func TestTOMLEmptyTable(t *testing.T) {
	source := []byte("[empty]\n")
	result, err := ExtractFile(source, lang.TOML, "test", "config.toml")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	vars := defsWithLabel(result, "Variable")
	if len(classes) != 1 || classes[0].Name != "empty" {
		t.Errorf("expected 1 Class 'empty', got %d: %v", len(classes), names(classes))
	}
	if len(vars) != 0 {
		t.Errorf("expected 0 Variables, got %d: %v", len(vars), names(vars))
	}
}

func TestTOMLCommentsOnly(t *testing.T) {
	source := []byte("# just a comment\n# another comment\n")
	result, err := ExtractFile(source, lang.TOML, "test", "config.toml")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	vars := defsWithLabel(result, "Variable")
	if len(classes) != 0 {
		t.Errorf("expected 0 Classes, got %d: %v", len(classes), names(classes))
	}
	if len(vars) != 0 {
		t.Errorf("expected 0 Variables, got %d: %v", len(vars), names(vars))
	}
}

func TestTOMLBooleanAndIntegerValues(t *testing.T) {
	source := []byte("enabled = true\ncount = 42\nname = \"test\"\n")
	result, err := ExtractFile(source, lang.TOML, "test", "config.toml")
	if err != nil {
		t.Fatal(err)
	}
	vars := defsWithLabel(result, "Variable")
	if len(vars) < 3 {
		t.Errorf("expected >=3 Variables, got %d: %v", len(vars), names(vars))
	}
}

// --- INI Tests ---

func TestINIBasicSectionAndSetting(t *testing.T) {
	source := []byte("[database]\nhost = localhost\nport = 5432\n")
	result, err := ExtractFile(source, lang.INI, "test", "config.ini")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	vars := defsWithLabel(result, "Variable")
	if len(classes) < 1 {
		t.Errorf("expected >=1 Class (database section), got %d: %v", len(classes), names(classes))
	}
	if len(vars) < 2 {
		t.Errorf("expected >=2 Variables (host, port), got %d: %v", len(vars), names(vars))
	}
}

func TestINIMultipleSections(t *testing.T) {
	source := []byte("[section1]\nkey1 = val1\n[section2]\nkey2 = val2\n")
	result, err := ExtractFile(source, lang.INI, "test", "config.ini")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	vars := defsWithLabel(result, "Variable")
	if len(classes) < 2 {
		t.Errorf("expected >=2 Classes, got %d: %v", len(classes), names(classes))
	}
	if len(vars) < 2 {
		t.Errorf("expected >=2 Variables, got %d: %v", len(vars), names(vars))
	}
}

func TestINIGlobalKeys(t *testing.T) {
	source := []byte("key1 = value1\nkey2 = value2\n")
	result, err := ExtractFile(source, lang.INI, "test", "config.ini")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	vars := defsWithLabel(result, "Variable")
	if len(classes) != 0 {
		t.Errorf("expected 0 Classes (no sections), got %d: %v", len(classes), names(classes))
	}
	if len(vars) < 2 {
		t.Errorf("expected >=2 Variables, got %d: %v", len(vars), names(vars))
	}
}

func TestINIComments(t *testing.T) {
	source := []byte("; comment\n# another comment\n[section]\nkey = val\n")
	result, err := ExtractFile(source, lang.INI, "test", "config.ini")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	vars := defsWithLabel(result, "Variable")
	if len(classes) < 1 {
		t.Errorf("expected >=1 Class, got %d: %v", len(classes), names(classes))
	}
	if len(vars) < 1 {
		t.Errorf("expected >=1 Variable, got %d: %v", len(vars), names(vars))
	}
}

// --- JSON Tests ---

func TestJSONBasicPair(t *testing.T) {
	source := []byte(`{"host": "localhost", "port": 5432}`)
	result, err := ExtractFile(source, lang.JSON, "test", "config.json")
	if err != nil {
		t.Fatal(err)
	}
	vars := defsWithLabel(result, "Variable")
	if len(vars) < 2 {
		t.Errorf("expected >=2 Variables (host, port), got %d: %v", len(vars), names(vars))
	}
	assertHasName(t, vars, "host")
	assertHasName(t, vars, "port")
}

func TestJSONNestedObject(t *testing.T) {
	source := []byte(`{"database": {"host": "localhost", "port": 5432}}`)
	result, err := ExtractFile(source, lang.JSON, "test", "config.json")
	if err != nil {
		t.Fatal(err)
	}
	vars := defsWithLabel(result, "Variable")
	if len(vars) < 3 {
		t.Errorf("expected >=3 Variables (database, host, port), got %d: %v", len(vars), names(vars))
	}
}

func TestJSONEmptyObject(t *testing.T) {
	source := []byte(`{}`)
	result, err := ExtractFile(source, lang.JSON, "test", "config.json")
	if err != nil {
		t.Fatal(err)
	}
	vars := defsWithLabel(result, "Variable")
	if len(vars) != 0 {
		t.Errorf("expected 0 Variables, got %d: %v", len(vars), names(vars))
	}
}

func TestJSONBooleanNullValues(t *testing.T) {
	source := []byte(`{"enabled": true, "value": null, "name": "test"}`)
	result, err := ExtractFile(source, lang.JSON, "test", "config.json")
	if err != nil {
		t.Fatal(err)
	}
	vars := defsWithLabel(result, "Variable")
	if len(vars) < 3 {
		t.Errorf("expected >=3 Variables, got %d: %v", len(vars), names(vars))
	}
}

func TestJSONPackageJsonDeps(t *testing.T) {
	source := []byte(`{"name":"pkg","dependencies":{"express":"^4.0","lodash":"^4.17"}}`)
	result, err := ExtractFile(source, lang.JSON, "test", "package.json")
	if err != nil {
		t.Fatal(err)
	}
	vars := defsWithLabel(result, "Variable")
	if len(vars) < 4 {
		t.Errorf("expected >=4 Variables (name, dependencies, express, lodash), got %d: %v", len(vars), names(vars))
	}
	assertHasName(t, vars, "name")
	assertHasName(t, vars, "dependencies")
	assertHasName(t, vars, "express")
	assertHasName(t, vars, "lodash")
}

// --- XML Tests ---

func TestXMLBasicElement(t *testing.T) {
	source := []byte(`<?xml version="1.0"?><config><database><host>localhost</host></database></config>`)
	result, err := ExtractFile(source, lang.XML, "test", "config.xml")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	if len(classes) < 3 {
		t.Errorf("expected >=3 Classes (config, database, host), got %d: %v", len(classes), names(classes))
	}
	assertHasName(t, classes, "config")
	assertHasName(t, classes, "database")
	assertHasName(t, classes, "host")
}

func TestXMLSelfClosingTag(t *testing.T) {
	source := []byte(`<?xml version="1.0"?><config><feature enabled="true"/></config>`)
	result, err := ExtractFile(source, lang.XML, "test", "config.xml")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	if len(classes) < 2 {
		t.Errorf("expected >=2 Classes (config, feature), got %d: %v", len(classes), names(classes))
	}
}

func TestXMLEmptyDocument(t *testing.T) {
	source := []byte(`<?xml version="1.0"?><root/>`)
	result, err := ExtractFile(source, lang.XML, "test", "config.xml")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	if len(classes) < 1 {
		t.Errorf("expected >=1 Class (root), got %d: %v", len(classes), names(classes))
	}
}

func TestXMLMultipleChildren(t *testing.T) {
	source := []byte(`<?xml version="1.0"?><servers><server/><server/><server/></servers>`)
	result, err := ExtractFile(source, lang.XML, "test", "config.xml")
	if err != nil {
		t.Fatal(err)
	}
	classes := defsWithLabel(result, "Class")
	// servers + 3x server = 4
	if len(classes) < 4 {
		t.Errorf("expected >=4 Classes (servers + 3x server), got %d: %v", len(classes), names(classes))
	}
}

// --- Markdown Tests ---

func TestMarkdownATXHeadings(t *testing.T) {
	source := []byte("# Title\n## Section\n### Subsection\n")
	result, err := ExtractFile(source, lang.Markdown, "test", "README.md")
	if err != nil {
		t.Fatal(err)
	}
	sections := defsWithLabel(result, "Section")
	if len(sections) < 3 {
		t.Errorf("expected >=3 Section nodes, got %d: %v", len(sections), names(sections))
	}
	// Must NOT produce Class nodes
	classes := defsWithLabel(result, "Class")
	if len(classes) != 0 {
		t.Errorf("Markdown should produce Section, not Class, got %d Class nodes", len(classes))
	}
}

func TestMarkdownSetextHeadings(t *testing.T) {
	source := []byte("Title\n=====\nSection\n------\n")
	result, err := ExtractFile(source, lang.Markdown, "test", "README.md")
	if err != nil {
		t.Fatal(err)
	}
	sections := defsWithLabel(result, "Section")
	if len(sections) < 2 {
		t.Errorf("expected >=2 Section nodes, got %d: %v", len(sections), names(sections))
	}
}

func TestMarkdownHeadingContent(t *testing.T) {
	source := []byte("# Installation Guide\n## Prerequisites\n## Setup\n")
	result, err := ExtractFile(source, lang.Markdown, "test", "README.md")
	if err != nil {
		t.Fatal(err)
	}
	sections := defsWithLabel(result, "Section")
	if len(sections) < 3 {
		t.Errorf("expected >=3 Section nodes, got %d: %v", len(sections), names(sections))
	}
	assertHasName(t, sections, "Installation Guide")
	assertHasName(t, sections, "Prerequisites")
	assertHasName(t, sections, "Setup")
}

func TestMarkdownNoHeadings(t *testing.T) {
	source := []byte("Just a paragraph\n\nAnother paragraph\n")
	result, err := ExtractFile(source, lang.Markdown, "test", "README.md")
	if err != nil {
		t.Fatal(err)
	}
	sections := defsWithLabel(result, "Section")
	if len(sections) != 0 {
		t.Errorf("expected 0 Sections, got %d: %v", len(sections), names(sections))
	}
}

// --- Test Helpers ---

type defInfo struct {
	Name  string
	Label string
}

func defsWithLabel(result *FileResult, label string) []defInfo {
	var out []defInfo
	for _, d := range result.Definitions {
		if d.Label == label {
			out = append(out, defInfo{Name: d.Name, Label: d.Label})
		}
	}
	return out
}

func names(defs []defInfo) []string {
	var out []string
	for _, d := range defs {
		out = append(out, d.Name)
	}
	return out
}

func assertHasName(t *testing.T, defs []defInfo, name string) {
	t.Helper()
	for _, d := range defs {
		if d.Name == name {
			return
		}
	}
	t.Errorf("expected to find name %q in %v", name, names(defs))
}
