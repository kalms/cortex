package cbm

import (
	"testing"

	"github.com/DeusData/codebase-memory-mcp/internal/lang"
)

// =====================================================================
// CONFIRMED RED: CommonLisp — defun never matched (empty func_types)
// =====================================================================

func TestCommonLispDefunExtraction(t *testing.T) {
	source := []byte("(defun hello () \"world\")\n")
	result, err := ExtractFile(source, lang.CommonLisp, "test", "hello.lisp")
	if err != nil {
		t.Fatal(err)
	}
	fns := defsWithLabel(result, "Function")
	if len(fns) == 0 {
		t.Errorf("expected >=1 Function from CommonLisp defun, got 0 (commonlisp_func_types is empty)")
	}
	assertHasName(t, fns, "hello")
}

func TestCommonLispMultipleFunctions(t *testing.T) {
	source := []byte("(defun add (a b) (+ a b))\n(defun mul (a b) (* a b))\n")
	result, err := ExtractFile(source, lang.CommonLisp, "test", "math.lisp")
	if err != nil {
		t.Fatal(err)
	}
	fns := defsWithLabel(result, "Function")
	if len(fns) < 2 {
		t.Errorf("expected >=2 Functions (add, mul), got %d: %v", len(fns), names(fns))
	}
	assertHasName(t, fns, "add")
	assertHasName(t, fns, "mul")
}

func TestCommonLispDefmacro(t *testing.T) {
	source := []byte("(defmacro when2 (condition &body body)\n  `(if ,condition (progn ,@body)))\n")
	result, err := ExtractFile(source, lang.CommonLisp, "test", "macros.lisp")
	if err != nil {
		t.Fatal(err)
	}
	// defmacro is a separate node type; this test just ensures no crash
	_ = result
}

// =====================================================================
// CONFIRMED RED: Makefile — rule not in function_node_types
// =====================================================================

func TestMakefileRuleAsFunction(t *testing.T) {
	source := []byte("all:\n\t@echo hello\n")
	result, err := ExtractFile(source, lang.Makefile, "test", "Makefile")
	if err != nil {
		t.Fatal(err)
	}
	fns := defsWithLabel(result, "Function")
	if len(fns) == 0 {
		t.Errorf("expected >=1 Function (target 'all'), got 0 (rule not in func_types)")
	}
	assertHasName(t, fns, "all")
}

func TestMakefileMultipleTargets(t *testing.T) {
	source := []byte("all: main.o\n\tgcc -o all main.o\n\nbuild:\n\tgo build ./...\n")
	result, err := ExtractFile(source, lang.Makefile, "test", "Makefile")
	if err != nil {
		t.Fatal(err)
	}
	fns := defsWithLabel(result, "Function")
	if len(fns) < 2 {
		t.Errorf("expected >=2 Functions (all, build), got %d: %v", len(fns), names(fns))
	}
	assertHasName(t, fns, "all")
	assertHasName(t, fns, "build")
}

func TestMakefileVariableExtraction(t *testing.T) {
	source := []byte("CC := gcc\nCFLAGS := -Wall\n")
	result, err := ExtractFile(source, lang.Makefile, "test", "Makefile")
	if err != nil {
		t.Fatal(err)
	}
	vars := defsWithLabel(result, "Variable")
	// variable_assignment is in VariableNodeTypes; this probe reveals if name extraction works
	if len(vars) == 0 {
		t.Logf("INFO: Makefile variable extraction returns 0 vars — name field may need a Makefile case in extract_var_names")
	} else {
		assertHasName(t, vars, "CC")
		assertHasName(t, vars, "CFLAGS")
	}
}

// =====================================================================
// PROBE: VimScript — may pass or fail; reveals root cause
// =====================================================================

func TestVimScriptFunctionExtraction(t *testing.T) {
	source := []byte("function! SayHello()\n  echo 'Hello'\nendfunction\n")
	result, err := ExtractFile(source, lang.VimScript, "test", "plugin.vim")
	if err != nil {
		t.Fatal(err)
	}
	fns := defsWithLabel(result, "Function")
	if len(fns) == 0 {
		t.Errorf("expected >=1 Function from VimScript function!, got 0 — name field on function_definition may not be exposed directly")
	}
	assertHasName(t, fns, "SayHello")
}

func TestVimScriptFunctionWithoutBang(t *testing.T) {
	source := []byte("function MyFunc(arg)\n  return arg\nendfunction\n")
	result, err := ExtractFile(source, lang.VimScript, "test", "plugin.vim")
	if err != nil {
		t.Fatal(err)
	}
	fns := defsWithLabel(result, "Function")
	if len(fns) == 0 {
		t.Errorf("expected >=1 Function from VimScript function (no bang), got 0")
	}
	assertHasName(t, fns, "MyFunc")
}

// =====================================================================
// PROBE: Julia — may pass or fail; reveals whether 0.00 is grammar or discovery
// =====================================================================

func TestJuliaFunctionExtraction(t *testing.T) {
	source := []byte("function hello()\n  println(\"Hello, World!\")\nend\n")
	result, err := ExtractFile(source, lang.Julia, "test", "hello.jl")
	if err != nil {
		t.Fatal(err)
	}
	fns := defsWithLabel(result, "Function")
	if len(fns) == 0 {
		t.Errorf("expected >=1 Function from Julia function_definition, got 0")
	}
	assertHasName(t, fns, "hello")
}

func TestJuliaFunctionWithArgs(t *testing.T) {
	source := []byte("function add(a::Int, b::Int)::Int\n  return a + b\nend\n")
	result, err := ExtractFile(source, lang.Julia, "test", "math.jl")
	if err != nil {
		t.Fatal(err)
	}
	fns := defsWithLabel(result, "Function")
	if len(fns) == 0 {
		t.Errorf("expected >=1 Function from Julia function with args, got 0")
	}
	assertHasName(t, fns, "add")
}
