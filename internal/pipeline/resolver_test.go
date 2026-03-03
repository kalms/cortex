package pipeline

import (
	"math"
	"testing"
)

func TestFuzzyResolve_SingleCandidate(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("CreateOrder", "svcA.handlers.CreateOrder", "Function")
	reg.Register("ValidateOrder", "svcB.validators.ValidateOrder", "Function")

	// Normal resolve with no import map should find unique name
	result := reg.Resolve("CreateOrder", "svcC.caller", nil)
	if result.QualifiedName != "svcA.handlers.CreateOrder" {
		t.Errorf("Resolve: expected svcA.handlers.CreateOrder, got %s", result.QualifiedName)
	}

	// FuzzyResolve should find by simple name even with unknown prefix
	fuzzyResult, ok := reg.FuzzyResolve("unknownPkg.CreateOrder", "svcC.caller", nil)
	if !ok {
		t.Fatal("expected fuzzy match")
	}
	if fuzzyResult.QualifiedName != "svcA.handlers.CreateOrder" {
		t.Errorf("expected svcA.handlers.CreateOrder, got %s", fuzzyResult.QualifiedName)
	}
}

func TestFuzzyResolve_NonExistentName(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("CreateOrder", "svcA.handlers.CreateOrder", "Function")

	_, ok := reg.FuzzyResolve("NonExistent", "svcC.caller", nil)
	if ok {
		t.Fatal("expected no fuzzy match for non-existent name")
	}
}

func TestFuzzyResolve_MultipleCandidates_BestByDistance(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("Process", "svcA.handlers.Process", "Function")
	reg.Register("Process", "svcB.handlers.Process", "Function")

	// Caller is in svcA — should prefer svcA.handlers.Process
	fuzzyResult, ok := reg.FuzzyResolve("unknown.Process", "svcA.other", nil)
	if !ok {
		t.Fatal("expected fuzzy match")
	}
	if fuzzyResult.QualifiedName != "svcA.handlers.Process" {
		t.Errorf("expected svcA.handlers.Process, got %s", fuzzyResult.QualifiedName)
	}

	// Caller is in svcB — should prefer svcB.handlers.Process
	fuzzyResult, ok = reg.FuzzyResolve("unknown.Process", "svcB.other", nil)
	if !ok {
		t.Fatal("expected fuzzy match")
	}
	if fuzzyResult.QualifiedName != "svcB.handlers.Process" {
		t.Errorf("expected svcB.handlers.Process, got %s", fuzzyResult.QualifiedName)
	}
}

func TestFuzzyResolve_SimpleNameExtraction(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("DoWork", "myproject.utils.DoWork", "Function")

	// Deeply qualified callee — should extract "DoWork" as simple name
	fuzzyResult, ok := reg.FuzzyResolve("some.deep.module.DoWork", "myproject.caller", nil)
	if !ok {
		t.Fatal("expected fuzzy match")
	}
	if fuzzyResult.QualifiedName != "myproject.utils.DoWork" {
		t.Errorf("expected myproject.utils.DoWork, got %s", fuzzyResult.QualifiedName)
	}
}

func TestFuzzyResolve_NoMatchForBareName(t *testing.T) {
	reg := NewFunctionRegistry()
	// Register nothing

	_, ok := reg.FuzzyResolve("SomeFunc", "myproject.caller", nil)
	if ok {
		t.Fatal("expected no fuzzy match on empty registry")
	}
}

func TestRegistryExists(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("Foo", "pkg.module.Foo", "Function")
	reg.Register("Bar", "pkg.module.Bar", "Method")

	if !reg.Exists("pkg.module.Foo") {
		t.Error("expected Foo to exist")
	}
	if !reg.Exists("pkg.module.Bar") {
		t.Error("expected Bar to exist")
	}
	if reg.Exists("pkg.module.Missing") {
		t.Error("expected Missing to not exist")
	}
	if reg.Exists("") {
		t.Error("expected empty string to not exist")
	}
}

// --- Phase 1: Confidence scoring tests ---

func assertConfidence(t *testing.T, label string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 0.01 {
		t.Errorf("%s: confidence = %.2f, want %.2f", label, got, want)
	}
}

func TestResolveConfidence_ImportMap(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("Foo", "proj.other.Foo", "Function")

	imports := map[string]string{"other": "proj.other"}
	result := reg.Resolve("other.Foo", "proj.pkg", imports)
	if result.QualifiedName != "proj.other.Foo" {
		t.Fatalf("expected proj.other.Foo, got %s", result.QualifiedName)
	}
	assertConfidence(t, "import_map", result.Confidence, 0.95)
	if result.Strategy != "import_map" {
		t.Errorf("strategy = %s, want import_map", result.Strategy)
	}
}

func TestResolveConfidence_ImportMapSuffix(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("Foo", "proj.other.sub.Foo", "Function")

	imports := map[string]string{"other": "proj.other"}
	result := reg.Resolve("other.Foo", "proj.pkg", imports)
	if result.QualifiedName != "proj.other.sub.Foo" {
		t.Fatalf("expected proj.other.sub.Foo, got %s", result.QualifiedName)
	}
	assertConfidence(t, "import_map_suffix", result.Confidence, 0.85)
	if result.Strategy != "import_map_suffix" {
		t.Errorf("strategy = %s, want import_map_suffix", result.Strategy)
	}
}

func TestResolveConfidence_SameModule(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("Foo", "proj.pkg.Foo", "Function")

	result := reg.Resolve("Foo", "proj.pkg", nil)
	if result.QualifiedName != "proj.pkg.Foo" {
		t.Fatalf("expected proj.pkg.Foo, got %s", result.QualifiedName)
	}
	assertConfidence(t, "same_module", result.Confidence, 0.90)
	if result.Strategy != "same_module" {
		t.Errorf("strategy = %s, want same_module", result.Strategy)
	}
}

func TestResolveConfidence_UniqueName(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("Bar", "proj.pkg.Bar", "Function")

	result := reg.Resolve("Bar", "proj.unrelated", nil)
	if result.QualifiedName != "proj.pkg.Bar" {
		t.Fatalf("expected proj.pkg.Bar, got %s", result.QualifiedName)
	}
	assertConfidence(t, "unique_name", result.Confidence, 0.75)
	if result.Strategy != "unique_name" {
		t.Errorf("strategy = %s, want unique_name", result.Strategy)
	}
}

func TestResolveConfidence_SuffixMatch(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("Process", "proj.svcA.Process", "Function")
	reg.Register("Process", "proj.svcB.Process", "Function")

	result := reg.Resolve("Process", "proj.svcA.caller", nil)
	if result.QualifiedName != "proj.svcA.Process" {
		t.Fatalf("expected proj.svcA.Process, got %s", result.QualifiedName)
	}
	assertConfidence(t, "suffix_match", result.Confidence, 0.55)
	if result.Strategy != "suffix_match" {
		t.Errorf("strategy = %s, want suffix_match", result.Strategy)
	}
}

func TestFuzzyResolveConfidence_Single(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("Handler", "proj.svc.Handler", "Function")

	result, ok := reg.FuzzyResolve("unknownPkg.Handler", "proj.caller", nil)
	if !ok {
		t.Fatal("expected fuzzy match")
	}
	assertConfidence(t, "fuzzy_single", result.Confidence, 0.40)
	if result.Strategy != "fuzzy" {
		t.Errorf("strategy = %s, want fuzzy", result.Strategy)
	}
}

func TestFuzzyResolveConfidence_Distance(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("Process", "proj.svcA.Process", "Function")
	reg.Register("Process", "proj.svcB.Process", "Function")

	result, ok := reg.FuzzyResolve("unknownPkg.Process", "proj.svcA.other", nil)
	if !ok {
		t.Fatal("expected fuzzy match")
	}
	assertConfidence(t, "fuzzy_distance", result.Confidence, 0.30)
	if result.Strategy != "fuzzy" {
		t.Errorf("strategy = %s, want fuzzy", result.Strategy)
	}
}

// --- Phase 3: Negative import evidence tests ---

func TestNegativeImportEvidence_RejectsUnimported(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("Process", "proj.billing.Process", "Function")
	reg.Register("Process", "proj.handler.Process", "Function")

	// Import only handler's module — should prefer handler
	imports := map[string]string{"handler": "proj.handler"}
	result := reg.Resolve("Process", "proj.caller", imports)
	if result.QualifiedName != "proj.handler.Process" {
		t.Errorf("expected proj.handler.Process, got %s", result.QualifiedName)
	}
}

func TestNegativeImportEvidence_FuzzyPenalty(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("Handler", "proj.billing.Handler", "Function")

	// No import for billing module — confidence should be halved
	imports := map[string]string{"other": "proj.other"}
	result, ok := reg.FuzzyResolve("unknown.Handler", "proj.caller", imports)
	if !ok {
		t.Fatal("expected fuzzy match")
	}
	// 0.40 * 0.5 = 0.20 (penalty for unreachable import)
	assertConfidence(t, "fuzzy_penalty", result.Confidence, 0.20)
}

func TestNegativeImportEvidence_NoImportMapPassthrough(t *testing.T) {
	reg := NewFunctionRegistry()
	reg.Register("Handler", "proj.billing.Handler", "Function")

	// nil import map — no filtering, full confidence
	result, ok := reg.FuzzyResolve("unknown.Handler", "proj.caller", nil)
	if !ok {
		t.Fatal("expected fuzzy match")
	}
	assertConfidence(t, "no_importmap", result.Confidence, 0.40)
}

func TestConfidenceBand(t *testing.T) {
	tests := []struct {
		score float64
		want  string
	}{
		{0.95, "high"},
		{0.70, "high"},
		{0.55, "medium"},
		{0.45, "medium"},
		{0.40, "speculative"},
		{0.20, "speculative"},
	}
	for _, tt := range tests {
		got := confidenceBand(tt.score)
		if got != tt.want {
			t.Errorf("confidenceBand(%.2f) = %s, want %s", tt.score, got, tt.want)
		}
	}
}

func TestIsImportReachable(t *testing.T) {
	imports := map[string]string{
		"handler": "proj.handler",
		"utils":   "proj.shared.utils",
	}

	tests := []struct {
		candidate string
		want      bool
	}{
		{"proj.handler.Process", true},
		{"proj.handler.sub.Process", true},
		{"proj.shared.utils.Helper", true},
		{"proj.billing.Process", false},
		{"unrelated.pkg.Func", false},
	}
	for _, tt := range tests {
		got := isImportReachable(tt.candidate, imports)
		if got != tt.want {
			t.Errorf("isImportReachable(%s) = %v, want %v", tt.candidate, got, tt.want)
		}
	}
}
