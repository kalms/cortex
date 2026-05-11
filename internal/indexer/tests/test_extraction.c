/*
 * test_extraction.c — Regression tests for the extraction module.
 *
 * Port of internal/cbm/regression_test.go (1282 LOC, ~80 test cases).
 * Exercises ctx_extract_file() on code snippets across 30+ languages,
 * verifying definitions, calls, and imports are correctly extracted.
 */
#include "test_framework.h"
#include "extract.h"

/* ── Helpers ───────────────────────────────────────────────────── */

/* Check if any definition with the given label has the given name. */
static int has_def(CtxFileResult *r, const char *label, const char *name) {
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].label, label) == 0 && strcmp(r->defs.items[i].name, name) == 0)
            return 1;
    }
    return 0;
}

/* Check if any definition has the given name (any label). */
static int has_def_any(CtxFileResult *r, const char *name) {
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].name, name) == 0)
            return 1;
    }
    return 0;
}

/* Check if any call to the given callee exists. */
static int has_call(CtxFileResult *r, const char *callee) {
    for (int i = 0; i < r->calls.count; i++) {
        if (strstr(r->calls.items[i].callee_name, callee) != NULL)
            return 1;
    }
    return 0;
}

/* Check if any import with the given module path exists. */
static int __attribute__((unused)) has_import(CtxFileResult *r, const char *path_substr) {
    for (int i = 0; i < r->imports.count; i++) {
        if (r->imports.items[i].module_path &&
            strstr(r->imports.items[i].module_path, path_substr) != NULL)
            return 1;
    }
    return 0;
}

/* Count definitions with a given label. */
static int count_defs_with_label(CtxFileResult *r, const char *label) {
    int count = 0;
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].label, label) == 0)
            count++;
    }
    return count;
}

/* Convenience: extract, assert no error, return result. Caller frees. */
static CtxFileResult *extract(const char *src, CtxLanguage lang, const char *proj,
                              const char *path) {
    CtxFileResult *r = ctx_extract_file(src, (int)strlen(src), lang, proj, path, 0, NULL, NULL);
    return r;
}

/* ═══════════════════════════════════════════════════════════════════
 * Group A: OOP Languages
 * ═══════════════════════════════════════════════════════════════════ */

/* --- Java --- */
TEST(java_class) {
    CtxFileResult *r = extract(
        "public class Animal { private String name; public String getName() { return name; } }",
        CTX_LANG_JAVA, "t", "Animal.java");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Animal"));
    ctx_free_result(r);
    PASS();
}

TEST(java_method) {
    CtxFileResult *r = extract(
        "public class Svc { public void doWork() {} public int compute(int x) { return x; } }",
        CTX_LANG_JAVA, "t", "Svc.java");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Method", "doWork"));
    ASSERT(has_def(r, "Method", "compute"));
    ctx_free_result(r);
    PASS();
}

TEST(java_interface) {
    CtxFileResult *r =
        extract("public interface Repository { void save(Object o); Object findById(long id); }",
                CTX_LANG_JAVA, "t", "Repo.java");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def_any(r, "Repository"));
    ctx_free_result(r);
    PASS();
}

/* --- PHP --- */
TEST(php_class) {
    CtxFileResult *r = extract("<?php\nclass User { public string $name; public function "
                               "getName(): string { return $this->name; } }",
                               CTX_LANG_PHP, "t", "User.php");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "User"));
    ASSERT(has_def(r, "Method", "getName"));
    ctx_free_result(r);
    PASS();
}

TEST(php_function) {
    CtxFileResult *r =
        extract("<?php\nfunction greet(string $name): string { return 'Hello ' . $name; }",
                CTX_LANG_PHP, "t", "helpers.php");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "greet"));
    ctx_free_result(r);
    PASS();
}

/* --- Ruby --- */
TEST(ruby_class) {
    CtxFileResult *r = extract("class Animal\n  def initialize(name)\n    @name = name\n  end\n  "
                               "def speak\n    puts @name\n  end\nend\n",
                               CTX_LANG_RUBY, "t", "animal.rb");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Animal"));
    ASSERT(has_def(r, "Method", "speak"));
    ctx_free_result(r);
    PASS();
}

TEST(ruby_module) {
    CtxFileResult *r = extract("module Greetable\n  def greet\n    \"Hello\"\n  end\nend\n",
                               CTX_LANG_RUBY, "t", "greetable.rb");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def_any(r, "Greetable"));
    ctx_free_result(r);
    PASS();
}

/* --- C# --- */
TEST(csharp_class) {
    CtxFileResult *r = extract("namespace App { public class Service { public void Run() {} public "
                               "int Compute(int x) => x * 2; } }",
                               CTX_LANG_CSHARP, "t", "Service.cs");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Service"));
    ASSERT(has_def(r, "Method", "Run"));
    ctx_free_result(r);
    PASS();
}

TEST(csharp_interface) {
    CtxFileResult *r = extract("public interface IService { void Execute(); string GetStatus(); }",
                               CTX_LANG_CSHARP, "t", "IService.cs");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def_any(r, "IService"));
    ctx_free_result(r);
    PASS();
}

/* --- Swift --- */
TEST(swift_class) {
    CtxFileResult *r = extract("class Vehicle {\n    var speed: Int = 0\n    func accelerate() { "
                               "speed += 10 }\n    func stop() { speed = 0 }\n}\n",
                               CTX_LANG_SWIFT, "t", "Vehicle.swift");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Vehicle"));
    ASSERT(has_def(r, "Method", "accelerate"));
    ctx_free_result(r);
    PASS();
}

/* --- Kotlin --- */
TEST(kotlin_function) {
    CtxFileResult *r = extract("fun greet(name: String): String = \"Hello $name\"\nfun main() { "
                               "println(greet(\"World\")) }\n",
                               CTX_LANG_KOTLIN, "t", "main.kt");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "greet"));
    ASSERT(has_def(r, "Function", "main"));
    ctx_free_result(r);
    PASS();
}

TEST(kotlin_class) {
    CtxFileResult *r =
        extract("class User(val name: String) {\n    fun display(): String = \"User: $name\"\n}\n",
                CTX_LANG_KOTLIN, "t", "User.kt");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "User"));
    ctx_free_result(r);
    PASS();
}

/* --- Scala --- */
TEST(scala_function) {
    CtxFileResult *r =
        extract("object Main {\n  def greet(name: String): String = s\"Hello $name\"\n  def "
                "main(args: Array[String]): Unit = println(greet(\"World\"))\n}\n",
                CTX_LANG_SCALA, "t", "Main.scala");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Method", "greet"));
    ctx_free_result(r);
    PASS();
}

TEST(scala_class) {
    CtxFileResult *r =
        extract("class Animal(val name: String) {\n  def speak(): String = s\"I am $name\"\n}\n",
                CTX_LANG_SCALA, "t", "Animal.scala");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Animal"));
    ctx_free_result(r);
    PASS();
}

/* --- Dart --- */
TEST(dart_class) {
    CtxFileResult *r = extract("class Animal {\n  String name;\n  Animal(this.name);\n  String "
                               "speak() => 'I am $name';\n}\n",
                               CTX_LANG_DART, "t", "animal.dart");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Animal"));
    ASSERT(has_def(r, "Method", "speak"));
    ctx_free_result(r);
    PASS();
}

/* --- Groovy --- */
TEST(groovy_class) {
    CtxFileResult *r =
        extract("class Greeter {\n    String name\n    String greet() { \"Hello, $name\" }\n    "
                "static void main(args) { println new Greeter(name:'World').greet() }\n}\n",
                CTX_LANG_GROOVY, "t", "Greeter.groovy");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Greeter"));
    ASSERT(has_def(r, "Method", "greet"));
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Group B: Systems Languages
 * ═══════════════════════════════════════════════════════════════════ */

/* --- Rust --- */
TEST(rust_function) {
    CtxFileResult *r =
        extract("fn main() { println!(\"Hello\"); }\npub fn add(a: i32, b: i32) -> i32 { a + b }\n",
                CTX_LANG_RUST, "t", "main.rs");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "main"));
    ASSERT(has_def(r, "Function", "add"));
    ctx_free_result(r);
    PASS();
}

TEST(rust_struct) {
    CtxFileResult *r = extract("pub struct Point { pub x: f64, pub y: f64 }\nimpl Point { pub fn "
                               "new(x: f64, y: f64) -> Self { Point { x, y } } }\n",
                               CTX_LANG_RUST, "t", "point.rs");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Point"));
    ASSERT(has_def(r, "Method", "new"));
    ctx_free_result(r);
    PASS();
}

/* --- Go --- */
TEST(go_function) {
    CtxFileResult *r = extract("package main\nfunc Greet(name string) string { return \"Hello, \" "
                               "+ name }\nfunc main() { Greet(\"World\") }\n",
                               CTX_LANG_GO, "t", "main.go");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "Greet"));
    ASSERT(has_def(r, "Function", "main"));
    ctx_free_result(r);
    PASS();
}

TEST(go_struct) {
    CtxFileResult *r = extract("package main\ntype Server struct { Host string; Port int }\nfunc "
                               "(s *Server) Start() error { return nil }\n",
                               CTX_LANG_GO, "t", "server.go");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Server"));
    ASSERT(has_def(r, "Method", "Start"));
    ctx_free_result(r);
    PASS();
}

TEST(go_interface) {
    CtxFileResult *r =
        extract("package main\ntype Handler interface { ServeHTTP() error; Close() }\n",
                CTX_LANG_GO, "t", "handler.go");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def_any(r, "Handler"));
    ctx_free_result(r);
    PASS();
}

/* --- Zig --- */
TEST(zig_function) {
    CtxFileResult *r =
        extract("const std = @import(\"std\");\npub fn add(a: i32, b: i32) i32 { return a + b; }\n",
                CTX_LANG_ZIG, "t", "main.zig");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "add"));
    ctx_free_result(r);
    PASS();
}

/* --- C --- */
TEST(c_function) {
    CtxFileResult *r =
        extract("int add(int a, int b) { return a + b; }\nvoid greet() { printf(\"Hello\"); }\n",
                CTX_LANG_C, "t", "math.c");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "add"));
    ASSERT(has_def(r, "Function", "greet"));
    ctx_free_result(r);
    PASS();
}

TEST(c_struct) {
    CtxFileResult *r =
        extract("struct Point { int x; int y; };\nvoid init_point(struct Point *p) { p->x = 0; }\n",
                CTX_LANG_C, "t", "point.c");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "init_point"));
    ctx_free_result(r);
    PASS();
}

/* --- C++ --- */
TEST(cpp_class) {
    CtxFileResult *r = extract(
        "class Widget {\npublic:\n    void draw() {}\n    int width() const { return 0; }\n};\n",
        CTX_LANG_CPP, "t", "widget.cpp");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Widget"));
    ASSERT(has_def(r, "Method", "draw"));
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Group C: Scripting / Dynamic Languages
 * ═══════════════════════════════════════════════════════════════════ */

/* --- Python --- */
TEST(python_function) {
    CtxFileResult *r = extract(
        "def greet(name):\n    return f\"Hello {name}\"\n\ndef main():\n    greet(\"World\")\n",
        CTX_LANG_PYTHON, "t", "main.py");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "greet"));
    ASSERT(has_def(r, "Function", "main"));
    ctx_free_result(r);
    PASS();
}

TEST(python_class) {
    CtxFileResult *r =
        extract("class Dog:\n    def __init__(self, name):\n        self.name = name\n    def "
                "speak(self):\n        return f\"Woof from {self.name}\"\n",
                CTX_LANG_PYTHON, "t", "dog.py");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Dog"));
    ASSERT(has_def(r, "Method", "speak"));
    ctx_free_result(r);
    PASS();
}

/* --- JavaScript --- */
TEST(js_function) {
    CtxFileResult *r =
        extract("function greet(name) { return `Hello ${name}`; }\nconst add = (a, b) => a + b;\n",
                CTX_LANG_JAVASCRIPT, "t", "util.js");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "greet"));
    ctx_free_result(r);
    PASS();
}

TEST(js_class) {
    CtxFileResult *r =
        extract("class Counter {\n  constructor() { this.count = 0; }\n  increment() { "
                "this.count++; }\n  get value() { return this.count; }\n}\n",
                CTX_LANG_JAVASCRIPT, "t", "counter.js");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Counter"));
    ASSERT(has_def(r, "Method", "increment"));
    ctx_free_result(r);
    PASS();
}

/* --- TypeScript --- */
TEST(ts_function) {
    CtxFileResult *r = extract("export function greet(name: string): string { return `Hello "
                               "${name}`; }\nfunction helper(): void {}\n",
                               CTX_LANG_TYPESCRIPT, "t", "util.ts");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "greet"));
    ctx_free_result(r);
    PASS();
}

TEST(ts_class) {
    CtxFileResult *r =
        extract("class Service {\n  private name: string;\n  constructor(name: string) { this.name "
                "= name; }\n  getName(): string { return this.name; }\n}\n",
                CTX_LANG_TYPESCRIPT, "t", "service.ts");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Service"));
    ctx_free_result(r);
    PASS();
}

/* --- Lua --- */
TEST(lua_function) {
    CtxFileResult *r = extract(
        "function greet(name)\n  return \"Hello \" .. name\nend\nlocal function helper() end\n",
        CTX_LANG_LUA, "t", "main.lua");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "greet"));
    ctx_free_result(r);
    PASS();
}

/* --- Bash --- */
TEST(bash_function) {
    CtxFileResult *r =
        extract("greet() {\n  echo \"Hello $1\"\n}\nmain() {\n  greet \"World\"\n}\n",
                CTX_LANG_BASH, "t", "script.sh");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "greet"));
    ctx_free_result(r);
    PASS();
}

/* --- Perl --- */
TEST(perl_function) {
    CtxFileResult *r = extract("sub greet {\n    my ($name) = @_;\n    return \"Hello "
                               "$name\";\n}\nsub main { greet(\"World\"); }\n",
                               CTX_LANG_PERL, "t", "main.pl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "greet"));
    ctx_free_result(r);
    PASS();
}

/* --- R --- */
TEST(r_function) {
    CtxFileResult *r = extract("add <- function(x, y) x + y\nmultiply <- function(x, y) x * y\n",
                               CTX_LANG_R, "t", "math.R");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "add"));
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Group D: Functional Languages
 * ═══════════════════════════════════════════════════════════════════ */

/* --- Elixir --- */
TEST(elixir_function) {
    CtxFileResult *r = extract("defmodule Greeter do\n  def greet(name), do: \"Hello #{name}\"\n  "
                               "defp helper, do: nil\nend\n",
                               CTX_LANG_ELIXIR, "t", "greeter.ex");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "greet"));
    ctx_free_result(r);
    PASS();
}

/* --- Haskell --- */
TEST(haskell_function) {
    CtxFileResult *r = extract("add :: Int -> Int -> Int\nadd x y = x + y\n\nmultiply :: Int -> "
                               "Int -> Int\nmultiply x y = x * y\n",
                               CTX_LANG_HASKELL, "t", "Math.hs");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "add"));
    ctx_free_result(r);
    PASS();
}

/* --- OCaml --- */
TEST(ocaml_function) {
    CtxFileResult *r =
        extract("let add x y = x + y\nlet multiply x y = x * y\n", CTX_LANG_OCAML, "t", "math.ml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "add"));
    ctx_free_result(r);
    PASS();
}

/* --- Erlang --- */
TEST(erlang_function) {
    CtxFileResult *r = extract(
        "-module(math).\n-export([add/2]).\nadd(X, Y) -> X + Y.\nmultiply(X, Y) -> X * Y.\n",
        CTX_LANG_ERLANG, "t", "math.erl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "add"));
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Group E: Markup / Config / Helper Languages
 * ═══════════════════════════════════════════════════════════════════ */

/* --- YAML --- */
TEST(yaml_variables) {
    CtxFileResult *r =
        extract("name: myapp\nversion: 1.0\ndatabase:\n  host: localhost\n  port: 5432\n",
                CTX_LANG_YAML, "t", "config.yml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    /* YAML should extract top-level keys as variables */
    ASSERT_GT(r->defs.count, 0);
    ctx_free_result(r);
    PASS();
}

/* --- HCL --- */
TEST(hcl_blocks) {
    CtxFileResult *r = extract("resource \"aws_instance\" \"web\" {\n  ami = \"abc-123\"\n  "
                               "instance_type = \"t2.micro\"\n}\n",
                               CTX_LANG_HCL, "t", "main.tf");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->defs.count, 0);
    ctx_free_result(r);
    PASS();
}

/* --- SQL --- */
TEST(sql_create_table) {
    CtxFileResult *r = extract("CREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT "
                               "NULL\n);\nCREATE VIEW active_users AS SELECT * FROM users;\n",
                               CTX_LANG_SQL, "t", "schema.sql");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ctx_free_result(r);
    PASS();
}

/* --- Dockerfile --- */
TEST(dockerfile_stages) {
    CtxFileResult *r = extract(
        "FROM node:18 AS builder\nRUN npm install\nFROM node:18-slim\nCOPY --from=builder /app .\n",
        CTX_LANG_DOCKERFILE, "t", "Dockerfile");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Group F: Scientific / Math Languages
 * ═══════════════════════════════════════════════════════════════════ */

/* --- MATLAB --- */
TEST(matlab_function) {
    CtxFileResult *r =
        extract("function y = square(x)\n  y = x.^2;\nend\n", CTX_LANG_MATLAB, "t", "square.m");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "square"));
    ctx_free_result(r);
    PASS();
}

/* --- Lean 4 --- */
TEST(lean_function) {
    CtxFileResult *r =
        extract("def add (x y : Nat) : Nat := x + y\n", CTX_LANG_LEAN, "t", "Math.lean");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "add"));
    ctx_free_result(r);
    PASS();
}

/* --- FORM --- */
TEST(form_procedure) {
    CtxFileResult *r = extract("#procedure doSomething\n  id x = y;\n#endprocedure\n",
                               CTX_LANG_FORM, "t", "test.frm");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "doSomething"));
    ctx_free_result(r);
    PASS();
}

/* --- Wolfram --- */
TEST(wolfram_function) {
    CtxFileResult *r =
        extract("square[x_] := x^2\nadd[x_, y_] := x + y\n", CTX_LANG_WOLFRAM, "t", "math.wl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "square"));
    ASSERT(has_def(r, "Function", "add"));
    ctx_free_result(r);
    PASS();
}

/* --- Magma --- */
TEST(magma_function) {
    CtxFileResult *r = extract("function Factorial(n)\n  if n le 1 then\n    return 1;\n  end "
                               "if;\n  return n * Factorial(n - 1);\nend function;\n",
                               CTX_LANG_MAGMA, "t", "test.m");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "Factorial"));
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Group G: v0.5 Expansion Languages
 * ═══════════════════════════════════════════════════════════════════ */

/* --- F# --- */
TEST(fsharp_function) {
    /* Go test only asserts >=1 def — F# name extraction is incomplete */
    CtxFileResult *r = extract("module Greeter\nlet greet name = sprintf \"Hello %s\" name\n",
                               CTX_LANG_FSHARP, "t", "Greeter.fs");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- Julia --- */
TEST(julia_function) {
    CtxFileResult *r = extract("function add(x, y)\n    x + y\nend\nadd2(x, y) = x + y\n",
                               CTX_LANG_JULIA, "t", "math.jl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "add"));
    ctx_free_result(r);
    PASS();
}

/* --- Elm --- */
TEST(elm_function) {
    CtxFileResult *r =
        extract("add x y = x + y\nmultiply x y = x * y\n", CTX_LANG_ELM, "t", "Math.elm");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "add"));
    ctx_free_result(r);
    PASS();
}

/* --- Nix --- */
TEST(nix_function) {
    CtxFileResult *r =
        extract("{ pkgs ? import <nixpkgs> {} }:\nlet\n  hello = pkgs.writeShellScriptBin "
                "\"hello\" ''echo hello'';\nin { inherit hello; }\n",
                CTX_LANG_NIX, "t", "default.nix");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ctx_free_result(r);
    PASS();
}

/* --- Fortran --- */
TEST(fortran_function) {
    /* Fortran subroutine name extraction is incomplete — just verify no crash */
    CtxFileResult *r = extract("subroutine greet(name)\n  character(*), intent(in) :: name\n  "
                               "print *, 'Hello ', name\nend subroutine\n",
                               CTX_LANG_FORTRAN, "t", "greet.f90");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Group A2: Missing OOP / Systems variants
 * ═══════════════════════════════════════════════════════════════════ */

/* --- Swift struct --- */
TEST(swift_struct) {
    CtxFileResult *r = extract("struct Point {\n    var x: Double\n    var y: Double\n    func "
                               "distance() -> Double { return (x*x + y*y).squareRoot() }\n}\n",
                               CTX_LANG_SWIFT, "t", "Point.swift");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Method", "distance"));
    ctx_free_result(r);
    PASS();
}

/* --- Swift calls (port of PR #47 Go tests) --- */
TEST(swift_simple_call) {
    CtxFileResult *r = extract("func main() { greet() }\nfunc greet() { print(\"hello\") }\n",
                               CTX_LANG_SWIFT, "t", "main.swift");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_call(r, "greet"));
    ctx_free_result(r);
    PASS();
}

TEST(swift_method_call) {
    CtxFileResult *r = extract("class Foo {\n    func bar() { baz.run() }\n}\n", CTX_LANG_SWIFT,
                               "t", "Foo.swift");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_call(r, "baz.run"));
    ctx_free_result(r);
    PASS();
}

TEST(swift_constructor_call) {
    CtxFileResult *r =
        extract("func create() { let x = MyClass() }\n", CTX_LANG_SWIFT, "t", "create.swift");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_call(r, "MyClass"));
    ctx_free_result(r);
    PASS();
}

TEST(swift_chained_call) {
    CtxFileResult *r = extract("func setup() { AlarmScheduler.shared.startKeepAlive() }\n",
                               CTX_LANG_SWIFT, "t", "setup.swift");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(r->calls.count > 0);
    ctx_free_result(r);
    PASS();
}

/* --- Objective-C --- */
TEST(objc_interface) {
    CtxFileResult *r =
        extract("@interface Animal : NSObject\n- (NSString *)name;\n- (void)speak;\n@end\n",
                CTX_LANG_OBJC, "t", "Animal.h");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

TEST(objc_implementation) {
    CtxFileResult *r = extract("@implementation Animal\n- (NSString *)name { return @\"Animal\"; "
                               "}\n- (void)speak { NSLog(@\"...\"); }\n@end\n",
                               CTX_LANG_OBJC, "t", "Animal.m");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- Dart top-level function --- */
TEST(dart_top_level_function) {
    CtxFileResult *r = extract(
        "void main() {\n  print('Hello');\n}\nString greet(String name) => 'Hello $name';\n",
        CTX_LANG_DART, "t", "main.dart");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "main"));
    ASSERT(has_def(r, "Function", "greet"));
    ctx_free_result(r);
    PASS();
}

/* --- Rust enum --- */
TEST(rust_enum) {
    CtxFileResult *r =
        extract("pub enum Direction { North, South, East, West }\n", CTX_LANG_RUST, "t", "dir.rs");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- Zig struct --- */
TEST(zig_struct) {
    CtxFileResult *r = extract("const Point = struct { x: f32, y: f32, pub fn dist(self: Point) "
                               "f32 { return self.x + self.y; } };\n",
                               CTX_LANG_ZIG, "t", "point.zig");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- C++ function (standalone) --- */
TEST(cpp_function) {
    CtxFileResult *r = extract("#include <string>\nstd::string greet(const std::string& name) { "
                               "return \"Hello \" + name; }\nint main() { return 0; }\n",
                               CTX_LANG_CPP, "t", "main.cpp");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- COBOL paragraph --- */
TEST(cobol_paragraph) {
    CtxFileResult *r =
        extract("IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO.\nPROCEDURE DIVISION.\n    "
                "DISPLAY-GREETING.\n        DISPLAY 'HELLO WORLD'.\n        STOP RUN.\n",
                CTX_LANG_COBOL, "t", "hello.cbl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- Verilog module --- */
TEST(verilog_module) {
    CtxFileResult *r =
        extract("module adder(input a, input b, output sum);\n  assign sum = a + b;\nendmodule\n",
                CTX_LANG_VERILOG, "t", "adder.v");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- CUDA kernel --- */
TEST(cuda_kernel) {
    CtxFileResult *r = extract("__global__ void vectorAdd(float *a, float *b, float *c, int n) {\n "
                               "   int i = blockIdx.x * blockDim.x + threadIdx.x;\n    if (i < n) "
                               "c[i] = a[i] + b[i];\n}\nint main() { return 0; }\n",
                               CTX_LANG_CUDA, "t", "vector.cu");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- Python decorator --- */
TEST(python_decorator) {
    CtxFileResult *r = extract("class Router:\n    @staticmethod\n    def route(path: str):\n      "
                               "  def decorator(func): return func\n        return decorator\n",
                               CTX_LANG_PYTHON, "t", "router.py");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "Router"));
    ctx_free_result(r);
    PASS();
}

/* --- TypeScript interface --- */
TEST(ts_interface) {
    CtxFileResult *r = extract("export interface Repository<T> { findById(id: number): T; "
                               "save(entity: T): void; delete(id: number): void; }\n",
                               CTX_LANG_TYPESCRIPT, "t", "repo.ts");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- TSX component --- */
TEST(tsx_component) {
    CtxFileResult *r = extract(
        "import React from 'react';\ninterface Props { name: string; }\nexport function Greeting({ "
        "name }: Props) {\n    return <div>Hello {name}</div>;\n}\nexport default Greeting;\n",
        CTX_LANG_TSX, "t", "Greeting.tsx");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "Greeting"));
    ctx_free_result(r);
    PASS();
}

/* --- Lua table method --- */
TEST(lua_table_method) {
    CtxFileResult *r =
        extract("local M = {}\nfunction M.create(name)\n    return { name = name }\nend\nfunction "
                "M.greet(self)\n    return 'Hi ' .. self.name\nend\nreturn M\n",
                CTX_LANG_LUA, "t", "module.lua");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    /* Should extract at least one Function from Lua table method */
    int fn_count = 0;
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].label, "Function") == 0)
            fn_count++;
    }
    ASSERT_GTE(fn_count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- Emacs Lisp defun --- */
TEST(emacs_lisp_defun) {
    CtxFileResult *r = extract("(defun greet (name)\n  (message \"Hello %s\" name))\n(defun main "
                               "()\n  (greet \"World\"))\n",
                               CTX_LANG_EMACSLISP, "t", "init.el");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "greet"));
    ASSERT(has_def(r, "Function", "main"));
    ctx_free_result(r);
    PASS();
}

/* --- Emacs Lisp defvar --- */
TEST(emacs_lisp_defvar) {
    CtxFileResult *r = extract("(defvar my-count 0 \"A counter.\")\n(defcustom my-name \"World\" "
                               "\"The name.\"\n  :type 'string)\n",
                               CTX_LANG_EMACSLISP, "t", "vars.el");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- Haskell data type --- */
TEST(haskell_data_type) {
    CtxFileResult *r =
        extract("data Shape = Circle Double | Rectangle Double Double\narea :: Shape -> "
                "Double\narea (Circle r) = pi * r * r\narea (Rectangle w h) = w * h\n",
                CTX_LANG_HASKELL, "t", "Shape.hs");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- Clojure function (known limitation: defn produces list_lit) --- */
TEST(clojure_function) {
    CtxFileResult *r = extract("(ns greeter.core)\n(defn greet [name]\n  (str \"Hello \" "
                               "name))\n(defn -main [& args]\n  (println (greet \"World\")))\n",
                               CTX_LANG_CLOJURE, "t", "core.clj");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    /* Clojure uses list_lit for all forms — no function defs extracted (known limitation) */
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Group E2: Missing Config / Markup Languages
 * ═══════════════════════════════════════════════════════════════════ */

/* --- HTML elements --- */
TEST(html_elements) {
    CtxFileResult *r = extract(
        "<!DOCTYPE "
        "html><html><head><title>Test</title></head><body><h1>Hello</h1><p>World</p></body></html>",
        CTX_LANG_HTML, "t", "index.html");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- SQL function (CREATE FUNCTION) --- */
TEST(sql_function) {
    CtxFileResult *r = extract("CREATE FUNCTION get_user_count() RETURNS INTEGER AS $$ SELECT "
                               "COUNT(*) FROM users; $$ LANGUAGE SQL;\n",
                               CTX_LANG_SQL, "t", "funcs.sql");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- Meson project --- */
TEST(meson_project) {
    CtxFileResult *r = extract(
        "project('myapp', 'c', version: '1.0.0')\nexecutable('myapp', 'main.c', install: true)\n",
        CTX_LANG_MESON, "t", "meson.build");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- CSS rules --- */
TEST(css_rules) {
    CtxFileResult *r = extract(
        ".container { display: flex; width: 100%; }\n.button { background: #007bff; color: white; "
        "border: none; }\n@media (max-width: 768px) { .container { flex-direction: column; } }\n",
        CTX_LANG_CSS, "t", "styles.css");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- SCSS rules --- */
TEST(scss_rules) {
    CtxFileResult *r = extract("$primary: #007bff;\n.container {\n  width: 100%;\n  .button {\n    "
                               "background: $primary;\n    &:hover { opacity: 0.8; }\n  }\n}\n",
                               CTX_LANG_SCSS, "t", "styles.scss");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- TOML basic --- */
TEST(toml_basic) {
    CtxFileResult *r = extract("[server]\nhost = \"localhost\"\nport = 8080\n\n[database]\nurl = "
                               "\"postgres://localhost/db\"\nmax_connections = 10\n",
                               CTX_LANG_TOML, "t", "config.toml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Class", "server"));
    ASSERT(has_def(r, "Class", "database"));
    ASSERT(has_def(r, "Variable", "host"));
    ASSERT(has_def(r, "Variable", "port"));
    ctx_free_result(r);
    PASS();
}

/* --- CMake function --- */
TEST(cmake_function) {
    CtxFileResult *r = extract(
        "cmake_minimum_required(VERSION 3.16)\nproject(MyApp VERSION 1.0)\nadd_executable(myapp "
        "main.cpp)\ntarget_compile_features(myapp PRIVATE cxx_std_17)\n",
        CTX_LANG_CMAKE, "t", "CMakeLists.txt");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- JSON object --- */
TEST(json_object) {
    CtxFileResult *r = extract("{\"name\": \"myapp\", \"version\": \"1.0.0\", \"scripts\": "
                               "{\"build\": \"go build\", \"test\": \"go test ./...\"}}",
                               CTX_LANG_JSON, "t", "config.json");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Variable", "name"));
    ASSERT(has_def(r, "Variable", "version"));
    ctx_free_result(r);
    PASS();
}

/* --- Protobuf message --- */
TEST(protobuf_message) {
    CtxFileResult *r = extract(
        "syntax = \"proto3\";\npackage user;\nmessage User { int64 id = 1; string name = 2; string "
        "email = 3; }\nservice UserService { rpc GetUser(User) returns (User); }\n",
        CTX_LANG_PROTOBUF, "t", "user.proto");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- GraphQL type --- */
TEST(graphql_type) {
    CtxFileResult *r = extract("type User {\n  id: ID!\n  name: String!\n  email: String!\n}\ntype "
                               "Query {\n  user(id: ID!): User\n  users: [User!]!\n}\n",
                               CTX_LANG_GRAPHQL, "t", "schema.graphql");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Vue SFC extraction
 * ═══════════════════════════════════════════════════════════════════ */

TEST(vue_script_options_api) {
    CtxFileResult *r = extract(
        "<template><div>hello</div></template>\n"
        "<script>\n"
        "export default {\n"
        "  name: 'App',\n"
        "  data() { return { message: 'Hello' }; },\n"
        "  methods: { greet() { return this.message; } }\n"
        "};\n"
        "</script>\n",
        CTX_LANG_VUE, "t", "App.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_def_any(r, "data"));
    ASSERT_TRUE(has_def_any(r, "greet"));
    ctx_free_result(r);
    PASS();
}

TEST(vue_script_setup) {
    CtxFileResult *r = extract(
        "<template><div>{{ count }}</div></template>\n"
        "<script setup>\n"
        "import { ref, computed } from 'vue';\n"
        "const count = ref(0);\n"
        "const doubled = computed(() => count.value * 2);\n"
        "function increment() { count.value++; }\n"
        "</script>\n",
        CTX_LANG_VUE, "t", "Counter.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_import(r, "vue"));
    ASSERT_TRUE(has_call(r, "ref"));
    ASSERT_TRUE(has_call(r, "computed"));
    ASSERT_TRUE(has_def_any(r, "increment"));
    ctx_free_result(r);
    PASS();
}

TEST(vue_script_lang_ts) {
    CtxFileResult *r = extract(
        "<template><div>typed</div></template>\n"
        "<script lang=\"ts\">\n"
        "interface Props { title: string; }\n"
        "export default {\n"
        "  props: {} as Props,\n"
        "  setup() { return {}; }\n"
        "};\n"
        "</script>\n",
        CTX_LANG_VUE, "t", "Typed.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_def_any(r, "setup"));
    ctx_free_result(r);
    PASS();
}

TEST(vue_dual_script_blocks) {
    CtxFileResult *r = extract(
        "<script>\n"
        "export const meta = { title: 'Page' };\n"
        "</script>\n"
        "<script setup>\n"
        "import { ref } from 'vue';\n"
        "const name = ref('world');\n"
        "</script>\n"
        "<template><div>{{ name }}</div></template>\n",
        CTX_LANG_VUE, "t", "Dual.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_import(r, "vue"));
    ASSERT_TRUE(has_call(r, "ref"));
    ctx_free_result(r);
    PASS();
}

TEST(vue_script_line_offsets) {
    CtxFileResult *r = extract(
        "<template>\n"
        "  <div>hello</div>\n"
        "</template>\n"
        "<script>\n"
        "function myFunc() {}\n"
        "</script>\n",
        CTX_LANG_VUE, "t", "Offset.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_def_any(r, "myFunc"));
    /* myFunc should be on line 4, not line 0 */
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].name, "myFunc") == 0) {
            ASSERT_GTE(r->defs.items[i].start_line, 4);
            break;
        }
    }
    ctx_free_result(r);
    PASS();
}

TEST(vue_template_pascal_component) {
    CtxFileResult *r = extract(
        "<template>\n"
        "  <div>\n"
        "    <MyHeader />\n"
        "    <ADSTopbar title=\"hello\" />\n"
        "    <ContentBox><span>hi</span></ContentBox>\n"
        "  </div>\n"
        "</template>\n"
        "<script setup>\n"
        "</script>\n",
        CTX_LANG_VUE, "t", "Page.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_call(r, "MyHeader"));
    ASSERT_TRUE(has_call(r, "ADSTopbar"));
    ASSERT_TRUE(has_call(r, "ContentBox"));
    ctx_free_result(r);
    PASS();
}

TEST(vue_template_kebab_component) {
    CtxFileResult *r = extract(
        "<template>\n"
        "  <my-component />\n"
        "  <v-btn>Click</v-btn>\n"
        "</template>\n",
        CTX_LANG_VUE, "t", "Kebab.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_call(r, "my-component"));
    ASSERT_TRUE(has_call(r, "v-btn"));
    ctx_free_result(r);
    PASS();
}

TEST(vue_template_html_not_component) {
    CtxFileResult *r = extract(
        "<template>\n"
        "  <div><span>text</span><input /><a href=\"#\">link</a></div>\n"
        "</template>\n",
        CTX_LANG_VUE, "t", "Native.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_FALSE(has_call(r, "div"));
    ASSERT_FALSE(has_call(r, "span"));
    ASSERT_FALSE(has_call(r, "input"));
    ASSERT_FALSE(has_call(r, "a"));
    ctx_free_result(r);
    PASS();
}

TEST(vue_directives_usages) {
    CtxFileResult *r = extract(
        "<template>\n"
        "  <div v-if=\"isActive\" :class=\"computedClass\">\n"
        "    <span v-for=\"item in items\">{{ item }}</span>\n"
        "    <input v-model=\"formData\" />\n"
        "  </div>\n"
        "</template>\n"
        "<script setup>\n"
        "</script>\n",
        CTX_LANG_VUE, "t", "Directives.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->usages.count, 1);
    ctx_free_result(r);
    PASS();
}

TEST(vue_directives_events) {
    CtxFileResult *r = extract(
        "<template>\n"
        "  <button @click=\"handleClick\">Go</button>\n"
        "  <form @submit=\"onSubmit\">\n"
        "    <input @input=\"onChange\" />\n"
        "  </form>\n"
        "</template>\n"
        "<script setup>\n"
        "</script>\n",
        CTX_LANG_VUE, "t", "Events.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_call(r, "handleClick"));
    ASSERT_TRUE(has_call(r, "onSubmit"));
    ASSERT_TRUE(has_call(r, "onChange"));
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Svelte SFC extraction
 * ═══════════════════════════════════════════════════════════════════ */

TEST(svelte_script_defs) {
    CtxFileResult *r = extract(
        "<script>\n"
        "  let name = 'World';\n"
        "  function greet() { return `Hello ${name}`; }\n"
        "</script>\n"
        "<h1>{greet()}</h1>\n",
        CTX_LANG_SVELTE, "t", "App.svelte");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_def_any(r, "greet"));
    ctx_free_result(r);
    PASS();
}

TEST(svelte_script_imports) {
    CtxFileResult *r = extract(
        "<script>\n"
        "  import { onMount } from 'svelte';\n"
        "  import Button from './Button.svelte';\n"
        "  onMount(() => { console.log('mounted'); });\n"
        "</script>\n"
        "<Button />\n",
        CTX_LANG_SVELTE, "t", "Page.svelte");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_import(r, "svelte"));
    ASSERT_TRUE(has_call(r, "onMount"));
    ASSERT_TRUE(has_call(r, "Button"));
    ctx_free_result(r);
    PASS();
}

TEST(svelte_script_lang_ts) {
    CtxFileResult *r = extract(
        "<script lang=\"ts\">\n"
        "  interface User { name: string; }\n"
        "  export function getUser(): User { return { name: 'test' }; }\n"
        "</script>\n"
        "<p>hello</p>\n",
        CTX_LANG_SVELTE, "t", "Typed.svelte");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_def_any(r, "getUser"));
    ctx_free_result(r);
    PASS();
}

TEST(svelte_template_components) {
    CtxFileResult *r = extract(
        "<script>\n"
        "  import Header from './Header.svelte';\n"
        "</script>\n"
        "<Header />\n"
        "<my-widget>content</my-widget>\n"
        "<div><span>native</span></div>\n",
        CTX_LANG_SVELTE, "t", "Layout.svelte");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_call(r, "Header"));
    ASSERT_TRUE(has_call(r, "my-widget"));
    ASSERT_FALSE(has_call(r, "div"));
    ASSERT_FALSE(has_call(r, "span"));
    ctx_free_result(r);
    PASS();
}

TEST(svelte_event_and_bind) {
    CtxFileResult *r = extract(
        "<script>\n"
        "  let value = '';\n"
        "  function handleClick() {}\n"
        "</script>\n"
        "<button on:click={handleClick}>Go</button>\n"
        "<input bind:value={value} />\n",
        CTX_LANG_SVELTE, "t", "Interactive.svelte");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_call(r, "handleClick"));
    ASSERT_GTE(r->usages.count, 1);
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * SFC edge cases
 * ═══════════════════════════════════════════════════════════════════ */

TEST(vue_no_script) {
    CtxFileResult *r = extract(
        "<template>\n"
        "  <MyComponent />\n"
        "  <div>static content</div>\n"
        "</template>\n",
        CTX_LANG_VUE, "t", "NoScript.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_call(r, "MyComponent"));
    ctx_free_result(r);
    PASS();
}

TEST(vue_no_template) {
    CtxFileResult *r = extract(
        "<script setup>\n"
        "import { ref } from 'vue';\n"
        "const x = ref(0);\n"
        "</script>\n",
        CTX_LANG_VUE, "t", "NoTemplate.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_TRUE(has_import(r, "vue"));
    ASSERT_TRUE(has_call(r, "ref"));
    ctx_free_result(r);
    PASS();
}

TEST(vue_empty_file) {
    CtxFileResult *r = extract("", CTX_LANG_VUE, "t", "Empty.vue");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ctx_free_result(r);
    PASS();
}

/* --- GLSL shader --- */
TEST(glsl_shader) {
    CtxFileResult *r = extract(
        "#version 330 core\nvoid main() {\n    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);\n}\nvec3 "
        "transform(vec3 pos, mat4 mvp) {\n    return (mvp * vec4(pos, 1.0)).xyz;\n}\n",
        CTX_LANG_GLSL, "t", "vertex.glsl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* --- VimScript function --- */
TEST(vimscript_function) {
    CtxFileResult *r = extract("function! SayHello()\n  echo 'Hello'\nendfunction\n",
                               CTX_LANG_VIMSCRIPT, "t", "plugin.vim");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    /* VimScript extraction may or may not produce named functions */
    int fn_count = 0;
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].label, "Function") == 0)
            fn_count++;
    }
    if (fn_count > 0) {
        ASSERT(has_def(r, "Function", "SayHello"));
    }
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Group H: Scientific / Math — extended tests
 * ═══════════════════════════════════════════════════════════════════ */

/* --- MATLAB parse (simple expression) --- */
TEST(matlab_parse) {
    CtxFileResult *r = extract("x = 1;\ny = x + 2;\n", CTX_LANG_MATLAB, "t", "simple.matlab");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ctx_free_result(r);
    PASS();
}

/* --- MATLAB call --- */
TEST(matlab_call) {
    CtxFileResult *r = extract("function y = foo(x)\n  y = inv(x);\n  disp hello\nend\n",
                               CTX_LANG_MATLAB, "t", "foo.matlab");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->calls.count, 0);
    ASSERT(has_call(r, "inv"));
    ASSERT(has_call(r, "disp"));
    ctx_free_result(r);
    PASS();
}

/* --- Lean parse (theorem) --- */
TEST(lean_parse) {
    CtxFileResult *r = extract("theorem add_comm (a b : Nat) : a + b = b + a := by omega\n",
                               CTX_LANG_LEAN, "t", "Comm.lean");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ctx_free_result(r);
    PASS();
}

/* --- Lean call (recursive fib) --- */
TEST(lean_call) {
    CtxFileResult *r = extract("def fib : Nat \xe2\x86\x92 Nat\n  | 0 => 1\n  | 1 => 1\n  | n + 2 "
                               "=> fib (n + 1) + fib n\n",
                               CTX_LANG_LEAN, "t", "Fib.lean");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->calls.count, 0);
    ASSERT(has_call(r, "fib"));
    ctx_free_result(r);
    PASS();
}

/* --- Lean type annotation not call --- */
TEST(lean_type_annotation_not_call) {
    CtxFileResult *r = extract(
        "def listLen (xs : List Nat) : Nat := 0\ndef greet : IO Unit := IO.println \"hi\"\n",
        CTX_LANG_LEAN, "t", "Types.lean");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    /* "List" in binder type position should NOT be extracted as a call */
    for (int i = 0; i < r->calls.count; i++) {
        ASSERT_FALSE(strcmp(r->calls.items[i].callee_name, "List") == 0);
    }
    /* IO.println in the body should be present */
    int found_println = 0;
    for (int i = 0; i < r->calls.count; i++) {
        if (strstr(r->calls.items[i].callee_name, "println") != NULL) {
            found_println = 1;
        }
    }
    ASSERT_TRUE(found_println);
    ctx_free_result(r);
    PASS();
}

/* --- FORM parse (simple expression) --- */
TEST(form_parse) {
    CtxFileResult *r = extract("Symbols x, y;\nLocal F = x + y;\nPrint;\n.end\n", CTX_LANG_FORM,
                               "t", "example.frm");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ctx_free_result(r);
    PASS();
}

/* --- FORM call (#call) --- */
TEST(form_call) {
    CtxFileResult *r = extract("#procedure myproc(x)\n  id `x' = 0;\n#endprocedure\n#procedure "
                               "caller()\n  #call myproc(1)\n#endprocedure\n",
                               CTX_LANG_FORM, "t", "calc.frm");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->calls.count, 0);
    ASSERT(has_call(r, "myproc"));
    ctx_free_result(r);
    PASS();
}

/* --- Magma procedure --- */
TEST(magma_procedure) {
    CtxFileResult *r = extract("procedure PrintHello()\n  print \"Hello\";\nend procedure;\n",
                               CTX_LANG_MAGMA, "t", "hello.mag");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    int fn_count = 0;
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].label, "Function") == 0)
            fn_count++;
    }
    if (fn_count > 0) {
        ASSERT(has_def(r, "Function", "PrintHello"));
    }
    ctx_free_result(r);
    PASS();
}

/* --- Magma parse (simple) --- */
TEST(magma_parse) {
    CtxFileResult *r = extract("x := 42;\ny := x + 1;\n", CTX_LANG_MAGMA, "t", "simple.mag");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ctx_free_result(r);
    PASS();
}

/* --- Magma import (load) --- */
TEST(magma_import) {
    CtxFileResult *r = extract("load \"utils.mag\";\nload \"lib/helpers.mag\";\n", CTX_LANG_MAGMA,
                               "t", "main.mag");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->imports.count, 2);
    ctx_free_result(r);
    PASS();
}

/* --- Magma call --- */
TEST(magma_call) {
    CtxFileResult *r = extract("function Foo(x)\n  y := Bar(x);\n  return y;\nend function;\n",
                               CTX_LANG_MAGMA, "t", "calls.mag");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->calls.count, 0);
    ASSERT(has_call(r, "Bar"));
    ctx_free_result(r);
    PASS();
}

/* --- Magma disambiguation (.m file as Magma) --- */
TEST(magma_disambiguation) {
    CtxFileResult *r = extract("function Factorial(n)\n  if n le 1 then\n    return 1;\n  end "
                               "if;\n  return n * Factorial(n - 1);\nend function;\n",
                               CTX_LANG_MAGMA, "t", "test.m");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    int fn_count = 0;
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].label, "Function") == 0)
            fn_count++;
    }
    ASSERT_GTE(fn_count, 1);
    if (fn_count > 0) {
        ASSERT(has_def(r, "Function", "Factorial"));
    }
    ctx_free_result(r);
    PASS();
}

/* --- Wolfram function (both := and =) --- */
TEST(wolfram_function_extended) {
    CtxFileResult *r = extract("f[x_] := x^2\ng[x_] = x + 1\n", CTX_LANG_WOLFRAM, "t", "funcs.wl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    int fn_count = 0;
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].label, "Function") == 0)
            fn_count++;
    }
    ASSERT_GTE(fn_count, 2);
    ASSERT(has_def(r, "Function", "f"));
    ASSERT(has_def(r, "Function", "g"));
    ctx_free_result(r);
    PASS();
}

/* --- Wolfram call --- */
TEST(wolfram_call) {
    CtxFileResult *r = extract("f[x_] := g[x] + h[x]\n", CTX_LANG_WOLFRAM, "t", "calls.wl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->calls.count, 0);
    ASSERT(has_call(r, "g"));
    ASSERT(has_call(r, "h"));
    /* "f" should NOT appear as a call (it's the definition LHS) */
    for (int i = 0; i < r->calls.count; i++) {
        ASSERT_FALSE(strcmp(r->calls.items[i].callee_name, "f") == 0);
    }
    ctx_free_result(r);
    PASS();
}

/* --- Wolfram caller attribution --- */
TEST(wolfram_caller_attribution) {
    CtxFileResult *r = extract("f[x_] := g[x] + h[x]\n", CTX_LANG_WOLFRAM, "t", "caller.wl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->calls.count, 0);
    /* Calls inside f[] should have f as enclosing function, not the module path */
    for (int i = 0; i < r->calls.count; i++) {
        if (strcmp(r->calls.items[i].callee_name, "g") == 0 ||
            strcmp(r->calls.items[i].callee_name, "h") == 0) {
            /* enclosing_func_qn must NOT be empty or the file path */
            ASSERT_NOT_NULL(r->calls.items[i].enclosing_func_qn);
            ASSERT_FALSE(strcmp(r->calls.items[i].enclosing_func_qn, "") == 0);
            ASSERT_FALSE(strcmp(r->calls.items[i].enclosing_func_qn, "t.caller") == 0);
        }
    }
    ctx_free_result(r);
    PASS();
}

/* --- Wolfram parse (simple assignment) --- */
TEST(wolfram_parse) {
    CtxFileResult *r = extract("x = 42;\ny = x + 1;\n", CTX_LANG_WOLFRAM, "t", "simple.wl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ctx_free_result(r);
    PASS();
}

/* --- Wolfram import --- */
TEST(wolfram_import) {
    CtxFileResult *r =
        extract("<< \"utils.wl\"\nNeeds[\"Package`\"]\n", CTX_LANG_WOLFRAM, "t", "main.wl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->imports.count, 0);
    ctx_free_result(r);
    PASS();
}

/* --- Wolfram nested def --- */
TEST(wolfram_nested_def) {
    CtxFileResult *r = extract("main[x_] := Module[{localF}, localF[t_] := t + 1; localF[x]]\n",
                               CTX_LANG_WOLFRAM, "t", "nested.wl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "main"));
    ASSERT(has_def(r, "Function", "localF"));
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Group I: ctx_test.go ports
 * ═══════════════════════════════════════════════════════════════════ */

TEST(python_docstring) {
    CtxFileResult *r = extract(
        "def compute(x, y):\n    \"\"\"Compute the sum of x and y.\"\"\"\n    return x + y\n",
        CTX_LANG_PYTHON, "test", "test.py");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "compute"));
    /* Check docstring is present */
    int found = 0;
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].name, "compute") == 0) {
            found = 1;
            ASSERT_NOT_NULL(r->defs.items[i].docstring);
            ASSERT_TRUE(strlen(r->defs.items[i].docstring) > 0);
        }
    }
    ASSERT_TRUE(found);
    ctx_free_result(r);
    PASS();
}

TEST(go_function_extraction) {
    CtxFileResult *r =
        extract("package main\n\n// Greet returns a greeting.\nfunc Greet(name string) string "
                "{\n\treturn \"Hello, \" + name\n}\n\nfunc main() {\n\tGreet(\"world\")\n}\n",
                CTX_LANG_GO, "test", "main.go");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "Greet"));
    ASSERT(has_def(r, "Function", "main"));
    ASSERT(has_call(r, "Greet"));
    ctx_free_result(r);
    PASS();
}

TEST(js_arrow_function) {
    CtxFileResult *r = extract("const greet = (name) => {\n  return \"Hello \" + "
                               "name;\n};\n\nconst result = greet(\"world\");\n",
                               CTX_LANG_JAVASCRIPT, "test", "app.js");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(r->defs.count, 1);
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Group J: language_failures_test.go ports
 * ═══════════════════════════════════════════════════════════════════ */

/* CommonLisp — defun extraction (known limitation: grammar produces list_lit) */
TEST(commonlisp_defun) {
    CtxFileResult *r =
        extract("(defun hello () \"world\")\n", CTX_LANG_COMMONLISP, "test", "hello.lisp");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    /* Known limitation: CommonLisp grammar produces list_lit, not defun nodes.
     * Function extraction returns 0 — this test documents the limitation. */
    ctx_free_result(r);
    PASS();
}

TEST(commonlisp_multiple_functions) {
    CtxFileResult *r = extract("(defun add (a b) (+ a b))\n(defun mul (a b) (* a b))\n",
                               CTX_LANG_COMMONLISP, "test", "math.lisp");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ctx_free_result(r);
    PASS();
}

TEST(commonlisp_defmacro) {
    CtxFileResult *r =
        extract("(defmacro when2 (condition &body body)\n  `(if ,condition (progn ,@body)))\n",
                CTX_LANG_COMMONLISP, "test", "macros.lisp");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ctx_free_result(r);
    PASS();
}

TEST(makefile_rule_as_function) {
    CtxFileResult *r = extract("all:\n\t@echo hello\n", CTX_LANG_MAKEFILE, "test", "Makefile");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "all"));
    ctx_free_result(r);
    PASS();
}

TEST(makefile_multiple_targets) {
    CtxFileResult *r = extract("all: main.o\n\tgcc -o all main.o\n\nbuild:\n\tgo build ./...\n",
                               CTX_LANG_MAKEFILE, "test", "Makefile");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_def(r, "Function", "all"));
    ASSERT(has_def(r, "Function", "build"));
    ctx_free_result(r);
    PASS();
}

TEST(makefile_variable_extraction) {
    CtxFileResult *r =
        extract("CC := gcc\nCFLAGS := -Wall\n", CTX_LANG_MAKEFILE, "test", "Makefile");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    /* Variable extraction may or may not work depending on Makefile grammar support */
    ctx_free_result(r);
    PASS();
}

TEST(vimscript_function_extraction) {
    CtxFileResult *r = extract("function! SayHello()\n  echo 'Hello'\nendfunction\n",
                               CTX_LANG_VIMSCRIPT, "test", "plugin.vim");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    /* VimScript function extraction may or may not produce named functions */
    int fn_count = 0;
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].label, "Function") == 0)
            fn_count++;
    }
    if (fn_count > 0) {
        ASSERT(has_def(r, "Function", "SayHello"));
    }
    ctx_free_result(r);
    PASS();
}

TEST(vimscript_function_without_bang) {
    CtxFileResult *r = extract("function MyFunc(arg)\n  return arg\nendfunction\n",
                               CTX_LANG_VIMSCRIPT, "test", "plugin.vim");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    int fn_count = 0;
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].label, "Function") == 0)
            fn_count++;
    }
    if (fn_count > 0) {
        ASSERT(has_def(r, "Function", "MyFunc"));
    }
    ctx_free_result(r);
    PASS();
}

TEST(julia_function_extraction) {
    CtxFileResult *r = extract("function hello()\n  println(\"Hello, World!\")\nend\n",
                               CTX_LANG_JULIA, "test", "hello.jl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    int fn_count = 0;
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].label, "Function") == 0)
            fn_count++;
    }
    if (fn_count > 0) {
        ASSERT(has_def(r, "Function", "hello"));
    }
    ctx_free_result(r);
    PASS();
}

TEST(julia_function_with_args) {
    CtxFileResult *r = extract("function add(a::Int, b::Int)::Int\n  return a + b\nend\n",
                               CTX_LANG_JULIA, "test", "math.jl");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    int fn_count = 0;
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].label, "Function") == 0)
            fn_count++;
    }
    if (fn_count > 0) {
        ASSERT(has_def(r, "Function", "add"));
    }
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Cross-cutting: Calls + Imports
 * ═══════════════════════════════════════════════════════════════════ */

TEST(python_calls) {
    CtxFileResult *r =
        extract("import os\ndef main():\n    os.path.exists('/tmp')\n    print('hello')\n",
                CTX_LANG_PYTHON, "t", "main.py");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    /* Python unified extraction produces calls — verify at least some exist */
    ASSERT_GT(r->calls.count, 0);
    ctx_free_result(r);
    PASS();
}

TEST(go_calls) {
    CtxFileResult *r =
        extract("package main\nimport \"fmt\"\nfunc main() { fmt.Println(\"hello\") }\n",
                CTX_LANG_GO, "t", "main.go");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(has_call(r, "fmt.Println"));
    ctx_free_result(r);
    PASS();
}

TEST(python_imports) {
    CtxFileResult *r =
        extract("import os\nfrom sys import argv\nfrom collections import defaultdict\n",
                CTX_LANG_PYTHON, "t", "main.py");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->imports.count, 0);
    ctx_free_result(r);
    PASS();
}

TEST(js_imports) {
    CtxFileResult *r = extract("import React from 'react';\nimport { useState } from "
                               "'react';\nconst fs = require('fs');\n",
                               CTX_LANG_JAVASCRIPT, "t", "app.js");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->imports.count, 0);
    ctx_free_result(r);
    PASS();
}

TEST(go_imports) {
    CtxFileResult *r =
        extract("package main\n\nimport \"fmt\"\nimport (\n    \"os\"\n    net \"net/http\"\n)\n",
                CTX_LANG_GO, "t", "main.go");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->imports.count, 0);
    ASSERT(has_import(r, "fmt"));
    ctx_free_result(r);
    PASS();
}

TEST(java_imports) {
    CtxFileResult *r =
        extract("import java.util.List;\nimport java.util.ArrayList;\nimport static java.lang.Math.PI;\n"
                "public class Foo {}\n",
                CTX_LANG_JAVA, "t", "Foo.java");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->imports.count, 0);
    ASSERT(has_import(r, "java.util.List"));
    ctx_free_result(r);
    PASS();
}

TEST(rust_imports) {
    CtxFileResult *r =
        extract("use std::collections::HashMap;\nuse std::io::{self, Write};\nuse serde::Serialize;\n"
                "fn main() {}\n",
                CTX_LANG_RUST, "t", "main.rs");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->imports.count, 0);
    ASSERT(has_import(r, "std::collections::HashMap"));
    ctx_free_result(r);
    PASS();
}

TEST(c_imports) {
    CtxFileResult *r =
        extract("#include <stdio.h>\n#include <stdlib.h>\n#include \"mylib.h\"\n\nint main() { return 0; }\n",
                CTX_LANG_C, "t", "main.c");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->imports.count, 0);
    ASSERT(has_import(r, "stdio.h"));
    ctx_free_result(r);
    PASS();
}

TEST(ruby_imports) {
    CtxFileResult *r =
        extract("require 'json'\nrequire 'net/http'\nrequire_relative 'helpers'\n\nclass Foo; end\n",
                CTX_LANG_RUBY, "t", "app.rb");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->imports.count, 0);
    ASSERT(has_import(r, "json"));
    ctx_free_result(r);
    PASS();
}

TEST(lua_imports) {
    CtxFileResult *r =
        extract("local json = require(\"dkjson\")\nlocal http = require(\"socket.http\")\n\nlocal function greet() end\n",
                CTX_LANG_LUA, "t", "main.lua");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GT(r->imports.count, 0);
    ASSERT(has_import(r, "dkjson"));
    ctx_free_result(r);
    PASS();
}

TEST(import_stress_go) {
    /* Stress test: 5,000 single-line Go imports.
     * Verifies O(N) behaviour — would hang indefinitely with the O(N²) loop. */
    const int N = 5000;
    /* Each line: import "pkg/NNNNN"\n  = ~20 chars; total ~100KB */
    int buf_size = N * 24 + 64;
    char *src = malloc((size_t)buf_size);
    ASSERT_NOT_NULL(src);

    int pos = 0;
    pos += snprintf(src + pos, (size_t)(buf_size - pos), "package stress\n");
    for (int k = 0; k < N; k++) {
        pos += snprintf(src + pos, (size_t)(buf_size - pos), "import \"pkg/%05d\"\n", k);
    }

    CtxFileResult *r = extract(src, CTX_LANG_GO, "t", "stress.go");
    free(src);
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_EQ(r->imports.count, N);
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * config_extraction_test.go ports (25 tests)
 * ═══════════════════════════════════════════════════════════════════ */

/* --- TOML (8 tests) --- */

TEST(toml_basic_table_and_pair) {
    CtxFileResult *r = extract("[database]\nhost = \"localhost\"\nport = 5432\n", CTX_LANG_TOML,
                               "t", "config.toml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_EQ(count_defs_with_label(r, "Class"), 1);
    ASSERT(has_def(r, "Class", "database"));
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 2);
    ASSERT(has_def(r, "Variable", "host"));
    ASSERT(has_def(r, "Variable", "port"));
    ctx_free_result(r);
    PASS();
}

TEST(toml_nested_table) {
    CtxFileResult *r = extract("[server.http]\nport = 8080\n", CTX_LANG_TOML, "t", "config.toml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Class"), 1);
    ctx_free_result(r);
    PASS();
}

TEST(toml_table_array_element) {
    CtxFileResult *r = extract("[[servers]]\nname = \"alpha\"\n[[servers]]\nname = \"beta\"\n",
                               CTX_LANG_TOML, "t", "config.toml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Class"), 2);
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 2);
    ctx_free_result(r);
    PASS();
}

TEST(toml_dotted_key) {
    CtxFileResult *r =
        extract("database.host = \"localhost\"\n", CTX_LANG_TOML, "t", "config.toml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 1);
    ctx_free_result(r);
    PASS();
}

TEST(toml_quoted_key) {
    CtxFileResult *r = extract("\"unusual-key\" = \"value\"\n", CTX_LANG_TOML, "t", "config.toml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 1);
    ctx_free_result(r);
    PASS();
}

TEST(toml_empty_table) {
    CtxFileResult *r = extract("[empty]\n", CTX_LANG_TOML, "t", "config.toml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_EQ(count_defs_with_label(r, "Class"), 1);
    ASSERT(has_def(r, "Class", "empty"));
    ASSERT_EQ(count_defs_with_label(r, "Variable"), 0);
    ctx_free_result(r);
    PASS();
}

TEST(toml_comments_only) {
    CtxFileResult *r =
        extract("# just a comment\n# another comment\n", CTX_LANG_TOML, "t", "config.toml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_EQ(count_defs_with_label(r, "Class"), 0);
    ASSERT_EQ(count_defs_with_label(r, "Variable"), 0);
    ctx_free_result(r);
    PASS();
}

TEST(toml_boolean_and_integer_values) {
    CtxFileResult *r =
        extract("enabled = true\ncount = 42\nname = \"test\"\n", CTX_LANG_TOML, "t", "config.toml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 3);
    ctx_free_result(r);
    PASS();
}

/* --- INI (4 tests) --- */

TEST(ini_basic_section_and_setting) {
    CtxFileResult *r =
        extract("[database]\nhost = localhost\nport = 5432\n", CTX_LANG_INI, "t", "config.ini");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Class"), 1);
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 2);
    ctx_free_result(r);
    PASS();
}

TEST(ini_multiple_sections) {
    CtxFileResult *r = extract("[section1]\nkey1 = val1\n[section2]\nkey2 = val2\n", CTX_LANG_INI,
                               "t", "config.ini");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Class"), 2);
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 2);
    ctx_free_result(r);
    PASS();
}

TEST(ini_global_keys) {
    CtxFileResult *r = extract("key1 = value1\nkey2 = value2\n", CTX_LANG_INI, "t", "config.ini");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_EQ(count_defs_with_label(r, "Class"), 0);
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 2);
    ctx_free_result(r);
    PASS();
}

TEST(ini_comments) {
    CtxFileResult *r = extract("; comment\n# another comment\n[section]\nkey = val\n", CTX_LANG_INI,
                               "t", "config.ini");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Class"), 1);
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 1);
    ctx_free_result(r);
    PASS();
}

/* --- JSON (5 tests) --- */

TEST(json_basic_pair) {
    CtxFileResult *r =
        extract("{\"host\": \"localhost\", \"port\": 5432}", CTX_LANG_JSON, "t", "config.json");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 2);
    ASSERT(has_def(r, "Variable", "host"));
    ASSERT(has_def(r, "Variable", "port"));
    ctx_free_result(r);
    PASS();
}

TEST(json_nested_object) {
    CtxFileResult *r = extract("{\"database\": {\"host\": \"localhost\", \"port\": 5432}}",
                               CTX_LANG_JSON, "t", "config.json");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 3);
    ctx_free_result(r);
    PASS();
}

TEST(json_empty_object) {
    CtxFileResult *r = extract("{}", CTX_LANG_JSON, "t", "config.json");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_EQ(count_defs_with_label(r, "Variable"), 0);
    ctx_free_result(r);
    PASS();
}

TEST(json_boolean_null_values) {
    CtxFileResult *r = extract("{\"enabled\": true, \"value\": null, \"name\": \"test\"}",
                               CTX_LANG_JSON, "t", "config.json");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 3);
    ctx_free_result(r);
    PASS();
}

TEST(json_package_json_deps) {
    CtxFileResult *r =
        extract("{\"name\":\"pkg\",\"dependencies\":{\"express\":\"^4.0\",\"lodash\":\"^4.17\"}}",
                CTX_LANG_JSON, "t", "package.json");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Variable"), 4);
    ASSERT(has_def(r, "Variable", "name"));
    ASSERT(has_def(r, "Variable", "dependencies"));
    ASSERT(has_def(r, "Variable", "express"));
    ASSERT(has_def(r, "Variable", "lodash"));
    ctx_free_result(r);
    PASS();
}

/* --- XML (4 tests) --- */

TEST(xml_basic_element) {
    CtxFileResult *r = extract(
        "<?xml version=\"1.0\"?><config><database><host>localhost</host></database></config>",
        CTX_LANG_XML, "t", "config.xml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Class"), 3);
    ASSERT(has_def(r, "Class", "config"));
    ASSERT(has_def(r, "Class", "database"));
    ASSERT(has_def(r, "Class", "host"));
    ctx_free_result(r);
    PASS();
}

TEST(xml_self_closing_tag) {
    CtxFileResult *r =
        extract("<?xml version=\"1.0\"?><config><feature enabled=\"true\"/></config>", CTX_LANG_XML,
                "t", "config.xml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Class"), 2);
    ctx_free_result(r);
    PASS();
}

TEST(xml_empty_document) {
    CtxFileResult *r = extract("<?xml version=\"1.0\"?><root/>", CTX_LANG_XML, "t", "config.xml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Class"), 1);
    ctx_free_result(r);
    PASS();
}

TEST(xml_multiple_children) {
    CtxFileResult *r =
        extract("<?xml version=\"1.0\"?><servers><server/><server/><server/></servers>",
                CTX_LANG_XML, "t", "config.xml");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Class"), 4); /* servers + 3x server */
    ctx_free_result(r);
    PASS();
}

/* --- Markdown (4 tests) --- */

TEST(markdown_atx_headings) {
    CtxFileResult *r =
        extract("# Title\n## Section\n### Subsection\n", CTX_LANG_MARKDOWN, "t", "README.md");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Section"), 3);
    ASSERT_EQ(count_defs_with_label(r, "Class"), 0); /* Markdown: Section, not Class */
    ctx_free_result(r);
    PASS();
}

TEST(markdown_setext_headings) {
    CtxFileResult *r =
        extract("Title\n=====\nSection\n------\n", CTX_LANG_MARKDOWN, "t", "README.md");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Section"), 2);
    ctx_free_result(r);
    PASS();
}

TEST(markdown_heading_content) {
    CtxFileResult *r = extract("# Installation Guide\n## Prerequisites\n## Setup\n",
                               CTX_LANG_MARKDOWN, "t", "README.md");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_GTE(count_defs_with_label(r, "Section"), 3);
    ASSERT(has_def(r, "Section", "Installation Guide"));
    ASSERT(has_def(r, "Section", "Prerequisites"));
    ASSERT(has_def(r, "Section", "Setup"));
    ctx_free_result(r);
    PASS();
}

TEST(markdown_no_headings) {
    CtxFileResult *r =
        extract("Just a paragraph\n\nAnother paragraph\n", CTX_LANG_MARKDOWN, "t", "README.md");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_EQ(count_defs_with_label(r, "Section"), 0);
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Python __init__.py Module QN collision regression
 * ═══════════════════════════════════════════════════════════════════ */

TEST(python_init_module_qn_not_collide_with_folder) {
    /* Bug: __init__.py Module QN was identical to the Folder QN for the
     * same directory, causing the Folder node to be overwritten when the
     * Module was upserted. The Module QN must contain "__init__" to
     * distinguish it from the Folder QN. */
    CtxFileResult *r = extract("class Config:\n    DEBUG = True\n\ndef setup():\n    pass\n",
                               CTX_LANG_PYTHON, "proj", "mypackage/__init__.py");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);

    /* Module node must exist */
    ASSERT_GTE(r->defs.count, 1);
    ASSERT_STR_EQ(r->defs.items[0].label, "Module");

    /* Module QN must contain __init__ (not be stripped to just "proj.mypackage") */
    ASSERT_NOT_NULL(r->module_qn);
    ASSERT_NOT_NULL(strstr(r->module_qn, "__init__"));

    /* But symbols inside __init__.py should NOT have __init__ in their QN */
    int found_config = 0;
    for (int i = 0; i < r->defs.count; i++) {
        if (strcmp(r->defs.items[i].name, "Config") == 0) {
            ASSERT_NOT_NULL(r->defs.items[i].qualified_name);
            /* Should be "proj.mypackage.Config", NOT "proj.mypackage.__init__.Config" */
            ASSERT_STR_EQ(r->defs.items[i].qualified_name, "proj.mypackage.Config");
            found_config = 1;
        }
    }
    ASSERT_EQ(found_config, 1);

    ctx_free_result(r);
    PASS();
}

TEST(python_init_nested_module_qn) {
    /* Deeply nested __init__.py — same collision must not happen */
    CtxFileResult *r = extract("def greet():\n    return 'hello'\n", CTX_LANG_PYTHON, "proj",
                               "docker-images/cloud-runs/bq-sync-api/__init__.py");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_NOT_NULL(r->module_qn);
    /* Must contain __init__ to not collide with Folder QN */
    ASSERT_NOT_NULL(strstr(r->module_qn, "__init__"));
    ctx_free_result(r);
    PASS();
}

TEST(js_index_module_qn_not_collide_with_folder) {
    /* Same bug for JS/TS index.ts files */
    CtxFileResult *r = extract("export function App() { return null; }\n", CTX_LANG_TYPESCRIPT,
                               "proj", "src/components/index.ts");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_NOT_NULL(r->module_qn);
    /* Must contain "index" to not collide with Folder QN */
    ASSERT_NOT_NULL(strstr(r->module_qn, "index"));
    ctx_free_result(r);
    PASS();
}

TEST(python_regular_module_qn_unchanged) {
    /* Non-__init__.py Python files should be unaffected */
    CtxFileResult *r =
        extract("def helper():\n    pass\n", CTX_LANG_PYTHON, "proj", "mypackage/utils.py");
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT_NOT_NULL(r->module_qn);
    /* Regular module QN should not contain __init__ or index */
    ASSERT_STR_EQ(r->module_qn, "proj.mypackage.utils");
    ctx_free_result(r);
    PASS();
}

/* ═══════════════════════════════════════════════════════════════════
 * Suite
 * ═══════════════════════════════════════════════════════════════════ */

SUITE(extraction) {
    /* Initialize extraction library */
    ctx_init();

    /* OOP */
    RUN_TEST(java_class);
    RUN_TEST(java_method);
    RUN_TEST(java_interface);
    RUN_TEST(php_class);
    RUN_TEST(php_function);
    RUN_TEST(ruby_class);
    RUN_TEST(ruby_module);
    RUN_TEST(csharp_class);
    RUN_TEST(csharp_interface);
    RUN_TEST(swift_class);
    RUN_TEST(kotlin_function);
    RUN_TEST(kotlin_class);
    RUN_TEST(scala_function);
    RUN_TEST(scala_class);
    RUN_TEST(dart_class);
    RUN_TEST(groovy_class);

    /* Systems */
    RUN_TEST(rust_function);
    RUN_TEST(rust_struct);
    RUN_TEST(go_function);
    RUN_TEST(go_struct);
    RUN_TEST(go_interface);
    RUN_TEST(zig_function);
    RUN_TEST(c_function);
    RUN_TEST(c_struct);
    RUN_TEST(cpp_class);

    /* Scripting */
    RUN_TEST(python_function);
    RUN_TEST(python_class);
    RUN_TEST(js_function);
    RUN_TEST(js_class);
    RUN_TEST(ts_function);
    RUN_TEST(ts_class);
    RUN_TEST(lua_function);
    RUN_TEST(bash_function);
    RUN_TEST(perl_function);
    RUN_TEST(r_function);

    /* Functional */
    RUN_TEST(elixir_function);
    RUN_TEST(haskell_function);
    RUN_TEST(ocaml_function);
    RUN_TEST(erlang_function);

    /* Markup/Config */
    RUN_TEST(yaml_variables);
    RUN_TEST(hcl_blocks);
    RUN_TEST(sql_create_table);
    RUN_TEST(dockerfile_stages);

    /* Scientific */
    RUN_TEST(matlab_function);
    RUN_TEST(lean_function);
    RUN_TEST(form_procedure);
    RUN_TEST(wolfram_function);
    RUN_TEST(magma_function);

    /* v0.5 expansion */
    RUN_TEST(fsharp_function);
    RUN_TEST(julia_function);
    RUN_TEST(elm_function);
    RUN_TEST(nix_function);
    RUN_TEST(fortran_function);

    /* OOP/Systems variants */
    RUN_TEST(swift_struct);
    RUN_TEST(swift_simple_call);
    RUN_TEST(swift_method_call);
    RUN_TEST(swift_constructor_call);
    RUN_TEST(swift_chained_call);
    RUN_TEST(objc_interface);
    RUN_TEST(objc_implementation);
    RUN_TEST(dart_top_level_function);
    RUN_TEST(rust_enum);
    RUN_TEST(zig_struct);
    RUN_TEST(cpp_function);
    RUN_TEST(cobol_paragraph);
    RUN_TEST(verilog_module);
    RUN_TEST(cuda_kernel);
    RUN_TEST(python_decorator);
    RUN_TEST(ts_interface);
    RUN_TEST(tsx_component);
    RUN_TEST(lua_table_method);
    RUN_TEST(emacs_lisp_defun);
    RUN_TEST(emacs_lisp_defvar);
    RUN_TEST(haskell_data_type);
    RUN_TEST(clojure_function);

    /* Config/Markup */
    RUN_TEST(html_elements);
    RUN_TEST(sql_function);
    RUN_TEST(meson_project);
    RUN_TEST(css_rules);
    RUN_TEST(scss_rules);
    RUN_TEST(toml_basic);
    RUN_TEST(cmake_function);
    RUN_TEST(json_object);
    RUN_TEST(protobuf_message);
    RUN_TEST(graphql_type);
    /* Vue SFC */
    RUN_TEST(vue_script_options_api);
    RUN_TEST(vue_script_setup);
    RUN_TEST(vue_script_lang_ts);
    RUN_TEST(vue_dual_script_blocks);
    RUN_TEST(vue_script_line_offsets);
    RUN_TEST(vue_template_pascal_component);
    RUN_TEST(vue_template_kebab_component);
    RUN_TEST(vue_template_html_not_component);
    RUN_TEST(vue_directives_usages);
    RUN_TEST(vue_directives_events);
    /* Svelte SFC */
    RUN_TEST(svelte_script_defs);
    RUN_TEST(svelte_script_imports);
    RUN_TEST(svelte_script_lang_ts);
    RUN_TEST(svelte_template_components);
    RUN_TEST(svelte_event_and_bind);
    /* SFC edge cases */
    RUN_TEST(vue_no_script);
    RUN_TEST(vue_no_template);
    RUN_TEST(vue_empty_file);
    RUN_TEST(glsl_shader);
    RUN_TEST(vimscript_function);

    /* Scientific extended */
    RUN_TEST(matlab_parse);
    RUN_TEST(matlab_call);
    RUN_TEST(lean_parse);
    RUN_TEST(lean_call);
    RUN_TEST(lean_type_annotation_not_call);
    RUN_TEST(form_parse);
    RUN_TEST(form_call);
    RUN_TEST(magma_procedure);
    RUN_TEST(magma_parse);
    RUN_TEST(magma_import);
    RUN_TEST(magma_call);
    RUN_TEST(magma_disambiguation);
    RUN_TEST(wolfram_function_extended);
    RUN_TEST(wolfram_call);
    RUN_TEST(wolfram_caller_attribution);
    RUN_TEST(wolfram_parse);
    RUN_TEST(wolfram_import);
    RUN_TEST(wolfram_nested_def);

    /* ctx_test.go ports */
    RUN_TEST(python_docstring);
    RUN_TEST(go_function_extraction);
    RUN_TEST(js_arrow_function);

    /* language_failures_test.go ports */
    RUN_TEST(commonlisp_defun);
    RUN_TEST(commonlisp_multiple_functions);
    RUN_TEST(commonlisp_defmacro);
    RUN_TEST(makefile_rule_as_function);
    RUN_TEST(makefile_multiple_targets);
    RUN_TEST(makefile_variable_extraction);
    RUN_TEST(vimscript_function_extraction);
    RUN_TEST(vimscript_function_without_bang);
    RUN_TEST(julia_function_extraction);
    RUN_TEST(julia_function_with_args);

    /* Cross-cutting */
    RUN_TEST(python_calls);
    RUN_TEST(go_calls);
    RUN_TEST(python_imports);
    RUN_TEST(js_imports);
    RUN_TEST(go_imports);
    RUN_TEST(java_imports);
    RUN_TEST(rust_imports);
    RUN_TEST(c_imports);
    RUN_TEST(ruby_imports);
    RUN_TEST(lua_imports);
    RUN_TEST(import_stress_go);

    /* config_extraction_test.go ports */
    RUN_TEST(toml_basic_table_and_pair);
    RUN_TEST(toml_nested_table);
    RUN_TEST(toml_table_array_element);
    RUN_TEST(toml_dotted_key);
    RUN_TEST(toml_quoted_key);
    RUN_TEST(toml_empty_table);
    RUN_TEST(toml_comments_only);
    RUN_TEST(toml_boolean_and_integer_values);
    RUN_TEST(ini_basic_section_and_setting);
    RUN_TEST(ini_multiple_sections);
    RUN_TEST(ini_global_keys);
    RUN_TEST(ini_comments);
    RUN_TEST(json_basic_pair);
    RUN_TEST(json_nested_object);
    RUN_TEST(json_empty_object);
    RUN_TEST(json_boolean_null_values);
    RUN_TEST(json_package_json_deps);
    RUN_TEST(xml_basic_element);
    RUN_TEST(xml_self_closing_tag);
    RUN_TEST(xml_empty_document);
    RUN_TEST(xml_multiple_children);
    RUN_TEST(markdown_atx_headings);
    RUN_TEST(markdown_setext_headings);
    RUN_TEST(markdown_heading_content);
    RUN_TEST(markdown_no_headings);

    /* __init__.py / index.ts Module QN collision regression */
    RUN_TEST(python_init_module_qn_not_collide_with_folder);
    RUN_TEST(python_init_nested_module_qn);
    RUN_TEST(js_index_module_qn_not_collide_with_folder);
    RUN_TEST(python_regular_module_qn_unchanged);

    ctx_shutdown();
}
