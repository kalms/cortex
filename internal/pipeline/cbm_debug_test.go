package pipeline

import (
	"fmt"
	"testing"

	"github.com/DeusData/codebase-memory-mcp/internal/cbm"
	"github.com/DeusData/codebase-memory-mcp/internal/lang"
)

func dumpCBM(t *testing.T, name string, l lang.Language, src string) {
	result, err := cbm.ExtractFile([]byte(src), l, "test", "main.x")
	if err != nil {
		t.Logf("  ExtractFile error: %v", err)
		return
	}
	fmt.Printf("--- %s Definitions ---\n", name)
	for i := range result.Definitions {
		d := &result.Definitions[i]
		fmt.Printf("  name=%q label=%q qn=%q parent=%q decorators=%v param_types=%v\n", d.Name, d.Label, d.QualifiedName, d.ParentClass, d.Decorators, d.ParamTypes)
	}
	if len(result.ImplTraits) > 0 {
		fmt.Printf("--- %s ImplTraits ---\n", name)
		for _, it := range result.ImplTraits {
			fmt.Printf("  trait=%q struct=%q\n", it.TraitName, it.StructName)
		}
	}
}

func TestCBMVariableDebug(t *testing.T) {
	tests := []struct {
		name string
		lang lang.Language
		src  string
	}{
		{"Java", lang.Java, "class OwnerController {\n    @GetMapping(\"/owners\")\n    public void listOwners() {}\n\n    @PostMapping(\"/owners\")\n    public void createOwner() {}\n}\n"},
		{"Groovy", lang.Groovy, "class Calculator {\n    int add(int a, int b) {\n        return a + b\n    }\n    int multiply(int a, int b) {\n        return a * b\n    }\n}\n"},
		{"Dart", lang.Dart, "class Counter {\n  int _count = 0;\n\n  void increment() {\n    _count++;\n  }\n\n  int getCount() {\n    return _count;\n  }\n}\n"},
		{"ObjC", lang.ObjectiveC, "@interface Greeter : NSObject\n- (void)greet:(NSString *)name;\n@end\n\n@implementation Greeter\n- (void)greet:(NSString *)name {\n    NSLog(@\"Hello %@\", name);\n}\n\n- (void)run {\n    [self greet:@\"World\"];\n}\n@end\n"},
		{"Swift", lang.Swift, "class Animal {\n    var name: String = \"\"\n}\n\nclass Dog: Animal {\n    func bark() -> String {\n        return \"Woof\"\n    }\n}\n"},
		{"Lua", lang.Lua, "local function named_func()\n    return 1\nend\n\nlocal run_before_filter = function()\n    return 2\nend\n\nlocal run_after_filter = function()\n    return 3\nend\n"},
		{"Elixir", lang.Elixir, "defmodule Greeter do\n  def greet(name) do\n    \"Hello \"\n  end\n\n  defp internal_work(x) do\n    x * 2\n  end\nend\n"},
		{"R", lang.R, "mutate <- function(x) {\n  x + 1\n}\n\nsquare <- function(n) {\n  n * n\n}\n"},
		{"Erlang", lang.Erlang, "-module(mymod).\n-define(TIMEOUT, 5000).\n-record(person, {name, age}).\n"},
		{"SQL_Table", lang.SQL, "CREATE TABLE users (\n    id INTEGER PRIMARY KEY,\n    name TEXT NOT NULL\n);\nCREATE VIEW active_users AS SELECT * FROM users WHERE active = true;\n"},
		{"SQL_Func", lang.SQL, "CREATE FUNCTION add(a INT, b INT) RETURNS INT AS $$ SELECT a + b; $$ LANGUAGE SQL;\n"},
		{"YAML", lang.YAML, "name: myapp\nversion: \"1.0\"\nservices:\n  web:\n    image: nginx\n"},
		{"SCSS", lang.SCSS, "$primary-color: #007bff;\n$font-size: 16px;\n\nbody {\n  color: $primary-color;\n}\n"},
		{"Rust_Impl", lang.Rust, "trait Handler {\n    fn handle(&self) -> String;\n}\nstruct MyHandler;\nimpl Handler for MyHandler {\n    fn handle(&self) -> String {\n        String::from(\"handled\")\n    }\n}\n"},
		{"Java_Params", lang.Java, "class Service {\n\tvoid process(Config cfg) {}\n}\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dumpCBM(t, tt.name, tt.lang, tt.src)
		})
	}
}
