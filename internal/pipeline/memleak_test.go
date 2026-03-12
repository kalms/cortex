package pipeline

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"testing"

	"github.com/DeusData/codebase-memory-mcp/internal/discover"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// TestMemoryStability indexes a small fixture repo N times and asserts
// that heap usage does not grow unboundedly between iterations.
// Uses HeapInuse as the primary metric (cross-platform). RSS via
// syscall.Getrusage would also capture C-side allocations but is
// Unix-only; HeapInuse catches Go-side leaks which are the main concern.
func TestMemoryStability(t *testing.T) {
	// Create a minimal fixture repo with enough files to exercise the pipeline.
	fixtureDir := t.TempDir()
	writeFixtureFiles(t, fixtureDir)

	dbDir := t.TempDir()
	const projectName = "memleak-test"
	const iterations = 5

	heapSamples := make([]uint64, iterations)

	for i := 0; i < iterations; i++ {
		st, err := store.OpenInDir(dbDir, projectName)
		if err != nil {
			t.Fatalf("iter %d: open store: %v", i, err)
		}

		p := New(context.Background(), st, fixtureDir, discover.ModeFull)
		if err := p.Run(); err != nil {
			st.Close()
			t.Fatalf("iter %d: pipeline.Run: %v", i, err)
		}
		st.Close()

		// Force GC + return memory to OS
		runtime.GC()
		debug.FreeOSMemory()

		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		heapSamples[i] = m.HeapInuse

		t.Logf("iter %d: heap_inuse=%d MB, heap_alloc=%d MB, sys=%d MB",
			i, m.HeapInuse/(1<<20), m.HeapAlloc/(1<<20), m.Sys/(1<<20))
	}

	// Compare first iteration (after warm-up) to last.
	// Allow 30% growth to account for CI runner variance and GC timing.
	baseline := heapSamples[0]
	final := heapSamples[iterations-1]

	if baseline == 0 {
		t.Log("baseline heap is 0, skipping growth check")
		return
	}

	growthPct := float64(final-baseline) / float64(baseline) * 100
	t.Logf("heap growth: baseline=%d MB, final=%d MB, growth=%.1f%%",
		baseline/(1<<20), final/(1<<20), growthPct)

	if final > baseline && growthPct > 30.0 {
		t.Errorf("heap grew %.1f%% over %d iterations (baseline=%d, final=%d) — possible memory leak",
			growthPct, iterations, baseline, final)
	}
}

// writeFixtureFiles creates a small multi-language fixture repo.
func writeFixtureFiles(t *testing.T, dir string) {
	t.Helper()

	files := map[string]string{
		"main.go": `package main

import "fmt"

func main() {
	fmt.Println(greet("world"))
}

func greet(name string) string {
	return "hello " + name
}
`,
		"util.go": `package main

func add(a, b int) int {
	return a + b
}

func multiply(a, b int) int {
	return a * b
}
`,
		"handler.go": `package main

import "net/http"

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
	w.Write([]byte("ok"))
}

func handleReady(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
}
`,
		"lib/calc.py": `
def calculate(x, y):
    return x + y

def divide(x, y):
    if y == 0:
        raise ValueError("division by zero")
    return x / y

class Calculator:
    def __init__(self):
        self.history = []

    def add(self, a, b):
        result = calculate(a, b)
        self.history.append(result)
        return result
`,
		"src/app.js": `
function fetchData(url) {
    return fetch(url).then(res => res.json());
}

function processData(data) {
    return data.map(item => item.value);
}

class DataService {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }

    async getAll() {
        return fetchData(this.baseUrl + '/items');
    }
}
`,
	}

	for relPath, content := range files {
		absPath := filepath.Join(dir, relPath)
		if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absPath, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// Create a .git directory marker so discover treats it as a repo root.
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
}
