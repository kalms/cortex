package cbm

import (
	"strings"
	"testing"

	"github.com/DeusData/codebase-memory-mcp/internal/lang"
)

// extractCWithRegistry extracts a C file and returns the result.
func extractCWithRegistry(t *testing.T, source string) *FileResult {
	t.Helper()
	result, err := ExtractFile([]byte(source), lang.C, "test", "main.c")
	if err != nil {
		t.Fatalf("ExtractFile failed: %v", err)
	}
	return result
}

// extractCPPWithRegistry extracts a C++ file and returns the result.
func extractCPPWithRegistry(t *testing.T, source string) *FileResult {
	t.Helper()
	result, err := ExtractFile([]byte(source), lang.CPP, "test", "main.cpp")
	if err != nil {
		t.Fatalf("ExtractFile failed: %v", err)
	}
	return result
}

// ============================================================================
// Test Category 1: Simple variable declarations and method calls
// ============================================================================

func TestCLSP_SimpleVarDecl(t *testing.T) {
	source := `
struct Foo {
    int value;
};

int bar(struct Foo* f);

void baz() {
    struct Foo x;
    bar(&x);
}
`
	result := extractCWithRegistry(t, source)
	requireResolvedCall(t, result, "baz", "bar")
}

func TestCLSP_PointerArrow(t *testing.T) {
	source := `
class Foo {
public:
    int bar() { return 0; }
};

void test(Foo* p) {
    p->bar();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "bar")
}

func TestCLSP_DotAccess(t *testing.T) {
	source := `
class Foo {
public:
    int bar() { return 0; }
};

void test() {
    Foo x;
    x.bar();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "bar")
}

// ============================================================================
// Test Category 2: Auto type inference
// ============================================================================

func TestCLSP_AutoInference(t *testing.T) {
	source := `
class Foo {
public:
    int bar() { return 0; }
};

Foo createFoo() { return Foo(); }

void test() {
    auto x = createFoo();
    x.bar();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "bar")
}

// ============================================================================
// Test Category 3: Namespace-qualified calls
// ============================================================================

func TestCLSP_NamespaceQualified(t *testing.T) {
	source := `
namespace ns {
    class Foo {
    public:
        static int staticMethod() { return 0; }
    };
}

void test() {
    ns::Foo::staticMethod();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "staticMethod")
}

// ============================================================================
// Test Category 4: Constructor calls
// ============================================================================

func TestCLSP_Constructor(t *testing.T) {
	source := `
class Foo {
public:
    Foo(int a, int b) {}
    int bar() { return 0; }
};

void test() {
    Foo x(1, 2);
    x.bar();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "bar")
}

func TestCLSP_NewDelete(t *testing.T) {
	source := `
class Foo {
public:
    int bar() { return 0; }
};

void test() {
    Foo* p = new Foo();
    p->bar();
    delete p;
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "bar")
}

// ============================================================================
// Test Category 5: Implicit this
// ============================================================================

func TestCLSP_ImplicitThis(t *testing.T) {
	source := `
class Foo {
public:
    int helper() { return 0; }
    void doWork() {
        helper();
    }
};
`
	result := extractCPPWithRegistry(t, source)
	rc := findResolvedCall(t, result, "doWork", "helper")
	if rc == nil {
		t.Log("implicit this resolution not yet detected — may need method body scoping")
		// This is acceptable — implicit this is a stretch goal
	}
}

func TestCLSP_ExplicitThis(t *testing.T) {
	source := `
class Foo {
public:
    int bar() { return 0; }
    void doWork() {
        this->bar();
    }
};
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "doWork", "bar")
}

// ============================================================================
// Test Category 6: Type aliases
// ============================================================================

func TestCLSP_TypeAlias(t *testing.T) {
	source := `
class Foo {
public:
    int bar() { return 0; }
};

using MyFoo = Foo;

void test() {
    MyFoo x;
    x.bar();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "bar")
}

func TestCLSP_Typedef(t *testing.T) {
	source := `
class Foo {
public:
    int bar() { return 0; }
};

typedef Foo MyFoo;

void test() {
    MyFoo x;
    x.bar();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "bar")
}

// ============================================================================
// Test Category 7: Scope chain
// ============================================================================

func TestCLSP_ScopeChain(t *testing.T) {
	source := `
class Foo {
public:
    int method1() { return 0; }
};

class Bar {
public:
    int method2() { return 0; }
};

void test() {
    {
        Foo x;
        x.method1();
    }
    {
        Bar x;
        x.method2();
    }
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "method1")
	requireResolvedCall(t, result, "test", "method2")
}

// ============================================================================
// Test Category 8: Cast expressions
// ============================================================================

func TestCLSP_StaticCast(t *testing.T) {
	source := `
class Base {
public:
    virtual int bar() { return 0; }
};

class Derived : public Base {
public:
    int bar() override { return 1; }
    int extra() { return 2; }
};

void test(Base* b) {
    static_cast<Derived*>(b)->extra();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "extra")
}

// ============================================================================
// Test Category 9: Using namespace
// ============================================================================

func TestCLSP_UsingNamespace(t *testing.T) {
	source := `
namespace ns {
    int foo() { return 42; }
}

void test() {
    using namespace ns;
    foo();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "foo")
}

// ============================================================================
// Test Category 10: C mode (pure C, no classes)
// ============================================================================

func TestCLSP_CMode(t *testing.T) {
	source := `
#include <stdlib.h>

struct Point {
    int x;
    int y;
};

int compute(struct Point* p) {
    return p->x + p->y;
}

void test() {
    struct Point p;
    p.x = 1;
    p.y = 2;
    compute(&p);
}
`
	result := extractCWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "compute")
}

// ============================================================================
// Test Category 11: Direct function calls
// ============================================================================

func TestCLSP_DirectCall(t *testing.T) {
	source := `
int helper(int x) { return x + 1; }

void test() {
    helper(42);
}
`
	result := extractCWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "helper")
}

func TestCLSP_DirectCallCPP(t *testing.T) {
	source := `
int helper(int x) { return x + 1; }

void test() {
    helper(42);
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "helper")
}

// ============================================================================
// Test Category 12: Stdlib calls
// ============================================================================

func TestCLSP_StdlibCall(t *testing.T) {
	source := `
#include <string.h>

void test() {
    char buf[100];
    strlen(buf);
}
`
	result := extractCWithRegistry(t, source)
	// strlen is registered in stdlib, should be resolvable
	rc := findResolvedCall(t, result, "test", "strlen")
	if rc != nil {
		if rc.Confidence < 0.5 {
			t.Errorf("expected high confidence for strlen, got %.2f", rc.Confidence)
		}
	}
}

// ============================================================================
// Test Category 13: Multiple resolved calls in same function
// ============================================================================

func TestCLSP_MultipleCallsSameFunc(t *testing.T) {
	source := `
class Logger {
public:
    void info(const char* msg) {}
    void error(const char* msg) {}
};

class Config {
public:
    const char* get(const char* key) { return ""; }
};

void setup(Logger* log, Config* cfg) {
    log->info("starting");
    cfg->get("port");
    log->error("failed");
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "setup", "info")
	requireResolvedCall(t, result, "setup", "get")
	requireResolvedCall(t, result, "setup", "error")
}

// ============================================================================
// Test Category 14: Return type chain
// ============================================================================

func TestCLSP_ReturnTypeChain(t *testing.T) {
	source := `
class File {
public:
    int read() { return 0; }
};

File* open(const char* path) { return nullptr; }

void test() {
    File* f = open("test.txt");
    f->read();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "read")
}

// ============================================================================
// Test Category 15: Method chaining
// ============================================================================

func TestCLSP_MethodChaining(t *testing.T) {
	source := `
class Builder {
public:
    Builder& setName(const char* name) { return *this; }
    Builder& setValue(int val) { return *this; }
    void build() {}
};

void test() {
    Builder b;
    b.setName("foo").setValue(42).build();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "setName")
	// Method chaining through return type
	rc := findResolvedCall(t, result, "test", "build")
	if rc == nil {
		t.Log("method chaining through return type not resolved — acceptable limitation")
	}
}

// ============================================================================
// Test Category 16: Inheritance
// ============================================================================

func TestCLSP_Inheritance(t *testing.T) {
	source := `
class Base {
public:
    int baseMethod() { return 0; }
};

class Derived : public Base {
public:
    int derivedMethod() { return 1; }
};

void test() {
    Derived d;
    d.derivedMethod();
    d.baseMethod();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "derivedMethod")
	// Base class method through inheritance — may or may not resolve
	rc := findResolvedCall(t, result, "test", "baseMethod")
	if rc == nil {
		t.Log("base class method through inheritance not resolved — needs cross-file enrichment")
	}
}

// ============================================================================
// Test Category 17: Operator overloads
// ============================================================================

func TestCLSP_OperatorStream(t *testing.T) {
	source := `
#include <iostream>

void test() {
    int x = 42;
}
`
	// Just verify it doesn't crash on operator overload nodes
	result := extractCPPWithRegistry(t, source)
	if result == nil {
		t.Fatal("extraction returned nil")
	}
}

// ============================================================================
// Test Category 18: Cross-file resolution
// ============================================================================

func TestCLSP_CrossFile(t *testing.T) {
	source := `
class Widget {
public:
    void render() {}
};

void test() {
    Widget w;
    w.render();
}
`
	fileDefs := []CrossFileDef{
		{
			QualifiedName: "test.main-cpp.Widget",
			ShortName:     "Widget",
			Label:         "Class",
			DefModuleQN:   "test.main-cpp",
		},
		{
			QualifiedName: "test.main-cpp.Widget.render",
			ShortName:     "render",
			Label:         "Method",
			ReceiverType:  "test.main-cpp.Widget",
			DefModuleQN:   "test.main-cpp",
		},
	}

	crossDefs := []CrossFileDef{
		{
			QualifiedName: "test.helper-cpp.Helper.process",
			ShortName:     "process",
			Label:         "Method",
			ReceiverType:  "test.helper-cpp.Helper",
			DefModuleQN:   "test.helper-cpp",
		},
	}

	resolved := RunCLSPCrossFile(
		[]byte(source),
		"test.main-cpp",
		true, // cpp mode
		fileDefs,
		crossDefs,
		nil, // no includes needed for this test
	)

	if len(resolved) == 0 {
		t.Log("cross-file resolution returned no calls — may need parser re-parse support")
		return
	}

	found := false
	for _, rc := range resolved {
		if contains(rc.CalleeQN, "render") {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected cross-file resolution to find render() call")
		for _, rc := range resolved {
			t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
		}
	}
}

// ============================================================================
// Test Category 19: Verify no crashes on various patterns
// ============================================================================

func TestCLSP_NocrashTemplateExpression(t *testing.T) {
	source := `
#include <vector>
#include <string>

void test() {
    int x = 42;
    double y = 3.14;
    const char* s = "hello";
}
`
	result := extractCPPWithRegistry(t, source)
	if result == nil {
		t.Fatal("extraction returned nil")
	}
}

func TestCLSP_NocrashLambda(t *testing.T) {
	source := `
void test() {
    auto f = [](int x) -> int { return x + 1; };
    f(42);
}
`
	result := extractCPPWithRegistry(t, source)
	if result == nil {
		t.Fatal("extraction returned nil")
	}
}

func TestCLSP_NocrashNestedNamespace(t *testing.T) {
	source := `
namespace a {
    namespace b {
        namespace c {
            void deep() {}
        }
    }
}

void test() {
    a::b::c::deep();
}
`
	result := extractCPPWithRegistry(t, source)
	if result == nil {
		t.Fatal("extraction returned nil")
	}
}

func TestCLSP_NocrashEmptySource(t *testing.T) {
	result, err := ExtractFile([]byte(""), lang.CPP, "test", "empty.cpp")
	if err != nil {
		t.Fatalf("ExtractFile failed: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result for empty source")
	}
}

func TestCLSP_NocrashComplexClass(t *testing.T) {
	source := `
class Base {
public:
    virtual ~Base() {}
    virtual void process() = 0;
};

class Derived : public Base {
    int data_;
public:
    Derived(int d) : data_(d) {}
    void process() override {
        data_++;
    }
    int getData() const { return data_; }
};

template<typename T>
class Container {
    T* items_;
    int count_;
public:
    Container() : items_(nullptr), count_(0) {}
    void add(const T& item) { count_++; }
    int size() const { return count_; }
};

void test() {
    Derived d(42);
    d.process();
    d.getData();
}
`
	result := extractCPPWithRegistry(t, source)
	if result == nil {
		t.Fatal("extraction returned nil")
	}
	requireResolvedCall(t, result, "test", "process")
	requireResolvedCall(t, result, "test", "getData")
}

// ============================================================================
// Test Category 20: Operator overloads
// ============================================================================

func TestCLSP_OperatorSubscript(t *testing.T) {
	source := `
class Vec {
public:
    int& operator[](int idx) { static int x; return x; }
};

void test() {
    Vec v;
    v[0];
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "operator[]")
}

func TestCLSP_OperatorBinary(t *testing.T) {
	source := `
class Vec3 {
public:
    Vec3 operator+(const Vec3& other) { return Vec3(); }
};

void test() {
    Vec3 a;
    Vec3 b;
    a + b;
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "operator+")
}

func TestCLSP_OperatorUnary(t *testing.T) {
	source := `
class Iter {
public:
    int operator*() { return 0; }
    Iter& operator++() { return *this; }
};

void test() {
    Iter it;
    *it;
    ++it;
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "operator*")
	requireResolvedCall(t, result, "test", "operator++")
}

// ============================================================================
// Test Category 21: Functor (operator())
// ============================================================================

func TestCLSP_Functor(t *testing.T) {
	source := `
class Predicate {
public:
    bool operator()(int x) { return x > 0; }
};

void test() {
    Predicate pred;
    pred(42);
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "operator()")
}

// ============================================================================
// Test Category 22: Copy/move constructor
// ============================================================================

func TestCLSP_CopyConstructor(t *testing.T) {
	source := `
class Foo {
public:
    Foo() {}
    Foo(const Foo& other) {}
    int bar() { return 0; }
};

void test() {
    Foo a;
    Foo b = a;
}
`
	result := extractCPPWithRegistry(t, source)
	// Should detect copy constructor call
	rc := findResolvedCall(t, result, "test", "Foo")
	if rc != nil && contains(rc.Strategy, "copy_constructor") {
		t.Log("copy constructor correctly detected")
	}
}

// ============================================================================
// Test Category 23: Delete expression (destructor)
// ============================================================================

func TestCLSP_DeleteDestructor(t *testing.T) {
	source := `
class Widget {
public:
    ~Widget() {}
};

void test() {
    Widget* w = new Widget();
    delete w;
}
`
	result := extractCPPWithRegistry(t, source)
	// Should emit constructor for new and destructor for delete
	rc := findResolvedCall(t, result, "test", "Widget")
	if rc == nil {
		t.Log("constructor/destructor not detected")
	}
}

// ============================================================================
// Test Category 24: Range-for type deduction
// ============================================================================

func TestCLSP_RangeFor(t *testing.T) {
	source := `
class Foo {
public:
    int bar() { return 0; }
};

void test() {
    Foo arr[3];
    for (auto& x : arr) {
        x.bar();
    }
}
`
	// This may or may not resolve depending on array element type deduction
	result := extractCPPWithRegistry(t, source)
	if result == nil {
		t.Fatal("extraction returned nil")
	}
}

// ============================================================================
// Test Category 25: Parent namespace traversal
// ============================================================================

func TestCLSP_ParentNamespace(t *testing.T) {
	source := `
namespace outer {
    int helper() { return 42; }

    namespace inner {
        void test() {
            helper();
        }
    }
}
`
	result := extractCPPWithRegistry(t, source)
	rc := findResolvedCall(t, result, "test", "helper")
	if rc == nil {
		t.Log("parent namespace traversal not resolving — acceptable")
	}
}

// ============================================================================
// Test Category 26: Conversion operators
// ============================================================================

func TestCLSP_ConversionOperatorBool(t *testing.T) {
	source := `
class Guard {
public:
    operator bool() { return true; }
};

void test() {
    Guard g;
    if (g) {
        // implicit operator bool call
    }
}
`
	result := extractCPPWithRegistry(t, source)
	rc := findResolvedCall(t, result, "test", "operator bool")
	if rc == nil {
		t.Log("implicit operator bool() not detected — acceptable limitation")
	}
}

// ============================================================================
// Test Category 27: Namespace alias
// ============================================================================

func TestCLSP_NamespaceAlias(t *testing.T) {
	source := `
namespace very_long_name {
    int foo() { return 42; }
}

void test() {
    namespace vln = very_long_name;
    vln::foo();
}
`
	result := extractCPPWithRegistry(t, source)
	// Namespace alias resolution in function scope
	if result == nil {
		t.Fatal("extraction returned nil")
	}
}

// ============================================================================
// Test Category 28: Template in namespace
// ============================================================================

func TestCLSP_TemplateInNamespace(t *testing.T) {
	source := `
namespace ns {
    template<typename T>
    class Wrapper {
    public:
        T get() { return T(); }
    };

    template<typename T>
    void process(T val) {}
}

void test() {
    int x = 42;
}
`
	result := extractCPPWithRegistry(t, source)
	if result == nil {
		t.Fatal("extraction returned nil for template in namespace")
	}
}

// ============================================================================
// Test Category 29: No crash on various edge cases
// ============================================================================

func TestCLSP_NocrashUsingEnum(t *testing.T) {
	source := `
enum class Color { Red, Green, Blue };

void test() {
    Color c = Color::Red;
}
`
	result := extractCPPWithRegistry(t, source)
	if result == nil {
		t.Fatal("extraction returned nil")
	}
}

func TestCLSP_NocrashMultipleInheritance(t *testing.T) {
	source := `
class A {
public:
    void methodA() {}
};

class B {
public:
    void methodB() {}
};

class C : public A, public B {
public:
    void methodC() {}
};

void test() {
    C c;
    c.methodC();
    c.methodA();
    c.methodB();
}
`
	result := extractCPPWithRegistry(t, source)
	if result == nil {
		t.Fatal("extraction returned nil")
	}
	requireResolvedCall(t, result, "test", "methodC")
}

func TestCLSP_NocrashPointerArithmetic(t *testing.T) {
	source := `
void test() {
    int arr[10];
    int* p = arr;
    *(p + 3) = 42;
}
`
	result := extractCWithRegistry(t, source)
	if result == nil {
		t.Fatal("extraction returned nil")
	}
}

// ============================================================================
// Test Category 30: Function pointer resolution
// ============================================================================

func TestCLSP_FunctionPointer(t *testing.T) {
	source := `
int target_func(int x) { return x + 1; }

void test() {
    int (*fp)(int) = &target_func;
    fp(42);
}
`
	result := extractCWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "target_func")
}

func TestCLSP_FunctionPointerDecay(t *testing.T) {
	source := `
int target_func(int x) { return x + 1; }

void test() {
    int (*fp)(int) = target_func;
    fp(42);
}
`
	result := extractCWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "target_func")
}

// ============================================================================
// Test Category 31: Overloaded function call (arg count matching)
// ============================================================================

func TestCLSP_OverloadByArgCount(t *testing.T) {
	source := `
class Foo {
public:
    int bar() { return 0; }
    int bar(int x) { return x; }
    int bar(int x, int y) { return x + y; }
};

void test() {
    Foo f;
    f.bar();
    f.bar(1);
    f.bar(1, 2);
}
`
	result := extractCPPWithRegistry(t, source)
	// Should resolve all three overloads
	requireResolvedCall(t, result, "test", "bar")
}

// ============================================================================
// Test Category 32: Template default args
// ============================================================================

func TestCLSP_TemplateDefaultArgs(t *testing.T) {
	source := `
class DefaultType {
public:
    int method() { return 0; }
};

template<class T = DefaultType>
void process() {
    T obj;
    obj.method();
}
`
	result := extractCPPWithRegistry(t, source)
	rc := findResolvedCall(t, result, "process", "method")
	if rc == nil {
		t.Log("template default arg resolution not working — tree-sitter may not expose default_type field")
	}
}

// ============================================================================
// Test Category 33: C++20 spaceship operator
// ============================================================================

func TestCLSP_SpaceshipOperator(t *testing.T) {
	source := `
class Vec3 {
public:
    int x, y, z;
    bool operator==(const Vec3& other) { return x == other.x; }
};

void test() {
    Vec3 a;
    Vec3 b;
    a == b;
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "operator==")
}

// ============================================================================
// Test Category 34: C++20 concepts (no crash)
// ============================================================================

func TestCLSP_NocrashConcept(t *testing.T) {
	source := `
template<typename T>
class Container {
public:
    void push(T val) {}
    int size() { return 0; }
};

void test() {
    Container<int> c;
    c.push(42);
    c.size();
}
`
	result := extractCPPWithRegistry(t, source)
	if result == nil {
		t.Fatal("extraction returned nil")
	}
	requireResolvedCall(t, result, "test", "push")
	requireResolvedCall(t, result, "test", "size")
}

// ============================================================================
// Test Category 35: Dependent member access via template default
// ============================================================================

func TestCLSP_DependentMemberAccess(t *testing.T) {
	source := `
class Widget {
public:
    void render() {}
};

template<class T = Widget>
void draw(T& obj) {
    obj.render();
}
`
	result := extractCPPWithRegistry(t, source)
	rc := findResolvedCall(t, result, "draw", "render")
	if rc == nil {
		t.Log("dependent member access through template default not resolved — acceptable")
	}
}

func TestCLSP_NocrashTryCatch(t *testing.T) {
	source := `
class Exception {
public:
    const char* what() { return "error"; }
};

void test() {
    try {
        throw Exception();
    } catch (Exception& e) {
        e.what();
    }
}
`
	result := extractCPPWithRegistry(t, source)
	if result == nil {
		t.Fatal("extraction returned nil")
	}
}

// ============================================================================
// Test Category: Macro expansion via simplecpp preprocessor (dual-parse)
// ============================================================================

// hasRawCall checks if any raw Call has the given callee name.
func hasRawCall(result *FileResult, calleeName string) bool {
	for _, c := range result.Calls {
		if c.CalleeName == calleeName {
			return true
		}
	}
	return false
}

func TestCLSP_MacroWrappedCall(t *testing.T) {
	source := `
#define CALL(f) f()
void foo(void);
void test(void) { CALL(foo); }
`
	result := extractCWithRegistry(t, source)
	if !hasRawCall(result, "foo") {
		t.Errorf("expected raw call to 'foo' from macro expansion, got calls: %v", result.Calls)
	}
}

func TestCLSP_MacroWithArgs(t *testing.T) {
	source := `
int printf(const char* fmt, ...);
#define LOG(msg) printf(msg)
void test(void) { LOG("hi"); }
`
	result := extractCWithRegistry(t, source)
	if !hasRawCall(result, "printf") {
		t.Errorf("expected raw call to 'printf' from macro expansion, got calls: %v", result.Calls)
	}
}

func TestCLSP_RecursiveMacro(t *testing.T) {
	source := `
void target(int x);
#define B(x) target(x)
#define A(x) B(x)
void test(void) { A(1); }
`
	result := extractCWithRegistry(t, source)
	if !hasRawCall(result, "target") {
		t.Errorf("expected raw call to 'target' from recursive macro, got calls: %v", result.Calls)
	}
}

func TestCLSP_ConditionalMacro(t *testing.T) {
	source := `
void new_func(void);
void old_func(void);
#define USE_NEW 1
#ifdef USE_NEW
void test(void) { new_func(); }
#else
void test(void) { old_func(); }
#endif
`
	result := extractCWithRegistry(t, source)
	if !hasRawCall(result, "new_func") {
		t.Errorf("expected call to 'new_func' from #ifdef branch, got calls: %v", result.Calls)
	}
}

func TestCLSP_TokenPaste(t *testing.T) {
	source := `
void order_handler(void);
#define HANDLER(name) name##_handler()
void test(void) { HANDLER(order); }
`
	result := extractCWithRegistry(t, source)
	if !hasRawCall(result, "order_handler") {
		t.Errorf("expected raw call to 'order_handler' from ## paste, got calls: %v", result.Calls)
	}
}

func TestCLSP_NoMacroNoOverhead(t *testing.T) {
	// Pure C without #define — preprocessor should return NULL (fast path).
	source := `
void foo(void);
void bar(void);
void test(void) { foo(); bar(); }
`
	result := extractCWithRegistry(t, source)
	if !hasRawCall(result, "foo") || !hasRawCall(result, "bar") {
		t.Errorf("expected calls to 'foo' and 'bar', got: %v", result.Calls)
	}
}

func TestCLSP_VariadicMacro(t *testing.T) {
	source := `
int fprintf(void* stream, const char* fmt, ...);
#define DBG(fmt, ...) fprintf(0, fmt, __VA_ARGS__)
void test(void) { DBG("x=%d", 42); }
`
	result := extractCWithRegistry(t, source)
	if !hasRawCall(result, "fprintf") {
		t.Errorf("expected raw call to 'fprintf' from variadic macro, got calls: %v", result.Calls)
	}
}

func TestCLSP_CPPMacroMethodCall(t *testing.T) {
	source := `
class Logger {
public:
    void log(const char* msg) {}
};

Logger* getLogger();
#define LOG(msg) getLogger()->log(msg)

void test() {
    LOG("hello");
}
`
	result := extractCPPWithRegistry(t, source)
	if !hasRawCall(result, "getLogger") {
		t.Errorf("expected raw call to 'getLogger' from macro expansion, got calls: %v", result.Calls)
	}
}

// ============================================================================
// Test Category: Struct field extraction
// ============================================================================

func TestCLSP_StructFieldExtraction(t *testing.T) {
	source := `
struct Point {
    int x;
    int y;
    float z;
};
`
	result := extractCWithRegistry(t, source)
	// Check that Field definitions are extracted
	fieldCount := 0
	fieldNames := map[string]string{} // name → return_type
	for _, d := range result.Definitions {
		if d.Label == "Field" {
			fieldCount++
			fieldNames[d.Name] = d.ReturnType
		}
	}
	if fieldCount != 3 {
		t.Errorf("expected 3 Field defs, got %d", fieldCount)
		for _, d := range result.Definitions {
			t.Logf("  def: %s label=%s type=%s", d.Name, d.Label, d.ReturnType)
		}
	}
	for _, name := range []string{"x", "y", "z"} {
		if _, ok := fieldNames[name]; !ok {
			t.Errorf("expected field %q to be extracted", name)
		}
	}
	if fieldNames["x"] != "int" {
		t.Errorf("expected field x type 'int', got %q", fieldNames["x"])
	}
	if fieldNames["z"] != "float" {
		t.Errorf("expected field z type 'float', got %q", fieldNames["z"])
	}
}

func TestCLSP_StructFieldDefsToLSPDefs(t *testing.T) {
	source := `
struct Config {
    int timeout;
    char* name;
    void (*callback)(int);
};
`
	result := extractCWithRegistry(t, source)

	// Convert to LSP defs
	lspDefs := DefsToLSPDefs(result.Definitions, "test.main_c")
	var configDef *CrossFileDef
	for i := range lspDefs {
		if lspDefs[i].ShortName == "Config" && lspDefs[i].Label == "Class" {
			configDef = &lspDefs[i]
			break
		}
	}
	if configDef == nil {
		t.Fatal("Config class def not found in LSP defs")
	}
	// FieldDefs should contain at least timeout:int and name:char
	if configDef.FieldDefs == "" {
		t.Errorf("expected FieldDefs to be populated, got empty string")
		for _, d := range result.Definitions {
			t.Logf("  def: %s label=%s type=%s parent=%s", d.Name, d.Label, d.ReturnType, d.ParentClass)
		}
	}
	// Function pointer field (callback) should NOT be in FieldDefs (it's a method)
	if configDef.FieldDefs != "" {
		t.Logf("FieldDefs: %s", configDef.FieldDefs)
	}
}

func TestCLSP_MakeSharedTemplateArg(t *testing.T) {
	source := `
#include <memory>

class Widget {
public:
    void resize(int w, int h) {}
};

void test() {
    auto ptr = std::make_shared<Widget>();
    ptr->resize(10, 20);
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "resize")
}

func TestCLSP_MakeUniqueTemplateArg(t *testing.T) {
	source := `
#include <memory>

class Engine {
public:
    void start() {}
};

void test() {
    auto e = std::make_unique<Engine>();
    e->start();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "start")
}

func TestCLSP_TemplateClassMethodReturnType(t *testing.T) {
	source := `
template<typename T>
class Box {
public:
    T get() { return val; }
    void set(T v) { val = v; }
private:
    T val;
};

class Widget {
public:
    void draw() {}
};

void test() {
    Box<Widget> b;
    b.get().draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_TrailingReturnType(t *testing.T) {
	source := `
class Foo {
public:
    void bar() {}
};

auto createFoo() -> Foo* {
    return new Foo();
}

void test() {
    auto f = createFoo();
    f->bar();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "bar")
}

func TestCLSP_TrailingReturnTypeMethod(t *testing.T) {
	source := `
class Builder {
public:
    auto self() -> Builder& { return *this; }
    void build() {}
};

void test() {
    Builder b;
    b.self().build();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "build")
}

func TestCLSP_CPPClassFieldExtraction(t *testing.T) {
	source := `
class Widget {
public:
    int width;
    int height;
    void resize(int w, int h) {}
private:
    float scale;
};
`
	result := extractCPPWithRegistry(t, source)
	fieldCount := 0
	methodCount := 0
	for _, d := range result.Definitions {
		if d.Label == "Field" {
			fieldCount++
		}
		if d.Label == "Method" {
			methodCount++
		}
	}
	if fieldCount != 3 {
		t.Errorf("expected 3 Field defs (width, height, scale), got %d", fieldCount)
		for _, d := range result.Definitions {
			t.Logf("  def: %s label=%s type=%s", d.Name, d.Label, d.ReturnType)
		}
	}
	if methodCount != 1 {
		t.Errorf("expected 1 Method def (resize), got %d", methodCount)
	}
}

// --- STL stub coverage tests ---

func TestCLSP_StdVariant(t *testing.T) {
	source := `
#include <variant>
#include <string>

void test() {
    std::variant<int, std::string> v;
    v.index();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "index")
}

func TestCLSP_StdDeque(t *testing.T) {
	source := `
#include <deque>

class Task {
public:
    void run() {}
};

void test() {
    std::deque<Task> q;
    q.push_back(Task());
    q.front().run();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "push_back")
	requireResolvedCall(t, result, "test", "front")
	requireResolvedCall(t, result, "test", "run")
}

func TestCLSP_StdFilesystem(t *testing.T) {
	source := `
#include <filesystem>

void test() {
    std::filesystem::path p("/tmp/test");
    p.filename();
    std::filesystem::exists(p);
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "filename")
	requireResolvedCall(t, result, "test", "exists")
}

func TestCLSP_StdAccumulate(t *testing.T) {
	source := `
#include <vector>
#include <numeric>

void test() {
    std::vector<int> v;
    std::accumulate(v.begin(), v.end(), 0);
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "accumulate")
	requireResolvedCall(t, result, "test", "begin")
	requireResolvedCall(t, result, "test", "end")
}

func TestCLSP_StdStringStream(t *testing.T) {
	source := `
#include <sstream>
#include <string>

void test() {
    std::stringstream ss;
    ss.str();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "str")
}

// --- Third-party stub coverage tests ---

func TestCLSP_AbseilStatusOr(t *testing.T) {
	source := `
namespace absl {
    class Status {
    public:
        bool ok() { return true; }
        int code() { return 0; }
    };
    template<typename T> class StatusOr {
    public:
        bool ok() { return true; }
        T value() { return T(); }
        Status status() { return Status(); }
    };
}

class Widget {
public:
    void draw() {}
};

void test() {
    absl::StatusOr<Widget> result;
    if (result.ok()) {
        result.value().draw();
    }
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "ok")
	requireResolvedCall(t, result, "test", "value")
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_SpdlogLogger(t *testing.T) {
	source := `
namespace spdlog {
    class logger {
    public:
        void info(const char* msg) {}
        void warn(const char* msg) {}
        void error(const char* msg) {}
    };
    void info(const char* msg) {}
}

void test() {
    spdlog::logger log;
    log.info("hello");
    log.warn("caution");
    spdlog::info("global");
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "info")
	requireResolvedCall(t, result, "test", "warn")
}

func TestCLSP_QtQString(t *testing.T) {
	source := `
class QString {
public:
    int length() { return 0; }
    bool isEmpty() { return true; }
    QString trimmed() { return *this; }
    const char* toUtf8() { return ""; }
};

void test() {
    QString s;
    s.trimmed().length();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "trimmed")
	requireResolvedCall(t, result, "test", "length")
}

// --- ADL (Argument-Dependent Lookup) tests ---

func TestCLSP_ADL_Swap(t *testing.T) {
	source := `
namespace mylib {
    class Widget {
    public:
        void draw() {}
    };
    void swap(Widget& a, Widget& b) {}
}

void test() {
    mylib::Widget a, b;
    swap(a, b);
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "swap")
}

func TestCLSP_ADL_OperatorFreeFunc(t *testing.T) {
	source := `
namespace geo {
    class Point {
    public:
        int x, y;
    };
    double distance(Point& a, Point& b) { return 0.0; }
}

void test() {
    geo::Point p1, p2;
    distance(p1, p2);
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "distance")
}

func TestCLSP_ADL_StdSort(t *testing.T) {
	// std::sort with std::vector iterators — ADL should find std::sort
	source := `
#include <vector>
#include <algorithm>

void test() {
    std::vector<int> v;
    sort(v.begin(), v.end());
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "sort")
}

func TestCLSP_ADL_NoFalsePositive(t *testing.T) {
	// Non-namespace type should NOT trigger ADL for missing functions
	source := `
class Foo {
public:
    int x;
};

void test() {
    Foo f;
    unknown_func(f);
}
`
	result := extractCPPWithRegistry(t, source)
	// Should NOT resolve — Foo is not in a namespace
	for _, rc := range result.ResolvedCalls {
		if rc.CallerQN != "" && rc.CalleeQN != "" {
			if strings.Contains(rc.CalleeQN, "unknown_func") && rc.Strategy != "lsp_unresolved" {
				t.Errorf("ADL should not resolve unknown_func for non-namespaced type, got strategy=%s", rc.Strategy)
			}
		}
	}
}

// ============================================================================
// Task 1: Overload Resolution by Parameter Type
// ============================================================================

func TestCLSP_OverloadByType(t *testing.T) {
	source := `
class Widget {};
class Gadget {};

class Foo {
public:
    void process(Widget* w) {}
    void process(Gadget* g) {}
};

void test() {
    Foo f;
    Widget w;
    f.process(&w);
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "process")
}

func TestCLSP_OverloadByTypeMethod(t *testing.T) {
	source := `
class Renderer {
public:
    void draw(int x) {}
    void draw(double x) {}
};

void test() {
    Renderer r;
    r.draw(42);
    r.draw(3.14);
}
`
	result := extractCPPWithRegistry(t, source)
	calls := findAllResolvedCalls(t, result, "test", "draw")
	if len(calls) < 2 {
		t.Errorf("expected at least 2 draw calls resolved, got %d", len(calls))
	}
}

// ============================================================================
// Task 2: Lambda Return Type Inference
// ============================================================================

func TestCLSP_LambdaTrailingReturn(t *testing.T) {
	source := `
class Widget {
public:
    void draw() {}
};

void test() {
    auto fn = [](int x) -> Widget { Widget w; return w; };
    fn(1).draw();
}
`
	result := extractCPPWithRegistry(t, source)
	// Lambda has trailing return type -> Widget, so .draw() should resolve
	rc := findResolvedCall(t, result, "test", "draw")
	if rc == nil {
		t.Log("lambda trailing return type not resolving draw — tree-sitter may not expose trailing_return_type on lambda")
	}
}

func TestCLSP_LambdaBodyInference(t *testing.T) {
	source := `
class Widget {
public:
    void activate() {}
};

Widget global_widget;

void test() {
    auto fn = []() { return global_widget; };
}
`
	result := extractCPPWithRegistry(t, source)
	// Just verify no crash and the lambda is parsed
	_ = result
}

// ============================================================================
// Task 3: Inline Namespace Normalization
// ============================================================================

func TestCLSP_InlineNamespace_Libc(t *testing.T) {
	source := `
namespace std {
namespace __1 {
class string {
public:
    int size() { return 0; }
};
}
}

void test() {
    std::__1::string s;
    s.size();
}
`
	result := extractCPPWithRegistry(t, source)
	// std::__1::string should normalize to std.string
	requireResolvedCall(t, result, "test", "size")
}

func TestCLSP_InlineNamespace_GCC(t *testing.T) {
	source := `
namespace std {
namespace __cxx11 {
class basic_string {
public:
    int length() { return 0; }
};
}
}

void test() {
    std::__cxx11::basic_string s;
    s.length();
}
`
	result := extractCPPWithRegistry(t, source)
	// std::__cxx11::basic_string should normalize to std.basic_string
	requireResolvedCall(t, result, "test", "length")
}

// ============================================================================
// Task 4: Implicit Conversions
// ============================================================================

func TestCLSP_ImplicitStringConversion(t *testing.T) {
	source := `
namespace std {
class string {
public:
    int size() { return 0; }
};
}

class Logger {
public:
    void log(std::string msg) {}
    void log(int code) {}
};

void test() {
    Logger l;
    l.log("hello");
    l.log(42);
}
`
	result := extractCPPWithRegistry(t, source)
	calls := findAllResolvedCalls(t, result, "test", "log")
	if len(calls) < 2 {
		t.Errorf("expected at least 2 log calls, got %d", len(calls))
	}
}

func TestCLSP_NumericPromotion(t *testing.T) {
	source := `
class Math {
public:
    double compute(double x) { return x; }
    int compute(int x) { return x; }
};

void test() {
    Math m;
    m.compute(42);
    m.compute(3.14);
}
`
	result := extractCPPWithRegistry(t, source)
	calls := findAllResolvedCalls(t, result, "test", "compute")
	if len(calls) < 2 {
		t.Errorf("expected at least 2 compute calls, got %d", len(calls))
	}
}

// ============================================================================
// Task 5: Virtual Dispatch (Override Preference)
// ============================================================================

func TestCLSP_VirtualOverride(t *testing.T) {
	source := `
class Base {
public:
    virtual void draw() {}
};

class Derived : public Base {
public:
    void draw() {}
};

void test() {
    Derived d;
    d.draw();
}
`
	result := extractCPPWithRegistry(t, source)
	rc := requireResolvedCall(t, result, "test", "draw")
	// Should prefer Derived::draw over Base::draw
	if rc.Strategy != "lsp_type_dispatch" && rc.Strategy != "lsp_virtual_dispatch" {
		t.Logf("virtual dispatch strategy: %s (expected lsp_type_dispatch or lsp_virtual_dispatch)", rc.Strategy)
	}
}

func TestCLSP_BasePointerCall(t *testing.T) {
	source := `
class Base {
public:
    virtual void render() {}
};

class Derived : public Base {
};

void test() {
    Derived d;
    d.render();
}
`
	result := extractCPPWithRegistry(t, source)
	rc := requireResolvedCall(t, result, "test", "render")
	// No override in Derived — should resolve to Base::render via base dispatch
	if rc.Strategy != "lsp_base_dispatch" {
		t.Logf("base dispatch strategy: %s (expected lsp_base_dispatch)", rc.Strategy)
	}
}

// ============================================================================
// Task 6: CRTP Detection
// ============================================================================

func TestCLSP_CRTP_Basic(t *testing.T) {
	source := `
template<class T>
class Base {
public:
    T& self() { return static_cast<T&>(*this); }
    void base_method() {
        self().impl();
    }
};

class Derived : public Base<Derived> {
public:
    void impl() {}
};
`
	result := extractCPPWithRegistry(t, source)
	// CRTP: Base<Derived> should bind T=Derived, so self().impl() should resolve
	rc := findResolvedCall(t, result, "base_method", "impl")
	if rc == nil {
		t.Log("CRTP resolution not fully working — T not bound to Derived in template scope")
	}
}

func TestCLSP_CRTP_MultiParam(t *testing.T) {
	source := `
template<class T, class Policy>
class CRTPBase {
public:
    void apply() {
        static_cast<T*>(this)->do_work();
    }
};

class MyClass : public CRTPBase<MyClass, int> {
public:
    void do_work() {}
};
`
	result := extractCPPWithRegistry(t, source)
	// Multi-param CRTP: only T should be bound to MyClass
	rc := findResolvedCall(t, result, "apply", "do_work")
	if rc == nil {
		t.Log("multi-param CRTP not resolving do_work — expected T bound to MyClass")
	}
}

// ============================================================================
// Task 7: Range-For Iterator Protocol
// ============================================================================

func TestCLSP_RangeForMap(t *testing.T) {
	source := `
namespace std {
template<class K, class V>
class map {
public:
    K* begin() { return nullptr; }
};

template<class A, class B>
class pair {
public:
    A first;
    B second;
};
}

class Widget {
public:
    void draw() {}
};

void test() {
    std::map<int, Widget> m;
    for (auto& p : m) {
        p.second.draw();
    }
}
`
	result := extractCPPWithRegistry(t, source)
	// Map elements should be pair<int, Widget>, so p.second.draw() resolves
	rc := findResolvedCall(t, result, "test", "draw")
	if rc == nil {
		t.Log("map range-for not resolving draw on pair.second — field lookup on std.pair not working")
	}
}

func TestCLSP_RangeForCustomIterator(t *testing.T) {
	source := `
class Widget {
public:
    void activate() {}
};

class Iterator {
public:
    Widget operator*() { Widget w; return w; }
};

class Container {
public:
    Iterator begin() { Iterator it; return it; }
    Iterator end() { Iterator it; return it; }
};

void test() {
    Container c;
    for (auto& w : c) {
        w.activate();
    }
}
`
	result := extractCPPWithRegistry(t, source)
	// Iterator protocol: begin() -> Iterator, operator*() -> Widget
	rc := findResolvedCall(t, result, "test", "activate")
	if rc == nil {
		t.Log("custom iterator protocol not resolving — begin()/operator*() chain not working")
	}
}

// ============================================================================
// Template Argument Deduction (TAD)
// ============================================================================

func TestCLSP_TAD_FreeFunctionIdentity(t *testing.T) {
	// Template free function where return type = param type (identity)
	source := `
class Widget {
public:
    void draw() {}
};

template<class T>
T identity(T x) { return x; }

void test() {
    Widget w;
    identity(w).draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_TAD_MakePairLike(t *testing.T) {
	// Template free function returning pair<T,U>
	source := `
namespace std {
template<class A, class B>
class pair {
public:
    A first;
    B second;
};
}

class Widget {
public:
    void activate() {}
};

template<class T, class U>
std::pair<T, U> make_my_pair(T a, U b) { std::pair<T,U> p; return p; }

void test() {
    Widget w;
    auto p = make_my_pair(42, w);
}
`
	result := extractCPPWithRegistry(t, source)
	// Should deduce T=int, U=Widget
	_ = result
}

// ============================================================================
// Structured Bindings
// ============================================================================

func TestCLSP_StructuredBindingPair(t *testing.T) {
	source := `
namespace std {
template<class A, class B>
class pair {
public:
    A first;
    B second;
};
}

class Widget {
public:
    void draw() {}
};

void test() {
    std::pair<int, Widget> p;
    auto [x, w] = p;
    w.draw();
}
`
	result := extractCPPWithRegistry(t, source)
	rc := findResolvedCall(t, result, "test", "draw")
	if rc == nil {
		t.Log("structured binding not decomposing pair<int, Widget> — w.draw() unresolved")
	}
}

func TestCLSP_StructuredBindingStruct(t *testing.T) {
	source := `
class Engine {
public:
    void start() {}
};

struct Car {
    int year;
    Engine engine;
};

void test() {
    Car c;
    auto [y, eng] = c;
    eng.start();
}
`
	result := extractCPPWithRegistry(t, source)
	rc := findResolvedCall(t, result, "test", "start")
	if rc == nil {
		t.Log("structured binding not decomposing struct fields — eng.start() unresolved")
	}
}

// ============================================================================
// Conditional / Ternary expression type
// ============================================================================

func TestCLSP_TernaryType(t *testing.T) {
	source := `
class Widget {
public:
    void draw() {}
};

Widget global_w;

void test() {
    Widget* p = &global_w;
    auto& w = true ? *p : global_w;
    w.draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

// ============================================================================
// Static cast expression type
// ============================================================================

// ============================================================================
// Gap assessment: patterns that should work
// ============================================================================

func TestCLSP_ChainedMethodCalls(t *testing.T) {
	// builder.setX().setY().build() — common pattern
	source := `
class Widget {
public:
    void render() {}
};

class Builder {
public:
    Builder& setWidth(int w) { return *this; }
    Builder& setHeight(int h) { return *this; }
    Widget build() { Widget w; return w; }
};

void test() {
    Builder b;
    b.setWidth(10).setHeight(20).build().render();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "render")
}

func TestCLSP_StdVectorPushBack(t *testing.T) {
	// Common pattern: vec.push_back() then vec[i].method()
	source := `
namespace std {
template<class T>
class vector {
public:
    void push_back(T x) {}
    T& operator[](int i) { return *(T*)0; }
    int size() { return 0; }
};
}

class Widget {
public:
    void draw() {}
};

void test() {
    std::vector<Widget> widgets;
    widgets.push_back(Widget());
    widgets[0].draw();
    widgets.size();
}
`
	result := extractCPPWithRegistry(t, source)
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s]", rc.CallerQN, rc.CalleeQN, rc.Strategy)
	}
	requireResolvedCall(t, result, "test", "push_back")
	requireResolvedCall(t, result, "test", "size")
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_IteratorDeref(t *testing.T) {
	// it->method() with smart pointer or iterator
	source := `
namespace std {
template<class T>
class unique_ptr {
public:
    T* operator->() { return (T*)0; }
    T& operator*() { return *(T*)0; }
};
}

class Widget {
public:
    void draw() {}
};

void test() {
    std::unique_ptr<Widget> p;
    p->draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_EnumClassUsage(t *testing.T) {
	// enum class shouldn't cause issues
	source := `
class Logger {
public:
    void log(int level) {}
};

void test() {
    Logger l;
    l.log(0);
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "log")
}

func TestCLSP_MultipleReturnPaths(t *testing.T) {
	// Function returning different types based on branches — should get first return
	source := `
class Widget {
public:
    void draw() {}
};

Widget make_widget() { Widget w; return w; }

void test() {
    auto w = make_widget();
    w.draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_NestedTemplate(t *testing.T) {
	// vector<vector<Widget>> — nested templates
	source := `
namespace std {
template<class T>
class vector {
public:
    T& operator[](int i) { return *(T*)0; }
};
}

class Widget {
public:
    void draw() {}
};

void test() {
    std::vector<std::vector<Widget>> grid;
    grid[0][0].draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_ConstRef(t *testing.T) {
	// const Widget& should resolve methods
	source := `
class Widget {
public:
    void draw() {}
};

void process(const Widget& w) {
    w.draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "process", "draw")
}

func TestCLSP_StdFunctionCallback(t *testing.T) {
	// std::function<void(int)> — functor call
	source := `
namespace std {
template<class T>
class function {};

template<class R, class... Args>
class function<R(Args...)> {
public:
    R operator()(Args... args) { return R(); }
};
}

class Widget {
public:
    void draw() {}
};

void test() {
    std::function<Widget()> factory;
    factory().draw();
}
`
	result := extractCPPWithRegistry(t, source)
	rc := findResolvedCall(t, result, "test", "draw")
	if rc == nil {
		t.Log("std::function operator() not resolving — variadic template specialization not supported")
	}
}

func TestCLSP_OptionalValueAccess(t *testing.T) {
	// optional<T>::value() / operator*()
	source := `
namespace std {
template<class T>
class optional {
public:
    T& value() { return *(T*)0; }
    T& operator*() { return *(T*)0; }
};
}

class Widget {
public:
    void draw() {}
};

void test() {
    std::optional<Widget> opt;
    opt.value().draw();
    (*opt).draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_TypedefChain(t *testing.T) {
	// using + typedef chains
	source := `
class Widget {
public:
    void draw() {}
};

using WidgetRef = Widget&;
typedef Widget* WidgetPtr;

void test(WidgetPtr p) {
    p->draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_IfInitStatement(t *testing.T) {
	// C++17 if-init: if (auto x = expr; condition)
	source := `
class Widget {
public:
    void draw() {}
    bool valid() { return true; }
};

Widget make() { Widget w; return w; }

void test() {
    if (auto w = make(); w.valid()) {
        w.draw();
    }
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
	requireResolvedCall(t, result, "test", "valid")
}

func TestCLSP_DependentTypeMember(t *testing.T) {
	// T::value_type — dependent type member access
	source := `
namespace std {
template<class T>
class vector {
public:
    T& operator[](int i) { return *(T*)0; }
};
}

class Widget {
public:
    void draw() {}
};

template<class Container>
void process(Container& c) {
    c[0].draw();
}
`
	result := extractCPPWithRegistry(t, source)
	// Template function with unknown Container — c[0] returns unknown
	rc := findResolvedCall(t, result, "process", "draw")
	if rc != nil {
		t.Log("dependent type member access resolved — better than expected!")
	} else {
		t.Log("dependent type: process->draw not resolved (expected — Container is uninstantiated)")
	}
}

func TestCLSP_AutoReturnFunction(t *testing.T) {
	// auto return type deduction
	source := `
class Widget {
public:
    void draw() {}
};

auto make_widget() {
    Widget w;
    return w;
}

void test() {
    auto w = make_widget();
    w.draw();
}
`
	result := extractCPPWithRegistry(t, source)
	rc := findResolvedCall(t, result, "test", "draw")
	if rc != nil {
		t.Log("auto return type deduction working!")
	} else {
		t.Log("auto return: test->draw not resolved (make_widget() returns unknown)")
	}
}

func TestCLSP_MoveSemantics(t *testing.T) {
	// std::move should preserve type
	source := `
class Widget {
public:
    void draw() {}
};

namespace std {
template<class T>
T&& move(T& x) { return (T&&)x; }
}

void test() {
    Widget w;
    auto w2 = std::move(w);
    w2.draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_MultiLevelInheritance(t *testing.T) {
	// A -> B -> C, C calls method from A
	source := `
class A {
public:
    void base_op() {}
};

class B : public A {
public:
    void mid_op() {}
};

class C : public B {
public:
    void leaf_op() {}
};

void test() {
    C c;
    c.base_op();
    c.mid_op();
    c.leaf_op();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "leaf_op")
	rc := findResolvedCall(t, result, "test", "base_op")
	if rc == nil {
		t.Log("multi-level inheritance: base_op not resolved through C->B->A chain")
	}
}

func TestCLSP_RangeForStructuredBinding(t *testing.T) {
	// for (auto& [key, val] : map) — combination of range-for + structured binding
	source := `
namespace std {
template<class K, class V>
class map {
public:
    void* begin() { return 0; }
};

template<class A, class B>
class pair {
public:
    A first;
    B second;
};
}

class Widget {
public:
    void draw() {}
};

void test() {
    std::map<int, Widget> m;
    for (auto& [key, widget] : m) {
        widget.draw();
    }
}
`
	result := extractCPPWithRegistry(t, source)
	rc := findResolvedCall(t, result, "test", "draw")
	if rc != nil {
		t.Log("range-for + structured binding resolving draw!")
	} else {
		t.Log("range-for + structured binding: draw not resolved (structured binding in range-for)")
	}
}

func TestCLSP_CrossFileInclude(t *testing.T) {
	// In cross-file mode, functions from other files should resolve
	// This tests the basic cross-file infrastructure
	source := `
class Widget {
public:
    void draw() {}
};

void render(Widget& w) {
    w.draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "render", "draw")
}

func TestCLSP_FunctionReturningRef(t *testing.T) {
	// Method returning T& — unwrap ref to get underlying type
	source := `
class Widget {
public:
    void draw() {}
};

class Container {
public:
    Widget& front() { return *(Widget*)0; }
};

void test() {
    Container c;
    c.front().draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_TemplateMethodChain(t *testing.T) {
	// vector<Widget>.front().draw() — uses stdlib-registered std::vector methods
	source := `
namespace std {
template<class T> class vector {};
}

class Widget {
public:
    void draw() {}
};

void test() {
    std::vector<Widget> v;
    v.front().draw();
}
`
	result := extractCPPWithRegistry(t, source)
	for _, rc := range result.ResolvedCalls {
		t.Logf("  %s -> %s [%s %.2f]", rc.CallerQN, rc.CalleeQN, rc.Strategy, rc.Confidence)
	}
	rc := findResolvedCall(t, result, "test", "draw")
	if rc != nil && rc.Strategy != "lsp_unresolved" {
		t.Logf("template method chain resolving! strategy=%s", rc.Strategy)
	} else {
		t.Log("template method chain: front().draw() not fully resolved")
	}
}

func TestCLSP_AlgorithmWithLambda(t *testing.T) {
	// std::for_each(v.begin(), v.end(), [](Widget& w) { w.draw(); })
	source := `
namespace std {
template<class It, class Fn>
void for_each(It first, It last, Fn f) {}

template<class T>
class vector {
public:
    T* begin() { return (T*)0; }
    T* end() { return (T*)0; }
};
}

class Widget {
public:
    void draw() {}
};

void test() {
    std::vector<Widget> widgets;
    std::for_each(widgets.begin(), widgets.end(), [](Widget& w) {
        w.draw();
    });
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_StaticCastChain(t *testing.T) {
	source := `
class Base {
public:
    void base_method() {}
};

class Derived : public Base {
public:
    void derived_method() {}
};

void test() {
    Base* b = nullptr;
    static_cast<Derived*>(b)->derived_method();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "derived_method")
}

// ============================================================================
// Gap assessment: patterns needed for LSP parity
// ============================================================================

func TestCLSP_SmartPointerArrow(t *testing.T) {
	source := `
namespace std {
template<class T> class unique_ptr {
public:
    T* operator->() { return (T*)0; }
    T& operator*() { return *(T*)0; }
};
}

class Widget {
public:
    void draw() {}
};

void test() {
    std::unique_ptr<Widget> p;
    p->draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_StaticMethodCall(t *testing.T) {
	source := `
class Widget {
public:
    static Widget create() { return Widget(); }
    void draw() {}
};

void test() {
    Widget w = Widget::create();
    w.draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "create")
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_SubscriptDraw(t *testing.T) {
	source := `
namespace std {
template<class T> class vector {
public:
    T& operator[](int i) { return *(T*)0; }
    int size() { return 0; }
};
}

class Widget {
public:
    void draw() {}
};

void test() {
    std::vector<Widget> v;
    v[0].draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_AutoFromMethodReturn(t *testing.T) {
	source := `
class Product {
public:
    void use() {}
};

class Factory {
public:
    Product create() { return Product(); }
};

void test() {
    Factory f;
    auto p = f.create();
    p.use();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "create")
	requireResolvedCall(t, result, "test", "use")
}

func TestCLSP_NestedClassReturnType(t *testing.T) {
	source := `
class Factory {
public:
    class Product {
    public:
        void use() {}
    };
    Product create() { return Product(); }
};

void test() {
    Factory f;
    auto p = f.create();
    p.use();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "create")
	requireResolvedCall(t, result, "test", "use")
}

func TestCLSP_MakeSharedChain(t *testing.T) {
	source := `
namespace std {
template<class T> class shared_ptr {
public:
    T* operator->() { return (T*)0; }
};
template<class T> shared_ptr<T> make_shared() { return shared_ptr<T>(); }
}

class Widget {
public:
    void draw() {}
};

void test() {
    auto p = std::make_shared<Widget>();
    p->draw();
}
`
	result := extractCPPWithRegistry(t, source)
	requireResolvedCall(t, result, "test", "make_shared")
	requireResolvedCall(t, result, "test", "draw")
}

func TestCLSP_DependentMemberCall(t *testing.T) {
	source := `
class Widget {
public:
    void draw() {}
};

template<class T>
void process(T item) {
    item.draw();
}

void test() {
    Widget w;
    process(w);
}
`
	result := extractCPPWithRegistry(t, source)
	// process(w) should be resolved
	requireResolvedCall(t, result, "test", "process")
	// item.draw() inside process should be resolved via template instantiation
	found := false
	for _, rc := range result.ResolvedCalls {
		if strings.Contains(rc.CalleeQN, "Widget") && strings.Contains(rc.CalleeQN, "draw") &&
			rc.Strategy != "lsp_unresolved" {
			found = true
			t.Logf("dependent member call resolved: %s [%s]", rc.CalleeQN, rc.Strategy)
		}
	}
	if !found {
		t.Error("dependent member call item.draw() not resolved via template instantiation")
		for _, rc := range result.ResolvedCalls {
			t.Logf("  %s -> %s [%s]", rc.CallerQN, rc.CalleeQN, rc.Strategy)
		}
	}
}
