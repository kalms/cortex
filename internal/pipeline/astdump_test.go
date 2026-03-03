package pipeline

import (
	"fmt"
	"strings"
	"testing"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"

	"github.com/DeusData/codebase-memory-mcp/internal/lang"
	"github.com/DeusData/codebase-memory-mcp/internal/parser"
)

func dumpNode(node *tree_sitter.Node, source []byte, indent int) string {
	var sb strings.Builder
	prefix := strings.Repeat("  ", indent)
	text := string(source[node.StartByte():node.EndByte()])
	if len(text) > 60 {
		text = text[:60] + "..."
	}
	text = strings.ReplaceAll(text, "\n", "\\n")
	fmt.Fprintf(&sb, "%s%s [%s] field=%q :: %q\n", prefix, node.Kind(), node.GrammarName(), fieldNameOfNode(node), text)
	for i := uint(0); i < node.ChildCount(); i++ {
		child := node.Child(i)
		if child != nil {
			sb.WriteString(dumpNode(child, source, indent+1))
		}
	}
	return sb.String()
}

func fieldNameOfNode(node *tree_sitter.Node) string {
	parent := node.Parent()
	if parent == nil {
		return ""
	}
	for i := uint(0); i < parent.ChildCount(); i++ {
		child := parent.Child(i)
		if child != nil && child.Id() == node.Id() {
			name := parent.FieldNameForChild(uint32(i))
			return name
		}
	}
	return ""
}

var astDumpCases = []struct {
	name string
	lang lang.Language
	code string
}{
	// Kotlin function (complexity)
	{"kotlin_func", lang.Kotlin, "fun f() {\n\tif (x) {}\n\tfor (i in 1..10) {}\n}\n"},
	// Kotlin class with base
	{"kotlin_class", lang.Kotlin, "class Child : Parent() {}\n"},
	// Kotlin annotation
	{"kotlin_anno", lang.Kotlin, "@MyAnnotation\nfun f() {}\n"},
	// Kotlin params
	{"kotlin_params", lang.Kotlin, "fun f(cfg: Config) {}\n"},
	// Kotlin return type
	{"kotlin_return", lang.Kotlin, "fun f(): Config { TODO() }\n"},
	// C++ params
	{"cpp_params", lang.CPP, "void f(Config cfg) {}\n"},
	// C# params
	{"csharp_params", lang.CSharp, "class A {\n\tvoid F(Config cfg) {}\n}\n"},
	// PHP params
	{"php_params", lang.PHP, "<?php\nfunction f(Config $cfg) {}\n"},
	// Scala params
	{"scala_params", lang.Scala, "object A {\n\tdef f(cfg: Config): Unit = {}\n}\n"},
	// C# return type
	{"csharp_return", lang.CSharp, "class A {\n\tConfig F() { return null; }\n}\n"},
	// PHP return type
	{"php_return", lang.PHP, "<?php\nfunction f(): Config { return new Config(); }\n"},
	// Kotlin return type
	{"kotlin_return2", lang.Kotlin, "fun f(): Config { TODO() }\n"},
	// PHP attribute
	{"php_attr", lang.PHP, "<?php\n#[MyAttribute]\nfunction f() {}\n"},
	// Kotlin throw
	{"kotlin_throw", lang.Kotlin, "class MyError : RuntimeException()\nfun f() {\n\tthrow MyError()\n}\n"},
	// C++ throw
	{"cpp_throw", lang.CPP, "class MyError {};\nvoid f() {\n\tthrow MyError();\n}\n"},
	// Rust throw (panic)
	{"rust_panic", lang.Rust, "struct MyError;\nfn f() {\n\tpanic!(\"error\");\n}\n"},
	// PHP variable
	{"php_var", lang.PHP, "<?php\n$API_URL = \"https://example.com\";\n"},
	// Lua variable
	{"lua_var", lang.Lua, "local API_URL = \"https://example.com\"\n"},
	// Scala variable
	{"scala_var", lang.Scala, "object Config {\n\tval apiUrl = \"https://example.com\"\n}\n"},
	// Kotlin variable
	{"kotlin_var", lang.Kotlin, "val apiUrl = \"https://example.com\"\n"},
	// C# class with const field
	{"csharp_const", lang.CSharp, "class Config {\n\tconst string BASE_URL = \"https://example.com\";\n\tconst string URL = BASE_URL + \"/api/orders\";\n}\n"},
	// --- AST dumps for failing tests ---
	// JS class extends
	{"js_extends", lang.JavaScript, "class Child extends Parent {}\n"},
	// Java class extends
	{"java_extends", lang.Java, "class Child extends Parent {}\n"},
	// Java annotated method
	{"java_anno", lang.Java, "class A {\n\t@MyAnnotation\n\tvoid f() {}\n}\n"},
	// C# class extends
	{"csharp_extends", lang.CSharp, "class Child : Parent {}\n"},
	// PHP class extends
	{"php_extends", lang.PHP, "<?php\nclass Child extends Parent {}\n"},
	// TS decorated function
	{"ts_decorator", lang.TypeScript, "@MyDecorator\nfunction f() {}\n"},
	// TS return type
	{"ts_return", lang.TypeScript, "function f(): Config { return {} as Config; }\n"},
	// Java variable
	{"java_var", lang.Java, "class Config {\n\tstatic final String API_URL = \"https://example.com\";\n}\n"},
	// C++ variable
	{"cpp_var", lang.CPP, "const std::string API_URL = \"https://example.com\";\n"},
	// Java throw
	{"java_throw", lang.Java, "class MyError extends RuntimeException {}\nclass A {\n\tvoid f() {\n\t\tthrow new MyError();\n\t}\n}\n"},
	// PHP throw
	{"php_throw", lang.PHP, "<?php\nclass MyError extends Exception {}\nfunction f() {\n\tthrow new MyError();\n}\n"},
	// Scala throw
	{"scala_throw", lang.Scala, "class MyError extends RuntimeException\nobject A {\n\tdef f(): Unit = {\n\t\tthrow new MyError()\n\t}\n}\n"},
	// TS class method with decorator
	{"ts_class_method_decorator", lang.TypeScript, "class A {\n\t@MyDecorator\n\tf() {}\n}\n"},
	// TS arrow function class property (Issue #2)
	{"ts_arrow_class_prop", lang.TypeScript, "class UserController {\n\tpublic getUsers: RequestHandler = async (req, res) => {\n\t\tres.json([]);\n\t};\n}\n"},
	// TS arrow function class property without type annotation
	{"ts_arrow_class_prop_notype", lang.TypeScript, "class A {\n\tgreet = () => 'hello';\n}\n"},
	// JS arrow function class property
	{"js_arrow_class_prop", lang.JavaScript, "class A {\n\tgreet = () => 'hello';\n\thandle = async (req) => {\n\t\treturn req;\n\t};\n}\n"},
	// JS const arrow function at module level
	{"js_const_arrow", lang.JavaScript, "const greet = () => 'hello';\nexport const handler = async (req) => { return req; };\n"},
	// TS const arrow function at module level
	{"ts_const_arrow", lang.TypeScript, "const greet = (): string => 'hello';\nexport const handler = async (req: Request): Promise<Response> => { return new Response(); };\n"},
	// Go interface with methods
	{"go_interface", lang.Go, "package main\n\ntype Router interface {\n\tGet(pattern string, h HandlerFunc)\n\tPost(pattern string, h HandlerFunc)\n\tServeHTTP(w ResponseWriter, r *Request)\n}\n"},
	// Rust attribute macros (#[get("/path")])
	{"rust_attr_macro", lang.Rust, "#[get(\"/users\")]\nasync fn get_users() -> HttpResponse {\n\tHttpResponse::Ok().finish()\n}\n"},
	// Rust impl Trait for Struct
	{"rust_impl_trait", lang.Rust, "trait Handler {\n\tfn handle(&self);\n}\nstruct MyHandler;\nimpl Handler for MyHandler {\n\tfn handle(&self) {}\n}\n"},
	// Kotlin variable top-level
	{"kotlin_var_toplevel", lang.Kotlin, "val apiUrl = \"https://example.com\"\n"},
	// C++ class with throw
	{"cpp_throw2", lang.CPP, "class MyError {};\nvoid f() {\n\tthrow MyError();\n}\n"},
	// Java class with separate throw
	{"java_two_classes", lang.Java, "class MyError extends RuntimeException {}\nclass A {\n\tvoid f() {\n\t\tthrow new MyError();\n\t}\n}\n"},

	// === Issue 1: C# modern feature diagnostics ===
	{"csharp_file_scoped_ns", lang.CSharp, "namespace Conduit.Features;\nclass A {\n\tvoid F() {}\n}\n"},
	{"csharp_primary_ctor", lang.CSharp, "public class UsersController(IMediator mediator) {\n\tpublic void Get() => mediator.Send();\n}\n"},
	{"csharp_expression_body", lang.CSharp, "class A {\n\tpublic string Name => \"test\";\n\tpublic int Add(int a, int b) => a + b;\n}\n"},
	{"csharp_traditional", lang.CSharp, "namespace Conduit.Features {\n\tclass A {\n\t\tvoid F() {}\n\t}\n}\n"},
	{"csharp_global_using", lang.CSharp, "global using System;\nnamespace A {\n\tclass B {\n\t\tvoid F() {}\n\t}\n}\n"},

	// === Issue 2: Lua anonymous function diagnostics ===
	{"lua_anon_func_assign", lang.Lua, "local f\nf = function(x)\n\treturn x\nend\n"},
	{"lua_local_func_assign", lang.Lua, "local f = function(x)\n\treturn x\nend\n"},
	{"lua_table_func", lang.Lua, "local t = {\n\tf = function(x)\n\t\treturn x\n\tend\n}\n"},
	{"lua_func_declaration", lang.Lua, "function f(x)\n\treturn x\nend\n"},
	{"lua_method_colon", lang.Lua, "function obj:method(x)\n\treturn x\nend\n"},

	// === New languages: Ruby ===
	{"ruby_func", lang.Ruby, "def greet(name)\n  puts name\nend\n"},
	{"ruby_class", lang.Ruby, "class Dog < Animal\n  def bark\n    puts 'woof'\n  end\nend\n"},
	{"ruby_module", lang.Ruby, "module Helpers\n  def self.run\n    42\n  end\nend\n"},
	{"ruby_if", lang.Ruby, "def f(x)\n  if x > 0\n    x\n  elsif x == 0\n    0\n  else\n    -x\n  end\nend\n"},
	{"ruby_require", lang.Ruby, "require 'json'\nrequire_relative 'helper'\n"},
	{"ruby_var", lang.Ruby, "API_URL = 'https://example.com'\n"},
	{"ruby_env", lang.Ruby, "val = ENV['API_KEY']\n"},

	// === New languages: C ===
	{"c_func", lang.C, "int add(int a, int b) {\n\treturn a + b;\n}\n"},
	{"c_struct", lang.C, "struct Point {\n\tint x;\n\tint y;\n};\n"},
	{"c_include", lang.C, "#include <stdio.h>\n#include \"myheader.h\"\n"},
	{"c_if", lang.C, "int f(int x) {\n\tif (x > 0) return x;\n\tfor (int i = 0; i < x; i++) {}\n}\n"},
	{"c_var", lang.C, "const char *API_URL = \"https://example.com\";\n"},
	{"c_enum", lang.C, "enum Color { RED, GREEN, BLUE };\n"},

	// === New languages: Bash ===
	{"bash_func", lang.Bash, "greet() {\n\techo \"hello $1\"\n}\n"},
	{"bash_func_keyword", lang.Bash, "function greet {\n\techo \"hello\"\n}\n"},
	{"bash_if", lang.Bash, "if [ -f file ]; then\n\techo exists\nelif [ -d dir ]; then\n\techo dir\nfi\n"},
	{"bash_var", lang.Bash, "API_URL=\"https://example.com\"\n"},
	{"bash_command", lang.Bash, "curl -s https://example.com\ngrep -r pattern .\n"},

	// === New languages: Zig ===
	{"zig_func", lang.Zig, "fn add(a: i32, b: i32) i32 {\n\treturn a + b;\n}\n"},
	{"zig_struct", lang.Zig, "const Point = struct {\n\tx: i32,\n\ty: i32,\n};\n"},
	{"zig_if", lang.Zig, "fn f(x: i32) i32 {\n\tif (x > 0) return x;\n\tfor (0..10) |i| {}\n}\n"},
	{"zig_import", lang.Zig, "const std = @import(\"std\");\n"},
	{"zig_var", lang.Zig, "const API_URL = \"https://example.com\";\nvar count: i32 = 0;\n"},

	// === New languages: Elixir ===
	{"elixir_func", lang.Elixir, "defmodule MyApp do\n  def greet(name) do\n    IO.puts(name)\n  end\nend\n"},
	{"elixir_module", lang.Elixir, "defmodule MyApp.Router do\n  use Plug.Router\n  plug :match\nend\n"},
	{"elixir_if", lang.Elixir, "def f(x) do\n  if x > 0 do\n    x\n  else\n    -x\n  end\nend\n"},
	{"elixir_import", lang.Elixir, "import Ecto.Query\nalias MyApp.Repo\n"},
	{"elixir_var", lang.Elixir, "x = 42\n"},

	// === New languages: Haskell ===
	{"haskell_func", lang.Haskell, "add :: Int -> Int -> Int\nadd x y = x + y\n"},
	{"haskell_data", lang.Haskell, "data Color = Red | Green | Blue\n"},
	{"haskell_class", lang.Haskell, "class Eq a where\n  (==) :: a -> a -> Bool\n"},
	{"haskell_import", lang.Haskell, "import Data.Map (Map, fromList)\nimport qualified Data.Text as T\n"},
	{"haskell_guard", lang.Haskell, "abs x\n  | x < 0 = -x\n  | otherwise = x\n"},
	{"haskell_case", lang.Haskell, "f x = case x of\n  0 -> \"zero\"\n  _ -> \"other\"\n"},

	// === New languages: OCaml ===
	{"ocaml_func", lang.OCaml, "let add x y = x + y\n"},
	{"ocaml_type", lang.OCaml, "type color = Red | Green | Blue\n"},
	{"ocaml_module", lang.OCaml, "module M = struct\n  let x = 42\nend\n"},
	{"ocaml_open", lang.OCaml, "open Printf\n"},
	{"ocaml_match", lang.OCaml, "let f x = match x with\n  | 0 -> \"zero\"\n  | _ -> \"other\"\n"},
	{"ocaml_if", lang.OCaml, "let f x = if x > 0 then x else -x\n"},

	// === New languages: HTML ===
	{"html_basic", lang.HTML, "<html>\n<head><title>Test</title></head>\n<body><h1>Hello</h1></body>\n</html>\n"},
	{"html_form", lang.HTML, "<form action=\"/submit\" method=\"POST\">\n  <input type=\"text\" name=\"q\" />\n</form>\n"},
	{"html_link", lang.HTML, "<a href=\"/about\">About</a>\n<link rel=\"stylesheet\" href=\"style.css\" />\n"},

	// === New languages: CSS ===
	{"css_rule", lang.CSS, "body {\n  color: red;\n  font-size: 14px;\n}\n"},
	{"css_import", lang.CSS, "@import url('other.css');\n"},
	{"css_class", lang.CSS, ".container {\n  display: flex;\n}\n"},

	// === New languages: YAML ===
	{"yaml_basic", lang.YAML, "name: test\nversion: 1.0\n"},
	{"yaml_nested", lang.YAML, "database:\n  host: localhost\n  port: 5432\n"},

	// === New languages: TOML ===
	{"toml_basic", lang.TOML, "name = \"test\"\nversion = \"1.0\"\n"},
	{"toml_section", lang.TOML, "[database]\nhost = \"localhost\"\nport = 5432\n"},

	// === New languages: HCL ===
	{"hcl_resource", lang.HCL, "resource \"aws_instance\" \"web\" {\n  ami = \"abc-123\"\n  instance_type = \"t2.micro\"\n}\n"},
	{"hcl_variable", lang.HCL, "variable \"region\" {\n  default = \"us-east-1\"\n}\n"},
	{"hcl_func", lang.HCL, "output \"ip\" {\n  value = lookup(var.map, \"key\")\n}\n"},

	// === New languages: Objective-C ===
	{"objc_interface", lang.ObjectiveC, "@interface Dog : NSObject\n@property NSString *name;\n- (void)bark;\n@end\n"},
	{"objc_impl", lang.ObjectiveC, "@implementation Dog\n- (void)bark {\n\tNSLog(@\"Woof\");\n}\n@end\n"},
	{"objc_func", lang.ObjectiveC, "void greet(NSString *name) {\n\tNSLog(@\"Hello %@\", name);\n}\n"},
	{"objc_import", lang.ObjectiveC, "#import <Foundation/Foundation.h>\n#import \"Dog.h\"\n"},
	{"objc_if", lang.ObjectiveC, "void f(int x) {\n\tif (x > 0) {\n\t\tNSLog(@\"pos\");\n\t} else {\n\t\tNSLog(@\"neg\");\n\t}\n\tfor (int i = 0; i < x; i++) {}\n}\n"},
	{"objc_var", lang.ObjectiveC, "NSString *const API_URL = @\"https://example.com\";\n"},
	{"objc_protocol", lang.ObjectiveC, "@protocol Runnable\n- (void)run;\n@end\n"},

	// === New languages: Swift ===
	{"swift_func", lang.Swift, "func greet(name: String) -> String {\n\treturn \"Hello \" + name\n}\n"},
	{"swift_class", lang.Swift, "class Dog: Animal {\n\tfunc bark() {\n\t\tprint(\"woof\")\n\t}\n}\n"},
	{"swift_struct", lang.Swift, "struct Point {\n\tvar x: Int\n\tvar y: Int\n}\n"},
	{"swift_protocol", lang.Swift, "protocol Runnable {\n\tfunc run()\n}\n"},
	{"swift_if", lang.Swift, "func f(x: Int) -> Int {\n\tif x > 0 {\n\t\treturn x\n\t}\n\treturn -x\n}\n"},
	{"swift_import", lang.Swift, "import Foundation\nimport UIKit\n"},
	{"swift_var", lang.Swift, "let apiUrl = \"https://example.com\"\nvar count = 0\n"},
	{"swift_enum", lang.Swift, "enum Color {\n\tcase red, green, blue\n}\n"},

	// === New languages: Dart ===
	{"dart_func", lang.Dart, "int add(int a, int b) {\n\treturn a + b;\n}\n"},
	{"dart_class", lang.Dart, "class Dog extends Animal {\n\tvoid bark() {\n\t\tprint('woof');\n\t}\n}\n"},
	{"dart_if", lang.Dart, "int f(int x) {\n\tif (x > 0) return x;\n\tfor (var i = 0; i < x; i++) {}\n\treturn -x;\n}\n"},
	{"dart_import", lang.Dart, "import 'dart:io';\nimport 'package:flutter/material.dart';\n"},
	{"dart_var", lang.Dart, "const apiUrl = 'https://example.com';\nvar count = 0;\n"},
	{"dart_enum", lang.Dart, "enum Color { red, green, blue }\n"},
	{"dart_mixin", lang.Dart, "mixin Swimming {\n\tvoid swim() {\n\t\tprint('swimming');\n\t}\n}\n"},

	// === New languages: Perl ===
	{"perl_func", lang.Perl, "sub greet {\n\tmy ($name) = @_;\n\tprint \"Hello $name\\n\";\n}\n"},
	{"perl_package", lang.Perl, "package Dog;\nuse strict;\nsub new {\n\tmy ($class) = @_;\n\treturn bless {}, $class;\n}\n1;\n"},
	{"perl_if", lang.Perl, "sub f {\n\tmy ($x) = @_;\n\tif ($x > 0) {\n\t\treturn $x;\n\t}\n\treturn -$x;\n}\n"},
	{"perl_use", lang.Perl, "use strict;\nuse warnings;\nuse File::Path;\n"},
	{"perl_var", lang.Perl, "my $api_url = 'https://example.com';\nour $VERSION = '1.0';\n"},

	// === New languages: Groovy ===
	{"groovy_func", lang.Groovy, "def greet(name) {\n\tprintln \"Hello $name\"\n}\n"},
	{"groovy_class", lang.Groovy, "class Dog extends Animal {\n\tvoid bark() {\n\t\tprintln 'woof'\n\t}\n}\n"},
	{"groovy_if", lang.Groovy, "def f(x) {\n\tif (x > 0) return x\n\tfor (i in 0..x) {}\n\treturn -x\n}\n"},
	{"groovy_import", lang.Groovy, "import groovy.json.JsonSlurper\n"},
	{"groovy_var", lang.Groovy, "def apiUrl = 'https://example.com'\n"},

	// === New languages: Erlang ===
	{"erlang_func", lang.Erlang, "-module(math).\n-export([add/2]).\nadd(A, B) -> A + B.\n"},
	{"erlang_case", lang.Erlang, "f(X) ->\n\tcase X of\n\t\t0 -> zero;\n\t\t_ -> other\n\tend.\n"},
	{"erlang_import", lang.Erlang, "-module(my_mod).\n-import(lists, [map/2, filter/2]).\n"},
	{"erlang_if", lang.Erlang, "f(X) ->\n\tif\n\t\tX > 0 -> positive;\n\t\tX < 0 -> negative;\n\t\ttrue -> zero\n\tend.\n"},
	{"erlang_remote_call", lang.Erlang, "-module(mymod).\nmain() ->\n\tio:format(\"hello ~s~n\", [Name]),\n\tgreet(\"World\").\ngreet(Name) -> Name.\n"},
	{"erlang_define_record", lang.Erlang, "-module(mymod).\n-define(TIMEOUT, 5000).\n-record(person, {name, age}).\n"},

	// === New languages: R ===
	{"r_func", lang.R, "add <- function(a, b) {\n\ta + b\n}\n"},
	{"r_if", lang.R, "f <- function(x) {\n\tif (x > 0) x else -x\n}\n"},
	{"r_var", lang.R, "api_url <- \"https://example.com\"\ncount = 0\n"},
	{"r_import", lang.R, "library(ggplot2)\nrequire(dplyr)\n"},

	// === New languages: SCSS ===
	{"scss_mixin", lang.SCSS, "@mixin flex-center {\n\tdisplay: flex;\n\talign-items: center;\n}\n"},
	{"scss_var", lang.SCSS, "$primary-color: #333;\n$font-size: 14px;\n"},
	{"scss_import", lang.SCSS, "@import 'variables';\n@use 'mixins';\n"},
	{"scss_nested", lang.SCSS, ".container {\n\t.header {\n\t\tcolor: red;\n\t}\n}\n"},

	// === New languages: SQL ===
	{"sql_table", lang.SQL, "CREATE TABLE users (\n\tid INT PRIMARY KEY,\n\tname VARCHAR(100)\n);\n"},
	{"sql_select", lang.SQL, "SELECT u.name, COUNT(o.id) FROM users u JOIN orders o ON u.id = o.user_id GROUP BY u.name;\n"},
	{"sql_func", lang.SQL, "CREATE FUNCTION add(a INT, b INT) RETURNS INT AS $$ SELECT a + b; $$ LANGUAGE SQL;\n"},
	{"sql_func_call", lang.SQL, "SELECT count(*), upper(name) FROM users;\n"},
	{"sql_view", lang.SQL, "CREATE VIEW active_users AS SELECT * FROM users WHERE active = true;\n"},

	// === C# call AST diagnostics ===
	{"csharp_member_call", lang.CSharp, "class A {\n\tvoid F() {\n\t\t_context.SaveChangesAsync(token);\n\t\tentity.AddDomainEvent(new Event());\n\t\tvar x = _identityService.GetUserNameAsync(userId);\n\t}\n}\n"},
	{"csharp_static_call", lang.CSharp, "class A {\n\tvoid F() {\n\t\tConsole.WriteLine(\"hello\");\n\t\tstring.IsNullOrEmpty(s);\n\t}\n}\n"},
	{"csharp_simple_call", lang.CSharp, "class A {\n\tvoid F() {\n\t\tDoWork();\n\t\tawait SaveAsync();\n\t}\n}\n"},
	{"csharp_await_call", lang.CSharp, "class A {\n\tasync Task F() {\n\t\tawait _context.SaveChangesAsync(token);\n\t\tvar result = await next();\n\t}\n}\n"},
	{"csharp_new_object", lang.CSharp, "class A {\n\tvoid F() {\n\t\tvar e = new TodoItem();\n\t\tvar list = new List<string>();\n\t}\n}\n"},

	// === Ruby call AST diagnostics ===
	{"ruby_method_call", lang.Ruby, "class A\n  def f\n    name.to_s\n    @items.each { |i| puts i }\n    response.status = 200\n  end\nend\n"},
	{"ruby_bare_call", lang.Ruby, "class A\n  def f\n    puts 'hello'\n    greet('world')\n    render json: data\n  end\nend\n"},
	{"ruby_chain_call", lang.Ruby, "class A\n  def f\n    users.where(active: true).order(:name).limit(10)\n  end\nend\n"},

	// === New languages: Dockerfile ===
	{"dockerfile_from", lang.Dockerfile, "FROM golang:1.22-alpine AS builder\nWORKDIR /app\nCOPY . .\nRUN go build -o main .\n"},
	{"dockerfile_env", lang.Dockerfile, "ENV APP_PORT=8080\nARG VERSION=latest\nEXPOSE 8080\n"},

	// =====================================================================
	// v0.5 Documentation Cases — Complex patterns for extraction planning
	// =====================================================================

	// === Framework Patterns: Express/Gin/Chi routes ===
	{"js_express_route", lang.JavaScript, "app.get('/users/:id', async (req, res) => {\n  const user = await db.findUser(req.params.id);\n  res.json(user);\n});\n"},
	{"js_express_middleware", lang.JavaScript, "app.use('/api', authMiddleware, rateLimit({ max: 100 }));\n"},
	{"ts_express_typed_route", lang.TypeScript, "router.post('/orders', validate(OrderSchema), async (req: Request, res: Response) => {\n  const order = await orderService.create(req.body);\n  res.status(201).json(order);\n});\n"},
	{"go_chi_route", lang.Go, "package main\nfunc routes(r chi.Router) {\n\tr.Get(\"/users/{id}\", getUser)\n\tr.Post(\"/users\", createUser)\n\tr.Route(\"/admin\", func(r chi.Router) {\n\t\tr.Use(adminOnly)\n\t\tr.Get(\"/stats\", getStats)\n\t})\n}\n"},

	// === Framework Patterns: Spring/Django/Laravel annotations ===
	{"java_spring_controller", lang.Java, "@RestController\n@RequestMapping(\"/api/users\")\nclass UserController {\n\t@Autowired\n\tprivate UserService userService;\n\t@GetMapping(\"/{id}\")\n\tpublic User getUser(@PathVariable Long id) {\n\t\treturn userService.findById(id);\n\t}\n}\n"},
	{"java_spring_service", lang.Java, "@Service\nclass UserService {\n\t@Transactional\n\tpublic User createUser(CreateUserRequest req) {\n\t\tUser user = new User(req.getName());\n\t\treturn repository.save(user);\n\t}\n}\n"},
	{"php_laravel_route", lang.PHP, "<?php\nRoute::middleware('auth')->group(function () {\n\tRoute::get('/dashboard', [DashboardController::class, 'index']);\n\tRoute::resource('posts', PostController::class);\n});\n"},

	// === Framework Patterns: Ruby Sinatra/Rails DSL ===
	{"ruby_sinatra_route", lang.Ruby, "class App < Sinatra::Base\n  get '/users/:id' do\n    user = User.find(params[:id])\n    json user\n  end\n\n  post '/users' do\n    user = User.create(params)\n    status 201\n    json user\n  end\nend\n"},
	{"ruby_rails_model", lang.Ruby, "class User < ApplicationRecord\n  has_many :posts, dependent: :destroy\n  belongs_to :organization\n  validates :email, presence: true, uniqueness: true\n  scope :active, -> { where(active: true) }\nend\n"},

	// === Framework Patterns: Elixir Phoenix ===
	{"elixir_phoenix_router", lang.Elixir, "defmodule MyAppWeb.Router do\n  use MyAppWeb, :router\n  pipeline :api do\n    plug :accepts, [\"json\"]\n  end\n  scope \"/api\", MyAppWeb do\n    pipe_through :api\n    resources \"/users\", UserController\n  end\nend\n"},

	// === Async Patterns ===
	{"ts_async_await", lang.TypeScript, "async function fetchData(): Promise<User[]> {\n  const response = await fetch('/api/users');\n  if (!response.ok) throw new Error('Failed');\n  return await response.json();\n}\n"},
	{"rust_async_await", lang.Rust, "async fn fetch_user(id: u64) -> Result<User, Error> {\n\tlet resp = client.get(format!(\"/users/{}\", id)).send().await?;\n\tlet user: User = resp.json().await?;\n\tOk(user)\n}\n"},
	{"python_async_gather", lang.Python, "async def fetch_all(ids):\n    tasks = [fetch_user(id) for id in ids]\n    results = await asyncio.gather(*tasks)\n    return results\n"},
	{"kotlin_coroutine", lang.Kotlin, "suspend fun fetchUsers(): List<User> {\n\treturn withContext(Dispatchers.IO) {\n\t\tval response = api.getUsers()\n\t\tresponse.body() ?: emptyList()\n\t}\n}\n"},
	{"go_goroutine_channel", lang.Go, "package main\nfunc process(ctx context.Context, items []Item) error {\n\terrCh := make(chan error, len(items))\n\tfor _, item := range items {\n\t\tgo func(it Item) {\n\t\t\terrCh <- handle(ctx, it)\n\t\t}(item)\n\t}\n\tfor range items {\n\t\tif err := <-errCh; err != nil {\n\t\t\treturn err\n\t\t}\n\t}\n\treturn nil\n}\n"},

	// === Error Handling Patterns ===
	{"ts_try_catch_finally", lang.TypeScript, "async function safeFetch(url: string): Promise<Data | null> {\n  try {\n    const res = await fetch(url);\n    return await res.json();\n  } catch (err) {\n    logger.error('fetch failed', { url, err });\n    return null;\n  } finally {\n    metrics.recordFetch(url);\n  }\n}\n"},
	{"rust_question_mark_chain", lang.Rust, "fn process(path: &str) -> Result<Config, Error> {\n\tlet data = std::fs::read_to_string(path)?;\n\tlet config: Config = serde_json::from_str(&data)?;\n\tconfig.validate()?;\n\tOk(config)\n}\n"},
	{"go_error_wrap", lang.Go, "package main\nimport \"fmt\"\nfunc loadConfig(path string) (*Config, error) {\n\tdata, err := os.ReadFile(path)\n\tif err != nil {\n\t\treturn nil, fmt.Errorf(\"read config: %w\", err)\n\t}\n\tvar cfg Config\n\tif err := json.Unmarshal(data, &cfg); err != nil {\n\t\treturn nil, fmt.Errorf(\"parse config: %w\", err)\n\t}\n\treturn &cfg, nil\n}\n"},
	{"python_exception_chain", lang.Python, "def process(data):\n    try:\n        result = validate(data)\n    except ValidationError as e:\n        raise ProcessingError(f'invalid: {e}') from e\n    except TimeoutError:\n        raise RetryableError('timeout') from None\n"},
	{"java_multi_catch", lang.Java, "class A {\n\tvoid process() {\n\t\ttry {\n\t\t\triskyOperation();\n\t\t} catch (IOException | SQLException e) {\n\t\t\tlogger.error(\"Operation failed\", e);\n\t\t\tthrow new ServiceException(e);\n\t\t} finally {\n\t\t\tcleanup();\n\t\t}\n\t}\n}\n"},
	{"elixir_with_error", lang.Elixir, "defmodule A do\n  def process(params) do\n    with {:ok, user} <- find_user(params.id),\n         {:ok, order} <- create_order(user, params),\n         :ok <- send_notification(user, order) do\n      {:ok, order}\n    else\n      {:error, :not_found} -> {:error, \"user not found\"}\n      {:error, reason} -> {:error, reason}\n    end\n  end\nend\n"},

	// === Generic/Template Patterns ===
	{"ts_generic_class", lang.TypeScript, "class Repository<T extends Entity> {\n  constructor(private readonly db: Database) {}\n  async findById(id: string): Promise<T | null> {\n    return this.db.collection<T>().findOne({ id });\n  }\n}\n"},
	{"java_generic_method", lang.Java, "class A {\n\t<T extends Comparable<T>> List<T> sort(List<T> items) {\n\t\treturn items.stream().sorted().collect(Collectors.toList());\n\t}\n}\n"},
	{"rust_generic_impl", lang.Rust, "impl<T: Clone + Send + 'static> From<Vec<T>> for Collection<T> {\n\tfn from(items: Vec<T>) -> Self {\n\t\tSelf { items, len: items.len() }\n\t}\n}\n"},
	{"cpp_template_class", lang.CPP, "template<typename T, typename Alloc = std::allocator<T>>\nclass Vector {\npublic:\n\tvoid push_back(const T& value) { data_.push_back(value); }\n\tT& operator[](size_t index) { return data_[index]; }\nprivate:\n\tstd::vector<T, Alloc> data_;\n};\n"},
	{"scala_type_bounds", lang.Scala, "object A {\n\tdef process[T <: Serializable : Ordering](items: List[T]): List[T] = {\n\t\titems.sorted.distinct\n\t}\n}\n"},

	// === Destructuring Patterns ===
	{"js_object_destructure", lang.JavaScript, "const { name, age, address: { city } } = getUserInfo();\nconst [first, ...rest] = getItems();\n"},
	{"ts_function_destructure", lang.TypeScript, "function processUser({ id, name, roles = [] }: UserInput): Result {\n  return { id, displayName: name, isAdmin: roles.includes('admin') };\n}\n"},
	{"python_unpack", lang.Python, "first, *middle, last = get_items()\n(x, y), z = get_coords()\nname, age = user_info.values()\n"},
	{"rust_pattern_match", lang.Rust, "fn handle(msg: Message) {\n\tmatch msg {\n\t\tMessage::Quit => println!(\"quit\"),\n\t\tMessage::Move { x, y } => move_to(x, y),\n\t\tMessage::Write(text) => println!(\"{}\", text),\n\t\tMessage::Color(r, g, b) => set_color(r, g, b),\n\t}\n}\n"},
	{"kotlin_destructure", lang.Kotlin, "fun process(pair: Pair<String, Int>) {\n\tval (name, age) = pair\n\tval (first, second, third) = Triple(1, 2, 3)\n}\n"},

	// === Metaprogramming/Dynamic Patterns ===
	{"python_decorator_stack", lang.Python, "@app.route('/users', methods=['GET'])\n@login_required\n@cache(timeout=300)\ndef list_users():\n    return User.query.all()\n"},
	{"ruby_method_missing", lang.Ruby, "class DynamicProxy\n  def method_missing(name, *args, &block)\n    if target.respond_to?(name)\n      target.send(name, *args, &block)\n    else\n      super\n    end\n  end\nend\n"},
	{"python_dunder_methods", lang.Python, "class Vector:\n    def __init__(self, x, y):\n        self.x = x\n        self.y = y\n    def __add__(self, other):\n        return Vector(self.x + other.x, self.y + other.y)\n    def __repr__(self):\n        return f'Vector({self.x}, {self.y})'\n"},
	{"ts_mapped_types", lang.TypeScript, "type Readonly<T> = { readonly [P in keyof T]: T[P] };\ntype Optional<T> = { [P in keyof T]?: T[P] };\ntype Pick<T, K extends keyof T> = { [P in K]: T[P] };\n"},

	// === Pipe/Composition Patterns ===
	{"elixir_pipe_complex", lang.Elixir, "defmodule A do\n  def process(data) do\n    data\n    |> Enum.filter(&(&1.active))\n    |> Enum.map(&transform/1)\n    |> Enum.sort_by(& &1.priority)\n    |> Enum.take(10)\n  end\nend\n"},
	{"haskell_composition", lang.Haskell, "processAll = map (show . succ . abs)\n"},
	{"ocaml_pipe_complex", lang.OCaml, "let process items =\n  items\n  |> List.filter (fun x -> x > 0)\n  |> List.map (fun x -> x * 2)\n  |> List.sort compare\n"},

	// === Interface/Trait Implementation Patterns ===
	{"rust_trait_impl", lang.Rust, "trait Handler {\n\tfn handle(&self, req: &Request) -> Response;\n}\nstruct ApiHandler { db: Database }\nimpl Handler for ApiHandler {\n\tfn handle(&self, req: &Request) -> Response {\n\t\tself.db.query(req.path())\n\t}\n}\n"},
	{"go_interface_impl", lang.Go, "package main\ntype Handler interface {\n\tHandle(ctx context.Context, req *Request) (*Response, error)\n}\ntype APIHandler struct{ db *DB }\nfunc (h *APIHandler) Handle(ctx context.Context, req *Request) (*Response, error) {\n\treturn h.db.Query(ctx, req.Path)\n}\n"},
	{"csharp_interface_impl", lang.CSharp, "interface IHandler {\n\tTask<Response> HandleAsync(Request req);\n}\nclass ApiHandler : IHandler {\n\tprivate readonly IDb _db;\n\tpublic async Task<Response> HandleAsync(Request req) {\n\t\treturn await _db.QueryAsync(req.Path);\n\t}\n}\n"},
	{"kotlin_interface_impl", lang.Kotlin, "interface Handler {\n\tsuspend fun handle(req: Request): Response\n}\nclass ApiHandler(private val db: Database) : Handler {\n\toverride suspend fun handle(req: Request): Response {\n\t\treturn db.query(req.path)\n\t}\n}\n"},

	// === Closure/Lambda Patterns ===
	{"go_closure_capture", lang.Go, "package main\nfunc makeCounter() func() int {\n\tcount := 0\n\treturn func() int {\n\t\tcount++\n\t\treturn count\n\t}\n}\n"},
	{"rust_closure_move", lang.Rust, "fn spawn_task(data: Vec<u8>) {\n\ttokio::spawn(async move {\n\t\tprocess(&data).await;\n\t\tprintln!(\"done\");\n\t});\n}\n"},
	{"java_lambda_stream", lang.Java, "class A {\n\tList<String> process(List<User> users) {\n\t\treturn users.stream()\n\t\t\t.filter(u -> u.isActive())\n\t\t\t.map(User::getName)\n\t\t\t.sorted()\n\t\t\t.collect(Collectors.toList());\n\t}\n}\n"},

	// === Erlang OTP Patterns ===
	{"erlang_gen_server", lang.Erlang, "-module(counter).\n-behaviour(gen_server).\n-export([start_link/0, init/1, handle_call/3]).\nstart_link() -> gen_server:start_link(?MODULE, 0, []).\ninit(Count) -> {ok, Count}.\nhandle_call(increment, _From, Count) -> {reply, Count + 1, Count + 1}.\n"},
	{"erlang_supervisor", lang.Erlang, "-module(my_sup).\n-behaviour(supervisor).\n-export([start_link/0, init/1]).\nstart_link() -> supervisor:start_link({local, ?MODULE}, ?MODULE, []).\ninit([]) -> {ok, {{one_for_one, 5, 10}, [{worker, {my_worker, start_link, []}, permanent, 5000, worker, [my_worker]}]}}.\n"},

	// === Haskell Type Classes ===
	{"haskell_typeclass_def", lang.Haskell, "class Container f where\n  empty :: f a\n  insert :: a -> f a -> f a\n  member :: Eq a => a -> f a -> Bool\n"},
	{"haskell_instance_impl", lang.Haskell, "instance Show Color where\n  show Red = \"red\"\n  show Green = \"green\"\n  show Blue = \"blue\"\n"},

	// === Complex OOP Patterns ===
	{"csharp_generic_constraint", lang.CSharp, "class Repository<T> where T : class, IEntity, new() {\n\tpublic T FindById(int id) {\n\t\treturn _context.Set<T>().Find(id);\n\t}\n}\n"},
	{"scala_sealed_trait", lang.Scala, "sealed trait Shape\ncase class Circle(radius: Double) extends Shape\ncase class Rectangle(w: Double, h: Double) extends Shape\nobject Shape {\n\tdef area(s: Shape): Double = s match {\n\t\tcase Circle(r) => math.Pi * r * r\n\t\tcase Rectangle(w, h) => w * h\n\t}\n}\n"},
	{"php_trait_usage", lang.PHP, "<?php\ntrait Timestampable {\n\tpublic function touch(): void {\n\t\t$this->updatedAt = new DateTime();\n\t}\n}\nclass Post implements JsonSerializable {\n\tuse Timestampable;\n\tpublic function jsonSerialize(): mixed {\n\t\treturn ['title' => $this->title];\n\t}\n}\n"},
}

func TestDumpAST(t *testing.T) {
	for _, tt := range astDumpCases {
		t.Run(tt.name, func(t *testing.T) {
			tree, src := parseSource(t, tt.lang, tt.code)
			defer tree.Close()
			dump := dumpNode(tree.RootNode(), src, 0)
			t.Log("\n" + dump)
		})
	}
}

// TestLuaFuncAssignName verifies that luaFuncAssignName correctly extracts
// variable names for anonymous function assignments.
func TestLuaFuncAssignName(t *testing.T) {
	tests := []struct {
		name     string
		code     string
		wantName string
	}{
		{"separate_assign", "local f\nf = function(x)\n\treturn x\nend\n", "f"},
		{"local_assign", "local f = function(x)\n\treturn x\nend\n", "f"},
		{"named_func", "function f(x)\n\treturn x\nend\n", ""}, // not anonymous — funcNameNode handles this
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tree, src := parseSource(t, lang.Lua, tt.code)
			defer tree.Close()

			// Walk the AST to find function_definition nodes
			var foundName string
			parser.Walk(tree.RootNode(), func(node *tree_sitter.Node) bool {
				if node.Kind() == "function_definition" {
					nameNode := funcNameNode(node)
					if nameNode == nil {
						nameNode = luaFuncAssignName(node)
					}
					if nameNode != nil {
						foundName = parser.NodeText(nameNode, src)
					} else {
						t.Logf("function_definition found but no name resolved")
						t.Logf("  parent: %s", node.Parent().Kind())
						if node.Parent().Parent() != nil {
							t.Logf("  grandparent: %s", node.Parent().Parent().Kind())
						}
					}
					return false
				}
				return true
			})

			if tt.wantName == "" {
				// For named functions, funcNameNode handles it (not luaFuncAssignName)
				return
			}
			if foundName != tt.wantName {
				t.Errorf("luaFuncAssignName: got %q, want %q", foundName, tt.wantName)
			}
		})
	}
}

// TestRFuncAssignName verifies that rFuncAssignName correctly extracts
// variable names for R function assignments.
func TestRFuncAssignName(t *testing.T) {
	tests := []struct {
		name     string
		code     string
		wantName string
	}{
		{"arrow_assign", "add <- function(a, b) {\n\ta + b\n}\n", "add"},
		{"equals_assign", "square = function(n) {\n\tn * n\n}\n", "square"},
		{"double_arrow", "greet <<- function(x) x\n", "greet"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tree, src := parseSource(t, lang.R, tt.code)
			defer tree.Close()

			var foundName string
			parser.Walk(tree.RootNode(), func(node *tree_sitter.Node) bool {
				if node.Kind() == "function_definition" {
					nameNode := rFuncAssignName(node)
					if nameNode != nil {
						foundName = parser.NodeText(nameNode, src)
					}
					return false
				}
				return true
			})

			if foundName != tt.wantName {
				t.Errorf("rFuncAssignName: got %q, want %q", foundName, tt.wantName)
			}
		})
	}
}
