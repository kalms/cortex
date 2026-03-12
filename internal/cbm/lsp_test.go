package cbm

import (
	"testing"

	"github.com/DeusData/codebase-memory-mcp/internal/lang"
)

// findResolvedCall searches for a resolved call matching caller and callee substrings.
func findResolvedCall(t *testing.T, result *FileResult, callerContains, calleeContains string) *ResolvedCall {
	t.Helper()
	for i, rc := range result.ResolvedCalls {
		if contains(rc.CallerQN, callerContains) && contains(rc.CalleeQN, calleeContains) {
			return &result.ResolvedCalls[i]
		}
	}
	return nil
}

func contains(s, substr string) bool {
	return len(substr) == 0 || len(s) >= len(substr) && searchSubstring(s, substr)
}

func searchSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func requireResolvedCall(t *testing.T, result *FileResult, callerContains, calleeContains string) *ResolvedCall {
	t.Helper()
	rc := findResolvedCall(t, result, callerContains, calleeContains)
	if rc == nil {
		t.Errorf("expected resolved call: caller~%q -> callee~%q, got %d resolved calls:",
			callerContains, calleeContains, len(result.ResolvedCalls))
		for _, r := range result.ResolvedCalls {
			t.Logf("  %s -> %s [%s %.2f]", r.CallerQN, r.CalleeQN, r.Strategy, r.Confidence)
		}
		t.FailNow()
	}
	return rc
}

func findAllResolvedCalls(t *testing.T, result *FileResult, callerContains, calleeContains string) []ResolvedCall {
	t.Helper()
	var matches []ResolvedCall
	for _, rc := range result.ResolvedCalls {
		if contains(rc.CallerQN, callerContains) && contains(rc.CalleeQN, calleeContains) {
			matches = append(matches, rc)
		}
	}
	return matches
}

// extractGoWithRegistry extracts a Go file and returns the result.
// The test files define their own types/functions inline, so the LSP resolver
// must use the file's own definitions as the type registry.
func extractGoWithRegistry(t *testing.T, source string) *FileResult {
	t.Helper()
	result, err := ExtractFile([]byte(source), lang.Go, "test", "main.go")
	if err != nil {
		t.Fatalf("ExtractFile failed: %v", err)
	}
	return result
}

// ============================================================================
// Test Category 1: Parameter type inference
// ============================================================================

func TestGoLSP_ParamTypeInference_Simple(t *testing.T) {
	source := `package main

type Database struct{}

func (d *Database) Query(sql string) string { return "" }

func doWork(db *Database) {
	db.Query("SELECT 1")
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "doWork", "Query")
}

func TestGoLSP_ParamTypeInference_MultiParam(t *testing.T) {
	source := `package main

type Logger struct{}
type Config struct{}

func (l *Logger) Info(msg string) {}
func (c *Config) Get(key string) string { return "" }

func setup(log *Logger, cfg *Config) {
	log.Info("starting")
	cfg.Get("port")
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "setup", "Info")
	requireResolvedCall(t, result, "setup", "Get")
}

// ============================================================================
// Test Category 2: Return type propagation
// ============================================================================

func TestGoLSP_ReturnTypePropagation(t *testing.T) {
	source := `package main

type File struct{}

func (f *File) Read(buf []byte) int { return 0 }
func Open(path string) *File { return nil }

func doRead() {
	f := Open("/tmp/test")
	f.Read(nil)
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "doRead", "Read")
}

func TestGoLSP_ReturnTypePropagation_Chain(t *testing.T) {
	source := `package main

type Builder struct{}
type Result struct{}

func (b *Builder) Build() *Result { return nil }
func (r *Result) String() string { return "" }
func NewBuilder() *Builder { return nil }

func doChain() {
	b := NewBuilder()
	r := b.Build()
	r.String()
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "doChain", "Build")
	requireResolvedCall(t, result, "doChain", "String")
}

// ============================================================================
// Test Category 3: Method chaining
// ============================================================================

func TestGoLSP_MethodChaining(t *testing.T) {
	source := `package main

type Query struct{}

func (q *Query) Where(cond string) *Query { return q }
func (q *Query) Limit(n int) *Query { return q }
func (q *Query) Execute() int { return 0 }
func NewQuery() *Query { return nil }

func doQuery() {
	NewQuery().Where("x=1").Limit(10).Execute()
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "doQuery", "Where")
	requireResolvedCall(t, result, "doQuery", "Limit")
	requireResolvedCall(t, result, "doQuery", "Execute")
}

// ============================================================================
// Test Category 4: Multi-return
// ============================================================================

func TestGoLSP_MultiReturn(t *testing.T) {
	source := `package main

type Conn struct{}

func (c *Conn) Close() error { return nil }
func Dial(addr string) (*Conn, error) { return nil, nil }

func doConnect() {
	c, _ := Dial("localhost")
	c.Close()
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "doConnect", "Close")
}

// ============================================================================
// Test Category 5: Channel receive
// ============================================================================

func TestGoLSP_ChannelReceive(t *testing.T) {
	source := `package main

type Event struct{}

func (e *Event) Process() {}

func handleEvents(ch chan *Event) {
	e := <-ch
	e.Process()
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "handleEvents", "Process")
}

// ============================================================================
// Test Category 6: Range variables
// ============================================================================

func TestGoLSP_RangeSlice(t *testing.T) {
	source := `package main

type User struct{}

func (u *User) Name() string { return "" }

func listNames(users []*User) {
	for _, u := range users {
		u.Name()
	}
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "listNames", "Name")
}

func TestGoLSP_RangeMap(t *testing.T) {
	source := `package main

type Service struct{}

func (s *Service) Start() {}

func startAll(services map[string]*Service) {
	for _, svc := range services {
		svc.Start()
	}
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "startAll", "Start")
}

// ============================================================================
// Test Category 7: Type switch
// ============================================================================

func TestGoLSP_TypeSwitch(t *testing.T) {
	source := `package main

type Dog struct{}
type Cat struct{}

func (d *Dog) Speak() string { return "woof" }
func (c *Cat) Speak() string { return "meow" }

func describe(animal interface{}) {
	switch a := animal.(type) {
	case *Dog:
		a.Speak()
	case *Cat:
		a.Speak()
	}
}
`
	result := extractGoWithRegistry(t, source)
	// Should find Speak resolved in at least one case clause
	calls := findAllResolvedCalls(t, result, "describe", "Speak")
	if len(calls) == 0 {
		t.Fatalf("expected type switch to resolve a.Speak(), got 0 resolved calls")
	}
	// Should be type_dispatch since the case narrows to *Dog or *Cat
	for _, rc := range calls {
		if rc.Strategy != "lsp_type_dispatch" {
			t.Errorf("expected lsp_type_dispatch, got %s for %s", rc.Strategy, rc.CalleeQN)
		}
	}
}

// ============================================================================
// Test Category 8: Closures
// ============================================================================

func TestGoLSP_Closure(t *testing.T) {
	source := `package main

type Database struct{}

func (db *Database) Query() {}

func startWorker(db *Database) {
	go func() {
		db.Query()
	}()
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "startWorker", "Query")
}

// ============================================================================
// Test Category 9: Composite literals
// ============================================================================

func TestGoLSP_CompositeLiteral(t *testing.T) {
	source := `package main

type Config struct{}

func (c *Config) Validate() bool { return true }

func makeConfig() {
	c := &Config{}
	c.Validate()
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "makeConfig", "Validate")
}

func TestGoLSP_CompositeLiteralDirect(t *testing.T) {
	source := `package main

type Handler struct{}

func (h *Handler) ServeHTTP() {}

func serve() {
	(&Handler{}).ServeHTTP()
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "serve", "ServeHTTP")
}

// ============================================================================
// Test Category 10: Builtins
// ============================================================================

func TestGoLSP_MakeSlice(t *testing.T) {
	source := `package main

type Item struct{}

func (it *Item) Process() {}

func work() {
	items := make([]*Item, 0)
	items[0].Process()
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "work", "Process")
}

// ============================================================================
// Test Category 11: Type assertions
// ============================================================================

func TestGoLSP_TypeAssertion(t *testing.T) {
	source := `package main

type Writer struct{}

func (w *Writer) Write(data []byte) int { return 0 }

func writeData(x interface{}) {
	w := x.(*Writer)
	w.Write(nil)
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "writeData", "Write")
}

// ============================================================================
// Test Category 12: Struct embedding
// ============================================================================

func TestGoLSP_StructEmbedding(t *testing.T) {
	source := `package main

type Base struct{}

func (b *Base) Save() {}

type Extended struct {
	Base
}

func persist(e *Extended) {
	e.Save()
}
`
	result := extractGoWithRegistry(t, source)
	rc := requireResolvedCall(t, result, "persist", "Save")
	if rc.Strategy != "lsp_embed_dispatch" {
		t.Errorf("expected lsp_embed_dispatch, got %s", rc.Strategy)
	}
}

// ============================================================================
// Test Category 13: Interface dispatch
// ============================================================================

func TestGoLSP_InterfaceDispatch(t *testing.T) {
	source := `package main

type Writer interface {
	Write(data []byte) int
}

func writeAll(w Writer) {
	w.Write(nil)
}
`
	result := extractGoWithRegistry(t, source)
	rc := requireResolvedCall(t, result, "writeAll", "Write")
	if rc.Strategy != "lsp_interface_dispatch" {
		t.Errorf("expected lsp_interface_dispatch, got %s", rc.Strategy)
	}
	if rc.Confidence > 0.90 {
		t.Errorf("interface dispatch should have lower confidence, got %.2f", rc.Confidence)
	}
}

// ============================================================================
// Test Category 14-15: Generics
// ============================================================================

func TestGoLSP_ExplicitGenerics(t *testing.T) {
	source := `package main

type User struct{}
func (u User) Name() string { return "" }

type Result struct{}
func (r Result) Value() int { return 0 }

func Filter[T any, U any](s []T, pred func(T) bool) []U {
	return nil
}

func Transform[T any, R any](input T, f func(T) R) R {
	return f(input)
}

func main() {
	var users []User
	u := Filter[User, User](users, nil)
	_ = u

	r := Transform[User, Result](users[0], func(u User) Result { return Result{} })
	r.Value()
}
`
	result := extractGoWithRegistry(t, source)
	t.Logf("Definitions (%d):", len(result.Definitions))
	for _, d := range result.Definitions {
		t.Logf("  %s [%s] QN=%s ReturnTypes=%v", d.Name, d.Label, d.QualifiedName, d.ReturnTypes)
	}
	t.Logf("Calls (%d):", len(result.Calls))
	for _, c := range result.Calls {
		t.Logf("  %s -> %s", c.EnclosingFuncQN, c.CalleeName)
	}
	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	// Filter[User, User](...) should resolve
	requireResolvedCall(t, result, "main", "Filter")

	// Transform[User, Result](...) should resolve, and r.Value() should resolve
	// because Transform's return type R is substituted with Result
	requireResolvedCall(t, result, "main", "Transform")
	requireResolvedCall(t, result, "main", "Value")
}

func TestGoLSP_ImplicitGenerics(t *testing.T) {
	source := `package main

type User struct{}
func (u User) Name() string { return "" }

func Filter[T any](s []T, pred func(T) bool) []T { return nil }

func main() {
	var users []User
	result := Filter(users, func(u User) bool { return true })
	for _, u := range result {
		u.Name()
	}
}
`
	result := extractGoWithRegistry(t, source)
	for _, d := range result.Definitions {
		t.Logf("  %s [%s] QN=%s ReturnTypes=%v", d.Name, d.Label, d.QualifiedName, d.ReturnTypes)
	}
	for _, c := range result.Calls {
		t.Logf("  %s -> %s", c.EnclosingFuncQN, c.CalleeName)
	}
	for _, r := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", r.CallerQN, r.CalleeQN, r.Strategy, r.Confidence)
	}
	requireResolvedCall(t, result, "main", "Filter")
	// Implicit inference: Filter(users, pred) → T=User → returns []User
	// Range over []User → u:User → u.Name() resolves
	requireResolvedCall(t, result, "main", "Name")
}

// ============================================================================
// Test: Step 0 data wires (return_types, param_names)
// ============================================================================

func TestGoLSP_ReturnTypesExtracted(t *testing.T) {
	source := `package main

type Foo struct{}

func GetFoo() *Foo { return nil }
func Multi() (int, error) { return 0, nil }
`
	result := extractGoWithRegistry(t, source)

	// Check that return_types is populated
	for _, d := range result.Definitions {
		if d.Name == "GetFoo" {
			if len(d.ReturnTypes) == 0 {
				t.Errorf("GetFoo should have return_types, got none. ReturnType=%q", d.ReturnType)
			} else {
				t.Logf("GetFoo return_types: %v", d.ReturnTypes)
			}
		}
		if d.Name == "Multi" {
			if len(d.ReturnTypes) < 2 {
				t.Errorf("Multi should have 2 return_types, got %d: %v", len(d.ReturnTypes), d.ReturnTypes)
			} else {
				t.Logf("Multi return_types: %v", d.ReturnTypes)
			}
		}
	}
}

func TestGoLSP_ParamNamesExtracted(t *testing.T) {
	source := `package main

func Process(name string, count int, verbose bool) {}
`
	result := extractGoWithRegistry(t, source)

	for _, d := range result.Definitions {
		if d.Name == "Process" {
			if len(d.ParamNames) < 3 {
				t.Errorf("Process should have 3 param_names, got %d: %v", len(d.ParamNames), d.ParamNames)
			} else {
				t.Logf("Process param_names: %v", d.ParamNames)
				expected := []string{"name", "count", "verbose"}
				for i, exp := range expected {
					if i < len(d.ParamNames) && d.ParamNames[i] != exp {
						t.Errorf("param_names[%d] = %q, want %q", i, d.ParamNames[i], exp)
					}
				}
			}
		}
	}
}

// ============================================================================
// Test: Direct function calls (LSP direct resolution)
// ============================================================================

func TestGoLSP_DirectFuncCall(t *testing.T) {
	source := `package main

func helper() int { return 42 }

func caller() {
	helper()
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "caller", "helper")
}

// ============================================================================
// Test: Stdlib integration (os.Open, http.NewRequest, etc.)
// ============================================================================

func TestGoLSP_StdlibOsOpen(t *testing.T) {
	source := `package main

import "os"

func readFile(path string) {
	f, _ := os.Open(path)
	f.Close()
}
`
	result := extractGoWithRegistry(t, source)

	// Debug: show all resolved calls and definitions
	t.Logf("Definitions (%d):", len(result.Definitions))
	for _, d := range result.Definitions {
		t.Logf("  %s [%s] QN=%s ReturnType=%q ReturnTypes=%v",
			d.Name, d.Label, d.QualifiedName, d.ReturnType, d.ReturnTypes)
	}
	t.Logf("Calls (%d):", len(result.Calls))
	for _, c := range result.Calls {
		t.Logf("  %s -> %s", c.EnclosingFuncQN, c.CalleeName)
	}
	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}
	t.Logf("Imports (%d):", len(result.Imports))
	for _, imp := range result.Imports {
		t.Logf("  %s -> %s", imp.LocalName, imp.ModulePath)
	}

	// os.Open should resolve via LSP (stdlib registered)
	requireResolvedCall(t, result, "readFile", "os.Open")
	// f.Close() resolves: os.Open returns (*os.File, error), tuple decomposition binds f to *os.File
	requireResolvedCall(t, result, "readFile", "Close")
}

func TestGoLSP_StdlibFmtSprintf(t *testing.T) {
	source := `package main

import "fmt"

func format(name string) string {
	return fmt.Sprintf("hello %s", name)
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "format", "fmt.Sprintf")
}

// ============================================================================
// Test: Cross-file resolution
// ============================================================================

func TestGoLSP_CrossFile_MethodDispatch(t *testing.T) {
	// File defines a function that uses a type from another package.
	// The cross-file defs tell the LSP about the remote type and its methods.
	source := `package main

import "myapp/db"

func doQuery() {
	conn := db.Connect("localhost")
	conn.Query("SELECT 1")
}
`
	moduleQN := "test.main"

	// File-local defs: just the function doQuery
	fileDefs := []CrossFileDef{
		{
			QualifiedName: "test.main.doQuery",
			ShortName:     "doQuery",
			Label:         "Function",
			DefModuleQN:   moduleQN,
		},
	}

	// Cross-file defs: db.Connect (returns *Conn), db.Conn type, db.Conn.Query method
	crossDefs := []CrossFileDef{
		{
			QualifiedName: "myapp/db.Connect",
			ShortName:     "Connect",
			Label:         "Function",
			DefModuleQN:   "myapp/db",
			ReturnTypes:   "*Conn",
		},
		{
			QualifiedName: "myapp/db.Conn",
			ShortName:     "Conn",
			Label:         "Type",
			DefModuleQN:   "myapp/db",
		},
		{
			QualifiedName: "myapp/db.Conn.Query",
			ShortName:     "Query",
			Label:         "Method",
			DefModuleQN:   "myapp/db",
			ReceiverType:  "myapp/db.Conn",
		},
	}

	imports := []Import{
		{LocalName: "db", ModulePath: "myapp/db"},
	}

	resolved := RunGoLSPCrossFile([]byte(source), moduleQN, fileDefs, crossDefs, imports)

	t.Logf("Resolved calls (%d):", len(resolved))
	for _, rc := range resolved {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	// Should resolve db.Connect as a direct call
	found := false
	for _, rc := range resolved {
		if contains(rc.CallerQN, "doQuery") && contains(rc.CalleeQN, "Connect") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected cross-file resolution of db.Connect()")
	}

	// Should resolve conn.Query via type dispatch (conn's type is *db.Conn)
	found = false
	for _, rc := range resolved {
		if contains(rc.CallerQN, "doQuery") && contains(rc.CalleeQN, "Query") {
			found = true
			if rc.Strategy != "lsp_type_dispatch" {
				t.Errorf("expected lsp_type_dispatch for conn.Query, got %s", rc.Strategy)
			}
			break
		}
	}
	if !found {
		t.Errorf("expected cross-file resolution of conn.Query()")
	}
}

func TestGoLSP_CrossFile_ReturnTypeChain(t *testing.T) {
	// Tests that return type propagation works across files:
	// repo.GetUser() returns *User, then user.Name() resolves via *User.
	source := `package main

import "myapp/repo"

func showUser() {
	user := repo.GetUser(1)
	user.Name()
}
`
	moduleQN := "test.main"

	fileDefs := []CrossFileDef{
		{
			QualifiedName: "test.main.showUser",
			ShortName:     "showUser",
			Label:         "Function",
			DefModuleQN:   moduleQN,
		},
	}

	crossDefs := []CrossFileDef{
		{
			QualifiedName: "myapp/repo.GetUser",
			ShortName:     "GetUser",
			Label:         "Function",
			DefModuleQN:   "myapp/repo",
			ReturnTypes:   "*User",
		},
		{
			QualifiedName: "myapp/repo.User",
			ShortName:     "User",
			Label:         "Type",
			DefModuleQN:   "myapp/repo",
		},
		{
			QualifiedName: "myapp/repo.User.Name",
			ShortName:     "Name",
			Label:         "Method",
			DefModuleQN:   "myapp/repo",
			ReceiverType:  "myapp/repo.User",
		},
	}

	imports := []Import{
		{LocalName: "repo", ModulePath: "myapp/repo"},
	}

	resolved := RunGoLSPCrossFile([]byte(source), moduleQN, fileDefs, crossDefs, imports)

	t.Logf("Resolved calls (%d):", len(resolved))
	for _, rc := range resolved {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	// Should resolve user.Name() via return type propagation
	found := false
	for _, rc := range resolved {
		if contains(rc.CallerQN, "showUser") && contains(rc.CalleeQN, "Name") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected cross-file resolution of user.Name() via return type propagation")
	}
}

func TestGoLSP_SelectReceive(t *testing.T) {
	source := `package main

type Msg struct{}

func (m *Msg) Process() {}

func worker(ch chan *Msg, done chan bool) {
	select {
	case msg := <-ch:
		msg.Process()
	case <-done:
		return
	}
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	requireResolvedCall(t, result, "worker", "Process")
}

func TestGoLSP_StructFieldAccess(t *testing.T) {
	source := `package main

type User struct {
	Name    string
	Age     int
	Profile *Profile
}

type Profile struct {
	Bio string
}

func (p *Profile) Summary() string { return "" }

func showUser(u *User) {
	_ = u.Name
	p := u.Profile
	p.Summary()
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	// p := u.Profile should give p type *Profile, then p.Summary() should resolve
	requireResolvedCall(t, result, "showUser", "Summary")
}

func TestGoLSP_PointerValueReceivers(t *testing.T) {
	source := `package main

type Conn struct{}

func (c *Conn) Close() {}
func (c Conn) Status() string { return "" }

func usePointer(c *Conn) {
	c.Close()
	c.Status()
}

func useValue(c Conn) {
	c.Status()
	c.Close()
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	// Pointer receiver can call both pointer and value methods
	requireResolvedCall(t, result, "usePointer", "Close")
	requireResolvedCall(t, result, "usePointer", "Status")
	// Value receiver calls should also resolve (Go auto-takes address)
	requireResolvedCall(t, result, "useValue", "Status")
	requireResolvedCall(t, result, "useValue", "Close")
}

func TestGoLSP_Diagnostics(t *testing.T) {
	source := `package main

import "unknownpkg"

func doStuff() {
	unknownpkg.Foo()
	x := getUnknown()
	x.Bar()
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f] reason=%q", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence, rc.Reason)
	}

	// Check that we get diagnostics (confidence 0, non-empty reason)
	var diagnostics []ResolvedCall
	for _, rc := range result.ResolvedCalls {
		if rc.Confidence == 0 && rc.Reason != "" {
			diagnostics = append(diagnostics, rc)
		}
	}
	if len(diagnostics) == 0 {
		t.Errorf("expected at least one diagnostic (lsp_unresolved), got none")
	}

	// Verify diagnostics have meaningful reasons
	for _, d := range diagnostics {
		if d.Strategy != "lsp_unresolved" {
			t.Errorf("diagnostic should have strategy lsp_unresolved, got %q", d.Strategy)
		}
		t.Logf("  diagnostic: %s -> %s reason=%q", d.CallerQN, d.CalleeQN, d.Reason)
	}
}

func TestGoLSP_VariadicArgs(t *testing.T) {
	source := `package main

type Logger struct{}

func (l *Logger) Info(msg string) {}

func logAll(loggers ...*Logger) {
	for _, l := range loggers {
		l.Info("hello")
	}
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	// loggers is ...*Logger → [](*Logger), range gives l:*Logger, l.Info() resolves
	rc := requireResolvedCall(t, result, "logAll", "Info")
	if rc.Confidence == 0 {
		t.Fatalf("expected high-confidence resolution, got diagnostic: reason=%q", rc.Reason)
	}
}

func TestGoLSP_NamedReturns(t *testing.T) {
	source := `package main

type Conn struct{}

func (c *Conn) Close() {}

func open() (conn *Conn, err error) {
	conn = &Conn{}
	conn.Close()
	return
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	// conn is *Conn via named return, conn.Close() should resolve
	rc2 := requireResolvedCall(t, result, "open", "Close")
	if rc2.Confidence == 0 {
		t.Fatalf("expected high-confidence resolution, got diagnostic: reason=%q", rc2.Reason)
	}
}

func TestGoLSP_TypeAlias(t *testing.T) {
	source := `package main

type Base struct{}

func (b *Base) DoWork() {}

type Alias = Base

func useAlias(a *Alias) {
	a.DoWork()
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f] reason=%q", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence, rc.Reason)
	}

	rc := requireResolvedCall(t, result, "useAlias", "DoWork")
	if rc.Confidence == 0 {
		t.Fatalf("expected high-confidence resolution, got diagnostic: reason=%q", rc.Reason)
	}
}

func TestGoLSP_InterfaceSatisfaction(t *testing.T) {
	// Use unique method names that no stdlib type has, so satisfaction
	// checking finds exactly one implementer.
	source := `package main

type DataProcessor interface {
	ProcessChunk(data []byte) (int, error)
	Finalize() error
}

type MyProcessor struct{}

func (p *MyProcessor) ProcessChunk(data []byte) (int, error) { return 0, nil }
func (p *MyProcessor) Finalize() error { return nil }

func runProcessor(dp DataProcessor) {
	dp.ProcessChunk([]byte("hello"))
	dp.Finalize()
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	// dp.ProcessChunk() on DataProcessor interface — MyProcessor is the only implementer
	rc := findResolvedCall(t, result, "runProcessor", "ProcessChunk")
	if rc == nil {
		t.Fatal("expected resolved call for runProcessor -> ProcessChunk")
	}
	if rc.Strategy != "lsp_interface_resolve" {
		t.Errorf("strategy: %s (expected lsp_interface_resolve)", rc.Strategy)
	}
	if rc.Confidence < 0.89 {
		t.Errorf("expected confidence >= 0.89, got %.2f", rc.Confidence)
	}

	// dp.Finalize() should also resolve
	rc2 := findResolvedCall(t, result, "runProcessor", "Finalize")
	if rc2 == nil {
		t.Fatal("expected resolved call for runProcessor -> Finalize")
	}
	if rc2.Strategy != "lsp_interface_resolve" {
		t.Errorf("strategy: %s (expected lsp_interface_resolve)", rc2.Strategy)
	}
}

// ============================================================================
// Gap 1: Package-level var/const declarations
// ============================================================================

func TestGoLSP_PackageLevelVar(t *testing.T) {
	source := `package main

type Database struct{}

func (d *Database) Query(sql string) string { return "" }

func NewDatabase() *Database { return &Database{} }

var db = NewDatabase()

func handler() {
	db.Query("SELECT 1")
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	requireResolvedCall(t, result, "handler", "Query")
}

func TestGoLSP_PackageLevelConst(t *testing.T) {
	source := `package main

type Logger struct{}

func (l *Logger) Info(msg string) {}

func NewLogger() *Logger { return &Logger{} }

var logger = NewLogger()

func doWork() {
	logger.Info("starting")
}
`
	result := extractGoWithRegistry(t, source)
	requireResolvedCall(t, result, "doWork", "Info")
}

// ============================================================================
// Gap 2: If-statement initializer
// ============================================================================

func TestGoLSP_IfInit(t *testing.T) {
	source := `package main

type MyError struct{}

func (e *MyError) Error() string { return "" }
func (e *MyError) Code() int { return 0 }

func getError() *MyError { return nil }

func handle() {
	if err := getError(); err != nil {
		err.Code()
	}
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	requireResolvedCall(t, result, "handle", "Code")
}

// ============================================================================
// Gap 3: Embedded struct field promotion
// ============================================================================

func TestGoLSP_EmbeddedFieldPromotion(t *testing.T) {
	source := `package main

type Inner struct {
	Name string
}

type Outer struct {
	Inner
}

type Processor struct{}

func (p *Processor) Process(name string) {}

func doWork() {
	o := &Outer{}
	p := &Processor{}
	p.Process(o.Name)
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	requireResolvedCall(t, result, "doWork", "Process")
}

// ============================================================================
// Gap 4: For-statement C-style init
// ============================================================================

func TestGoLSP_ForInit(t *testing.T) {
	source := `package main

type Counter struct{}

func (c *Counter) Value() int { return 0 }

func NewCounter() *Counter { return &Counter{} }

func loop() {
	for c := NewCounter(); c.Value() < 10; {
		c.Value()
	}
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	requireResolvedCall(t, result, "loop", "Value")
}

// ============================================================================
// Gap 5: Type conversions
// ============================================================================

func TestGoLSP_TypeConversion(t *testing.T) {
	source := `package main

type MyString string

func (s MyString) Upper() string { return "" }

func convert() {
	s := MyString("hello")
	s.Upper()
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	requireResolvedCall(t, result, "convert", "Upper")
}

// ============================================================================
// Gap 6: Var declarations with multiple names
// ============================================================================

func TestGoLSP_MultiNameVar(t *testing.T) {
	source := `package main

type Config struct{}

func (c *Config) Get(key string) string { return "" }

var cfg1, cfg2 *Config

func readConfig() {
	cfg1.Get("port")
	cfg2.Get("host")
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	calls := findAllResolvedCalls(t, result, "readConfig", "Get")
	if len(calls) < 2 {
		t.Errorf("expected at least 2 Get calls resolved, got %d", len(calls))
	}
}

// ============================================================================
// Gap 7: Switch-statement initializer
// ============================================================================

func TestGoLSP_SwitchInit(t *testing.T) {
	source := `package main

type Validator struct{}

func (v *Validator) Check() bool { return true }

func NewValidator() *Validator { return &Validator{} }

func validate() {
	switch v := NewValidator(); v.Check() {
	case true:
		v.Check()
	}
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	requireResolvedCall(t, result, "validate", "Check")
}

func TestGoLSP_InterfaceMethodDispatch_SingleFile(t *testing.T) {
	// Interface defined in same file, variable typed as interface, method called on it.
	source := `package main

type Binder interface {
	Bind(target any) error
}

type DefaultBinder struct{}

func (d *DefaultBinder) Bind(target any) error { return nil }

func process(b Binder) {
	b.Bind("hello")
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f reason=%q]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence, rc.Reason)
	}

	// Should resolve interface call — either lsp_interface_resolve (single impl)
	// or lsp_interface_dispatch (fallback)
	rc := findResolvedCall(t, result, "process", "Bind")
	if rc == nil {
		t.Fatal("expected resolved call for process -> Bind")
	}
	if rc.Strategy != "lsp_interface_resolve" && rc.Strategy != "lsp_interface_dispatch" {
		t.Errorf("expected lsp_interface_resolve or lsp_interface_dispatch, got %q", rc.Strategy)
	}
	t.Logf("Interface dispatch: %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
}

func TestGoLSP_InterfaceMethodDispatch_FieldChain(t *testing.T) {
	// Reproduces echo pattern: c.echo.Binder.Bind() where Binder is an interface field.
	source := `package main

type Binder interface {
	Bind(target any) error
}

type DefaultBinder struct{}
func (d *DefaultBinder) Bind(target any) error { return nil }

type App struct {
	Binder Binder
}

type Context struct {
	app *App
}

func (c *Context) process() {
	c.app.Binder.Bind("hello")
}
`
	result := extractGoWithRegistry(t, source)

	t.Logf("ResolvedCalls (%d):", len(result.ResolvedCalls))
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f reason=%q]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence, rc.Reason)
	}

	rc := findResolvedCall(t, result, "process", "Bind")
	if rc == nil {
		t.Fatal("expected resolved call for process -> Bind (field chain interface dispatch)")
	}
	if rc.Strategy != "lsp_interface_resolve" && rc.Strategy != "lsp_interface_dispatch" {
		t.Errorf("expected lsp_interface_resolve or lsp_interface_dispatch, got %q", rc.Strategy)
	}
}

func TestGoLSP_InterfaceMethodDispatch_CrossFile(t *testing.T) {
	// Interface from another package, method called on interface-typed parameter.
	source := `package main

import "myapp/svc"

func handler(b svc.Binder) {
	b.Bind("data")
}
`
	moduleQN := "test.main"

	fileDefs := []CrossFileDef{
		{
			QualifiedName: "test.main.handler",
			ShortName:     "handler",
			Label:         "Function",
			DefModuleQN:   moduleQN,
		},
	}

	crossDefs := []CrossFileDef{
		{
			QualifiedName: "myapp/svc.Binder",
			ShortName:     "Binder",
			Label:         "Interface",
			DefModuleQN:   "myapp/svc",
			IsInterface:   true,
		},
		{
			QualifiedName: "myapp/svc.DefaultBinder",
			ShortName:     "DefaultBinder",
			Label:         "Type",
			DefModuleQN:   "myapp/svc",
		},
		{
			QualifiedName: "myapp/svc.DefaultBinder.Bind",
			ShortName:     "Bind",
			Label:         "Method",
			DefModuleQN:   "myapp/svc",
			ReceiverType:  "myapp/svc.DefaultBinder",
		},
	}

	imports := []Import{
		{LocalName: "svc", ModulePath: "myapp/svc"},
	}

	resolved := RunGoLSPCrossFile([]byte(source), moduleQN, fileDefs, crossDefs, imports)

	t.Logf("Resolved calls (%d):", len(resolved))
	for _, rc := range resolved {
		t.Logf("  %s -> %s [%s %.2f reason=%q]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence, rc.Reason)
	}

	// Should get interface dispatch
	var found *ResolvedCall
	for i, rc := range resolved {
		if contains(rc.CallerQN, "handler") && contains(rc.CalleeQN, "Bind") && rc.Confidence > 0 {
			found = &resolved[i]
			break
		}
	}
	if found == nil {
		t.Fatal("expected resolved call for handler -> Bind")
	}
	if found.Strategy != "lsp_interface_resolve" && found.Strategy != "lsp_interface_dispatch" {
		t.Errorf("expected lsp_interface_resolve or lsp_interface_dispatch, got %q", found.Strategy)
	}
}

func TestGoLSP_InterfaceMethodDispatch_CrossFile_FieldChain(t *testing.T) {
	// Emulates echo pattern: c.echo.Binder.Bind() where types come from cross-file defs.
	// Context is local, App and Binder are from another package.
	source := `package main

import "myapp/echo"

type Context struct {
	echo *echo.Echo
}

func (c *Context) process() {
	c.echo.Binder.Bind("hello")
}
`
	moduleQN := "test.main"

	fileDefs := []CrossFileDef{
		{
			QualifiedName: "test.main.Context",
			ShortName:     "Context",
			Label:         "Type",
			DefModuleQN:   moduleQN,
		},
		{
			QualifiedName: "test.main.Context.process",
			ShortName:     "process",
			Label:         "Method",
			DefModuleQN:   moduleQN,
			ReceiverType:  "test.main.Context",
		},
	}

	crossDefs := []CrossFileDef{
		// Echo struct with Binder field (interface type)
		{
			QualifiedName: "myapp/echo.Echo",
			ShortName:     "Echo",
			Label:         "Type",
			DefModuleQN:   "myapp/echo",
			FieldDefs:     "Binder:Binder", // key: struct field name:type
		},
		// Binder interface
		{
			QualifiedName: "myapp/echo.Binder",
			ShortName:     "Binder",
			Label:         "Interface",
			DefModuleQN:   "myapp/echo",
			IsInterface:   true,
		},
		// Concrete implementer
		{
			QualifiedName: "myapp/echo.DefaultBinder",
			ShortName:     "DefaultBinder",
			Label:         "Type",
			DefModuleQN:   "myapp/echo",
		},
		{
			QualifiedName: "myapp/echo.DefaultBinder.Bind",
			ShortName:     "Bind",
			Label:         "Method",
			DefModuleQN:   "myapp/echo",
			ReceiverType:  "myapp/echo.DefaultBinder",
		},
	}

	imports := []Import{
		{LocalName: "echo", ModulePath: "myapp/echo"},
	}

	resolved := RunGoLSPCrossFile([]byte(source), moduleQN, fileDefs, crossDefs, imports)

	t.Logf("Resolved calls (%d):", len(resolved))
	for _, rc := range resolved {
		t.Logf("  %s -> %s [%s %.2f reason=%q]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence, rc.Reason)
	}

	// Should resolve to interface dispatch (either lsp_interface_resolve or lsp_interface_dispatch)
	var found *ResolvedCall
	for i, rc := range resolved {
		if contains(rc.CallerQN, "process") && contains(rc.CalleeQN, "Bind") && rc.Confidence > 0 {
			found = &resolved[i]
			break
		}
	}
	if found == nil {
		t.Fatal("expected resolved call for process -> Bind via c.echo.Binder.Bind() field chain")
	}
	t.Logf("Resolved: %s -> %s [%s %.2f]", found.CallerQN, found.CalleeQN, found.Strategy, found.Confidence)
	// Accept any LSP strategy — the key is that it resolves at all
	if found.Confidence < 0.8 {
		t.Errorf("expected high confidence (>=0.8), got %.2f", found.Confidence)
	}
}

func TestGoLSP_ConcreteMethodDispatch_CrossFile_MapIndex(t *testing.T) {
	// Emulates echo vhost pattern: vh.ServeHTTP() where vh comes from map[string]*Echo
	source := `package main

import "myapp/echo"

func dispatch(vhosts map[string]*echo.Echo, host string) {
	if vh, ok := vhosts[host]; ok {
		vh.ServeHTTP(nil, nil)
	}
}
`
	moduleQN := "test.main"

	fileDefs := []CrossFileDef{
		{
			QualifiedName: "test.main.dispatch",
			ShortName:     "dispatch",
			Label:         "Function",
			DefModuleQN:   moduleQN,
		},
	}

	crossDefs := []CrossFileDef{
		{
			QualifiedName: "myapp/echo.Echo",
			ShortName:     "Echo",
			Label:         "Type",
			DefModuleQN:   "myapp/echo",
		},
		{
			QualifiedName: "myapp/echo.Echo.ServeHTTP",
			ShortName:     "ServeHTTP",
			Label:         "Method",
			DefModuleQN:   "myapp/echo",
			ReceiverType:  "myapp/echo.Echo",
		},
	}

	imports := []Import{
		{LocalName: "echo", ModulePath: "myapp/echo"},
	}

	resolved := RunGoLSPCrossFile([]byte(source), moduleQN, fileDefs, crossDefs, imports)

	t.Logf("Resolved calls (%d):", len(resolved))
	for _, rc := range resolved {
		t.Logf("  %s -> %s [%s %.2f reason=%q]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence, rc.Reason)
	}

	// Should resolve vh.ServeHTTP to lsp_type_dispatch
	var found *ResolvedCall
	for i, rc := range resolved {
		if contains(rc.CallerQN, "dispatch") && contains(rc.CalleeQN, "ServeHTTP") && rc.Confidence > 0 {
			found = &resolved[i]
			break
		}
	}
	if found == nil {
		t.Fatal("expected resolved call for dispatch -> ServeHTTP via map index")
	}
	if found.Strategy != "lsp_type_dispatch" {
		t.Errorf("expected lsp_type_dispatch, got %q", found.Strategy)
	}
}

func TestGoLSP_StdlibInterfaceMethodDispatch_CrossFile(t *testing.T) {
	// Emulates common Go pattern: ctx.Done() where ctx is context.Context parameter.
	// context.Context is a stdlib interface — its methods should resolve via interface dispatch.
	source := `package main

import "context"

func process(ctx context.Context) {
	<-ctx.Done()
	ctx.Err()
}
`
	moduleQN := "test.main"

	fileDefs := []CrossFileDef{
		{
			QualifiedName: "test.main.process",
			ShortName:     "process",
			Label:         "Function",
			DefModuleQN:   moduleQN,
		},
	}

	// No cross-file defs — stdlib is pre-registered
	var crossDefs []CrossFileDef

	imports := []Import{
		{LocalName: "context", ModulePath: "context"},
	}

	resolved := RunGoLSPCrossFile([]byte(source), moduleQN, fileDefs, crossDefs, imports)

	t.Logf("Resolved calls (%d):", len(resolved))
	for _, rc := range resolved {
		t.Logf("  %s -> %s [%s %.2f reason=%q]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence, rc.Reason)
	}

	// Should resolve ctx.Done() — either lsp_interface_dispatch or lsp_interface_resolve
	var foundDone, foundErr *ResolvedCall
	for i, rc := range resolved {
		if contains(rc.CallerQN, "process") && contains(rc.CalleeQN, "Done") && rc.Confidence > 0 {
			foundDone = &resolved[i]
		}
		if contains(rc.CallerQN, "process") && contains(rc.CalleeQN, "Err") && rc.Confidence > 0 {
			foundErr = &resolved[i]
		}
	}
	if foundDone == nil {
		t.Error("expected resolved call for process -> Done via ctx.Done()")
	} else {
		t.Logf("Done: %s -> %s [%s %.2f]", foundDone.CallerQN, foundDone.CalleeQN, foundDone.Strategy, foundDone.Confidence)
	}
	if foundErr == nil {
		t.Error("expected resolved call for process -> Err via ctx.Err()")
	} else {
		t.Logf("Err: %s -> %s [%s %.2f]", foundErr.CallerQN, foundErr.CalleeQN, foundErr.Strategy, foundErr.Confidence)
	}
}

func TestGoLSP_LocalInterface_SingleImplementer_Resolve(t *testing.T) {
	// When a project-local interface has exactly one implementer,
	// calls through the interface should resolve to the concrete method via lsp_interface_resolve.
	source := `package main

import "myapp/svc"

func process(s svc.Store) {
	s.Get("key")
	s.Put("key", "val")
}
`
	moduleQN := "test.main"

	fileDefs := []CrossFileDef{
		{QualifiedName: "test.main.process", ShortName: "process", Label: "Function", DefModuleQN: moduleQN},
	}

	// Register interface with method_names via IsInterface + MethodNames
	crossDefs := []CrossFileDef{
		{QualifiedName: "myapp/svc.Store", ShortName: "Store", Label: "Interface",
			DefModuleQN: "myapp/svc", IsInterface: true, MethodNames: "Get|Put"},
		// Single concrete implementer
		{QualifiedName: "myapp/svc.RedisStore", ShortName: "RedisStore", Label: "Class", DefModuleQN: "myapp/svc"},
		{QualifiedName: "myapp/svc.RedisStore.Get", ShortName: "Get", Label: "Method",
			DefModuleQN: "myapp/svc", ReceiverType: "myapp/svc.RedisStore"},
		{QualifiedName: "myapp/svc.RedisStore.Put", ShortName: "Put", Label: "Method",
			DefModuleQN: "myapp/svc", ReceiverType: "myapp/svc.RedisStore"},
	}

	imports := []Import{
		{LocalName: "svc", ModulePath: "myapp/svc"},
	}

	resolved := RunGoLSPCrossFile([]byte(source), moduleQN, fileDefs, crossDefs, imports)

	t.Logf("Resolved calls (%d):", len(resolved))
	for _, rc := range resolved {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}

	var foundGet, foundPut *ResolvedCall
	for i, rc := range resolved {
		if contains(rc.CallerQN, "process") && contains(rc.CalleeQN, "Get") && rc.Confidence > 0 {
			foundGet = &resolved[i]
		}
		if contains(rc.CallerQN, "process") && contains(rc.CalleeQN, "Put") && rc.Confidence > 0 {
			foundPut = &resolved[i]
		}
	}

	// Single implementer of Store → should resolve to concrete method via lsp_interface_resolve
	if foundGet == nil {
		t.Fatal("expected resolved call for process -> Get")
	}
	t.Logf("Get: %s -> %s [%s %.2f]", foundGet.CallerQN, foundGet.CalleeQN, foundGet.Strategy, foundGet.Confidence)
	if foundGet.Strategy != "lsp_interface_resolve" {
		t.Errorf("Get: expected lsp_interface_resolve, got %q", foundGet.Strategy)
	}
	if foundGet.CalleeQN != "myapp/svc.RedisStore.Get" {
		t.Errorf("Get: expected callee myapp/svc.RedisStore.Get, got %q", foundGet.CalleeQN)
	}

	if foundPut == nil {
		t.Fatal("expected resolved call for process -> Put")
	}
	t.Logf("Put: %s -> %s [%s %.2f]", foundPut.CallerQN, foundPut.CalleeQN, foundPut.Strategy, foundPut.Confidence)
	if foundPut.Strategy != "lsp_interface_resolve" {
		t.Errorf("Put: expected lsp_interface_resolve, got %q", foundPut.Strategy)
	}
	if foundPut.CalleeQN != "myapp/svc.RedisStore.Put" {
		t.Errorf("Put: expected callee myapp/svc.RedisStore.Put, got %q", foundPut.CalleeQN)
	}
}
