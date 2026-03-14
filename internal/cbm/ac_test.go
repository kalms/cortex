package cbm

import (
	"strings"
	"testing"
)

func TestACBuild_Empty(t *testing.T) {
	ac := ACBuild(nil)
	if ac != nil {
		t.Fatal("expected nil for empty patterns")
	}
}

func TestACBuild_SinglePattern(t *testing.T) {
	ac := ACBuild([]string{"hello"})
	if ac == nil {
		t.Fatal("expected non-nil")
	}
	defer ac.Free()

	if ac.NumPatterns() != 1 {
		t.Fatalf("expected 1 pattern, got %d", ac.NumPatterns())
	}

	// Match
	mask := ac.ScanBitmask([]byte("say hello world"))
	if mask != 1 {
		t.Fatalf("expected bitmask 1, got %d", mask)
	}

	// No match
	mask = ac.ScanBitmask([]byte("say helo world"))
	if mask != 0 {
		t.Fatalf("expected bitmask 0, got %d", mask)
	}
}

func TestACBuild_MultiplePatterns(t *testing.T) {
	patterns := []string{"http.Get", "fetch(", "requests.post", "axios."}
	ac := ACBuild(patterns)
	if ac == nil {
		t.Fatal("expected non-nil")
	}
	defer ac.Free()

	tests := []struct {
		input    string
		expected uint64
	}{
		{"resp := http.Get(url)", 1 << 0},
		{"const r = fetch(url)", 1 << 1},
		{"requests.post(url, data)", 1 << 2},
		{"axios.get('/api')", 1 << 3},
		{"http.Get then fetch(", 1<<0 | 1<<1},
		{"no http calls here", 0},
		{"", 0},
	}

	for _, tt := range tests {
		mask := ac.ScanBitmask([]byte(tt.input))
		if mask != tt.expected {
			t.Errorf("input=%q: expected %064b, got %064b", tt.input, tt.expected, mask)
		}
	}
}

func TestACBuild_OverlappingPatterns(t *testing.T) {
	// "he", "her", "hers", "his" — classic AC example
	patterns := []string{"he", "her", "hers", "his"}
	ac := ACBuild(patterns)
	defer ac.Free()

	mask := ac.ScanBitmask([]byte("ushers"))
	// "he" at pos 2, "her" at pos 2, "hers" at pos 2
	expected := uint64(1<<0 | 1<<1 | 1<<2)
	if mask != expected {
		t.Errorf("expected %064b, got %064b", expected, mask)
	}
}

func TestACScanString(t *testing.T) {
	ac := ACBuild([]string{"foo", "bar"})
	defer ac.Free()

	mask := ac.ScanString("foobar")
	if mask != 3 {
		t.Fatalf("expected 3, got %d", mask)
	}
}

func TestACCompactAlphabet(t *testing.T) {
	// Build a compact alphabet: a-z=1..26, 0-9=27..36, _=37, everything else=0
	var alphaMap [256]byte
	idx := byte(1)
	for c := byte('a'); c <= byte('z'); c++ {
		alphaMap[c] = idx
		idx++
	}
	for c := byte('0'); c <= byte('9'); c++ {
		alphaMap[c] = idx
		idx++
	}
	alphaMap['_'] = idx
	alphaSize := int(idx) + 1 // 38

	patterns := []string{"database_url", "api_key", "port"}
	ac := ACBuildCompact(patterns, alphaMap, alphaSize)
	if ac == nil {
		t.Fatal("expected non-nil")
	}
	defer ac.Free()

	// Should match
	mask := ac.ScanString("database_url")
	if mask&1 == 0 {
		t.Error("expected database_url match")
	}

	// Substring match
	mask = ac.ScanString("my_database_url_setting")
	if mask&1 == 0 {
		t.Error("expected database_url substring match")
	}

	// Table should be much smaller than 256-alphabet
	tableMB := ac.TableBytes()
	t.Logf("compact table: %d states × %d alpha = %d bytes", ac.NumStates(), alphaSize, tableMB)
	if ac.NumStates()*alphaSize*4 != tableMB {
		t.Errorf("table size mismatch: expected %d, got %d", ac.NumStates()*alphaSize*4, tableMB)
	}
}

func TestACScanLZ4Bitmask(t *testing.T) {
	ac := ACBuild([]string{"http.Get", "fetch("})
	defer ac.Free()

	// Compress some source code
	source := []byte(`package main
import "net/http"
func doStuff() {
    resp, err := http.Get("https://example.com")
    _ = resp
    _ = err
}
`)
	compressed := LZ4CompressHC(source)
	if compressed == nil {
		t.Fatal("compression failed")
	}

	mask := ac.ScanLZ4Bitmask(compressed, len(source))
	if mask != 1 {
		t.Fatalf("expected bitmask 1 (http.Get), got %d", mask)
	}

	// No match
	noHTTP := []byte("package main\nfunc main() { println(42) }\n")
	comp2 := LZ4CompressHC(noHTTP)
	mask = ac.ScanLZ4Bitmask(comp2, len(noHTTP))
	if mask != 0 {
		t.Fatalf("expected 0, got %d", mask)
	}
}

func TestACScanLZ4Batch(t *testing.T) {
	ac := ACBuild([]string{"http.Get", "fetch(", "Route::get"})
	defer ac.Free()

	// Three files: one with http.Get, one with Route::get, one with nothing.
	files := []struct {
		src     string
		wantHit bool
	}{
		{`resp := http.Get("https://example.com")`, true},
		{`func main() { println(42) }`, false},
		{`Route::get("/users", "UserController@index")`, true},
	}

	entries := make([]LZ4Entry, len(files))
	for i, f := range files {
		src := []byte(f.src)
		entries[i] = LZ4Entry{Data: LZ4CompressHC(src), OriginalLen: len(src)}
	}

	matches := ac.ScanLZ4Batch(entries)

	// Should have 2 matches (files 0 and 2).
	if len(matches) != 2 {
		t.Fatalf("expected 2 matches, got %d", len(matches))
	}
	if matches[0].FileIndex != 0 || matches[0].Bitmask&1 == 0 {
		t.Errorf("expected file 0 to match http.Get, got idx=%d mask=%064b", matches[0].FileIndex, matches[0].Bitmask)
	}
	if matches[1].FileIndex != 2 || matches[1].Bitmask&4 == 0 {
		t.Errorf("expected file 2 to match Route::get, got idx=%d mask=%064b", matches[1].FileIndex, matches[1].Bitmask)
	}
}

func TestACScanLZ4Batch_Empty(t *testing.T) {
	ac := ACBuild([]string{"test"})
	defer ac.Free()
	matches := ac.ScanLZ4Batch(nil)
	if matches != nil {
		t.Fatal("expected nil for empty entries")
	}
}

func TestACScanBatch(t *testing.T) {
	patterns := []string{"database", "port", "host"}
	ac := ACBuild(patterns)
	defer ac.Free()

	names := []string{
		"database_url",   // matches "database"
		"server_port",    // matches "port"
		"api_key",        // no match
		"database_host",  // matches "database" and "host"
		"max_retries",    // no match
	}

	matches := ac.ScanBatch(names)

	// Collect by name index
	byName := make(map[int][]int)
	for _, m := range matches {
		byName[m.NameIndex] = append(byName[m.NameIndex], m.PatternID)
	}

	// database_url → pattern 0 (database)
	if pids, ok := byName[0]; !ok || len(pids) != 1 || pids[0] != 0 {
		t.Errorf("expected name 0 to match pattern 0, got %v", byName[0])
	}

	// server_port → pattern 1 (port)
	if pids, ok := byName[1]; !ok || len(pids) != 1 || pids[0] != 1 {
		t.Errorf("expected name 1 to match pattern 1, got %v", byName[1])
	}

	// api_key → no match
	if _, ok := byName[2]; ok {
		t.Errorf("expected name 2 to have no matches, got %v", byName[2])
	}

	// database_host → pattern 0 and 2
	if pids, ok := byName[3]; !ok || len(pids) != 2 {
		t.Errorf("expected name 3 to match 2 patterns, got %v", byName[3])
	}
}

func TestACFree_DoubleCall(t *testing.T) {
	ac := ACBuild([]string{"test"})
	ac.Free()
	ac.Free() // should not panic
}

func TestACFree_Nil(t *testing.T) {
	var ac *ACAutomaton
	ac.Free() // should not panic
}

func TestACScanBitmask_Empty(t *testing.T) {
	ac := ACBuild([]string{"test"})
	defer ac.Free()
	mask := ac.ScanBitmask(nil)
	if mask != 0 {
		t.Fatalf("expected 0, got %d", mask)
	}
}

func TestAC_LargePatternSet(t *testing.T) {
	// Build with all httplink keywords to verify real-world pattern count
	patterns := []string{
		"requests.get", "requests.post", "requests.put", "requests.delete", "requests.patch",
		"httpx.", "aiohttp.", "urllib.request",
		"http.Get", "http.Post", "http.NewRequest", "client.Do(",
		"fetch(", "axios.", ".ajax(",
		"HttpClient", "RestTemplate", "WebClient", "OkHttpClient",
		"HttpURLConnection", "openConnection(",
		"reqwest::", "hyper::", "surf::", "ureq::",
		"curl_exec", "curl_init", "Guzzle", "Http::get", "Http::post",
		"sttp.", "http4s", "wsClient",
		"curl_easy", "cpr::Get", "cpr::Post", "httplib::",
		"socket.http", "http.request",
		"RestClient", "HttpWebRequest",
		"ktor.client",
		"send_request", "http_client",
		"CreateTask", "create_task",
		"topic.Publish", "publisher.publish", "topic.publish",
		"sqs.send_message", "sns.publish",
		"basic_publish",
		"producer.send", "producer.Send",
	}

	// Deduplicate (HttpClient, OkHttpClient, WebClient appear multiple times)
	seen := make(map[string]bool)
	var unique []string
	for _, p := range patterns {
		if !seen[p] {
			seen[p] = true
			unique = append(unique, p)
		}
	}

	ac := ACBuild(unique)
	if ac == nil {
		t.Fatal("expected non-nil")
	}
	defer ac.Free()

	t.Logf("patterns=%d unique=%d states=%d table=%d bytes",
		len(patterns), len(unique), ac.NumStates(), ac.TableBytes())

	// Scan a Go source file
	source := `package main
import "net/http"
func callAPI() {
    resp, _ := http.Get("https://api.example.com/data")
    defer resp.Body.Close()
}
func createTask() {
    client.CreateTask(ctx, req)
}
`
	mask := ac.ScanBitmask([]byte(source))
	// Should match http.Get and CreateTask
	httpGetIdx := -1
	createTaskIdx := -1
	for i, p := range unique {
		if p == "http.Get" {
			httpGetIdx = i
		}
		if p == "CreateTask" {
			createTaskIdx = i
		}
	}
	if httpGetIdx >= 0 && mask&(1<<httpGetIdx) == 0 {
		t.Error("expected http.Get match")
	}
	if createTaskIdx >= 0 && mask&(1<<createTaskIdx) == 0 {
		t.Error("expected CreateTask match")
	}

	// Non-matching source
	mask = ac.ScanBitmask([]byte("func main() { fmt.Println(42) }"))
	if mask != 0 {
		t.Errorf("expected 0 for non-matching source, got %064b", mask)
	}
}

func BenchmarkACScan_TypicalSource(b *testing.B) {
	patterns := []string{
		"http.Get", "http.Post", "http.NewRequest", "client.Do(",
		"fetch(", "axios.", "requests.get", "requests.post",
		"HttpClient", "curl_exec", "CreateTask",
	}
	ac := ACBuild(patterns)
	defer ac.Free()

	// ~500 bytes of typical Go source (no HTTP calls)
	source := []byte(strings.Repeat("func process(ctx context.Context, data []byte) error {\n\tresult := transform(data)\n\treturn store.Save(ctx, result)\n}\n", 5))

	b.SetBytes(int64(len(source)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ac.ScanBitmask(source)
	}
}

func BenchmarkACScanLZ4_TypicalSource(b *testing.B) {
	patterns := []string{
		"http.Get", "http.Post", "http.NewRequest", "client.Do(",
		"fetch(", "axios.", "requests.get", "requests.post",
		"HttpClient", "curl_exec", "CreateTask",
	}
	ac := ACBuild(patterns)
	defer ac.Free()

	source := []byte(strings.Repeat("func process(ctx context.Context, data []byte) error {\n\tresult := transform(data)\n\treturn store.Save(ctx, result)\n}\n", 5))
	compressed := LZ4CompressHC(source)
	origLen := len(source)

	b.SetBytes(int64(origLen))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ac.ScanLZ4Bitmask(compressed, origLen)
	}
}

func BenchmarkACScanBatch_ConfigNames(b *testing.B) {
	patterns := []string{"database", "port", "host", "url", "timeout", "max", "min", "key", "secret"}
	ac := ACBuild(patterns)
	defer ac.Free()

	// Simulate 1000 normalized code names
	names := make([]string, 1000)
	for i := range names {
		names[i] = "some_function_name_with_typical_length"
	}
	names[42] = "get_database_url"
	names[500] = "server_port_number"

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ac.ScanBatch(names)
	}
}
