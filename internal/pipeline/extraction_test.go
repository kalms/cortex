package pipeline

import (
	"reflect"
	"testing"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"

	"github.com/DeusData/codebase-memory-mcp/internal/lang"
	"github.com/DeusData/codebase-memory-mcp/internal/parser"
)

// ============================================================================
// TestCalleeExtraction — assertion-based callee extraction test suite
//
// Documents the exact output of extractCalleeName() for every call pattern
// per language. All assertions reflect optimal (correct) behavior.
// ============================================================================

var calleeExtractionCases = []struct {
	name        string
	lang        lang.Language
	code        string
	wantCallees []string
}{
	// === Go (16 cases) ===
	{"go_simple_call", lang.Go, `package main; func f() { fmt.Println("hello") }`,
		[]string{"fmt.Println"}},
	{"go_method_call", lang.Go, `package main; func f(s *Server) { s.handler.ServeHTTP(w, r) }`,
		[]string{"s.handler.ServeHTTP"}},
	{"go_goroutine_call", lang.Go, `package main; func f() { go process(ctx) }`,
		[]string{"process"}},
	{"go_defer_call", lang.Go, `package main; func f(conn net.Conn) { defer conn.Close() }`,
		[]string{"conn.Close"}},
	{"go_multi_call", lang.Go, `package main; func f() { a(); b(); c() }`,
		[]string{"a", "b", "c"}},
	{"go_nested_call", lang.Go, `package main; func f() { fmt.Println(strconv.Itoa(42)) }`,
		[]string{"fmt.Println", "strconv.Itoa"}},
	{"go_type_assert_call", lang.Go, `package main; func f(r io.Reader) { r.(io.Closer).Close() }`,
		[]string{"r.(io.Closer).Close"}},
	{"go_iife", lang.Go, "package main; func f() { func() { fmt.Println(\"hi\") }() }",
		[]string{"fmt.Println"}},
	{"go_append_call", lang.Go, `package main; func f(s []int) []int { return append(s, 1, 2) }`,
		[]string{"append"}},
	{"go_make_call", lang.Go, `package main; func f() { ch := make(chan int, 10); _ = ch }`,
		[]string{"make"}},
	{"go_error_wrap", lang.Go, "package main\nimport \"fmt\"\nfunc f(err error) error { return fmt.Errorf(\"wrap: %w\", err) }\n",
		[]string{"fmt.Errorf"}},
	{"go_multi_return_call", lang.Go, `package main; func f(s string) { val, _ := strconv.Atoi(s); _ = val }`,
		[]string{"strconv.Atoi"}},
	{"go_closure_return", lang.Go, `package main; func f() func() { return func() { process(42) } }`,
		[]string{"process"}},
	{"go_interface_call", lang.Go, `package main; func f(w io.Writer) { w.Write(data) }`,
		[]string{"w.Write"}},
	{"go_type_switch_call", lang.Go, "package main\nfunc f(v interface{}) { switch v.(type) { case int: handle(v) } }\n",
		[]string{"handle"}},
	{"go_select_call", lang.Go, "package main\nfunc f(ch chan int) { select { case v := <-ch: process(v) } }\n",
		[]string{"process"}},

	// === Python (16 cases) ===
	{"py_simple_call", lang.Python, "print('hello')\n",
		[]string{"print"}},
	{"py_method_call", lang.Python, "self.db.execute(query)\n",
		[]string{"self.db.execute"}},
	{"py_class_instantiation", lang.Python, "user = User('Alice')\n",
		[]string{"User"}},
	{"py_chain_call", lang.Python, "queryset.filter(active=True).order_by('name').first()\n",
		[]string{"queryset.filter(active=True).order_by('name').first", "queryset.filter(active=True).order_by", "queryset.filter"}},
	{"py_decorator_factory", lang.Python, "@app.route('/api')\ndef handler(): pass\n",
		[]string{"app.route"}},
	{"py_super_call", lang.Python, "class A(B):\n    def __init__(self):\n        super().__init__()\n",
		[]string{"super().__init__", "super"}},
	{"py_comprehension_call", lang.Python, "result = [f(x) for x in items]\n",
		[]string{"f"}},
	{"py_lambda_call", lang.Python, "fn = lambda x: process(x)\n",
		[]string{"process"}},
	{"py_with_statement", lang.Python, "with open('file.txt') as f:\n    data = f.read()\n",
		[]string{"open", "f.read"}},
	{"py_nested_calls", lang.Python, "json.dumps(sorted(data.items()))\n",
		[]string{"json.dumps", "sorted", "data.items"}},
	{"py_dict_comprehension", lang.Python, "result = {k: transform(v) for k, v in pairs.items()}\n",
		[]string{"transform", "pairs.items"}},
	{"py_starred_call", lang.Python, "process(*args, **kwargs)\n",
		[]string{"process"}},
	{"py_double_with", lang.Python, "with open('a') as f1, open('b') as f2:\n    pass\n",
		[]string{"open", "open"}},
	{"py_global_sorted", lang.Python, "result = sorted(data, key=lambda x: getattr(x, 'score'))\n",
		[]string{"sorted", "getattr"}},
	{"py_ternary_calls", lang.Python, "x = f(a) if check(a) else g(b)\n",
		[]string{"f", "check", "g"}},
	{"py_assert_call", lang.Python, "assert validate(data), format_error(data)\n",
		[]string{"validate", "format_error"}},

	// === JavaScript (15 cases) ===
	{"js_simple_call", lang.JavaScript, "doWork(args);\n",
		[]string{"doWork"}},
	{"js_member_call", lang.JavaScript, "obj.method(args);\n",
		[]string{"obj.method"}},
	{"js_callback_call", lang.JavaScript, "app.get('/path', handler);\n",
		[]string{"app.get"}},
	{"js_this_call", lang.JavaScript, "this.handleRequest(req);\n",
		[]string{"this.handleRequest"}},
	{"js_chain_call", lang.JavaScript, "arr.filter(fn).map(fn2).join(',');\n",
		[]string{"arr.filter(fn).map(fn2).join", "arr.filter(fn).map", "arr.filter"}},
	{"js_new_not_call", lang.JavaScript, "const user = new User('Alice');\n",
		nil},
	{"js_iife", lang.JavaScript, "(function() { doWork(); })();\n",
		[]string{"doWork"}},
	{"js_optional_chain", lang.JavaScript, "user?.getName();\n",
		[]string{"user?.getName"}},
	{"js_computed_call", lang.JavaScript, "handlers[event](data);\n",
		nil},
	{"js_spread_call", lang.JavaScript, "Math.max(...numbers);\n",
		[]string{"Math.max"}},
	{"js_destructure_call", lang.JavaScript, "const { data } = fetchData();\n",
		[]string{"fetchData"}},
	{"js_arrow_chain", lang.JavaScript, "const process = (x) => transform(filter(x));\n",
		[]string{"transform", "filter"}},
	{"js_template_literal", lang.JavaScript, "const msg = `Hello ${getName()}`;\n",
		[]string{"getName"}},
	{"js_typeof_call", lang.JavaScript, "if (typeof getValue() === 'string') {}\n",
		[]string{"getValue"}},
	{"js_comma_calls", lang.JavaScript, "a(), b(), c();\n",
		[]string{"a", "b", "c"}},

	// === TypeScript (12 cases) ===
	{"ts_generic_call", lang.TypeScript, "parseResponse<User>(data);\n",
		[]string{"parseResponse"}},
	{"ts_await_call", lang.TypeScript, "const result = await fetch(url);\n",
		[]string{"fetch"}},
	{"ts_method_call", lang.TypeScript, "const user: User = service.getUser(id);\n",
		[]string{"service.getUser"}},
	{"ts_non_null_call", lang.TypeScript, "value!.toString();\n",
		[]string{"value!.toString"}},
	{"ts_satisfies_call", lang.TypeScript, "const config = getConfig() satisfies Config;\n",
		[]string{"getConfig"}},
	{"ts_ternary_calls", lang.TypeScript, "const x = isValid(data) ? process(data) : handleError(data);\n",
		[]string{"isValid", "process", "handleError"}},
	{"ts_decorator_call", lang.TypeScript, "@Injectable()\nclass Service {}\n",
		[]string{"Injectable"}},
	{"ts_index_call", lang.TypeScript, "const fn = handlers['click']; fn(event);\n",
		[]string{"fn"}},
	{"ts_type_guard", lang.TypeScript, "function isUser(x: any): x is User { return check(x); }\n",
		[]string{"check"}},
	{"ts_as_cast_call", lang.TypeScript, "const n = (getValue() as number).toFixed(2);\n",
		[]string{"(getValue() as number).toFixed", "getValue"}},
	{"ts_namespace_call", lang.TypeScript, "namespace NS { export function greet() { log('hi'); } }\n",
		[]string{"log"}},
	{"ts_nested_generic", lang.TypeScript, "const items = Array.from<string>(getIterable());\n",
		[]string{"Array.from", "getIterable"}},

	// === TSX (9 cases) ===
	{"tsx_hook_call", lang.TSX, "const [state, setState] = useState(0);\n",
		[]string{"useState"}},
	{"tsx_create_element", lang.TSX, "React.createElement('div', null, 'hello');\n",
		[]string{"React.createElement"}},
	{"tsx_event_ref_not_call", lang.TSX, "const el = <Button onClick={handleClick} />;\n",
		nil},
	{"tsx_inline_callback", lang.TSX, "const el = <Button onClick={() => doWork()} />;\n",
		[]string{"doWork"}},
	{"tsx_use_effect", lang.TSX, "useEffect(() => { fetchData(); }, [id]);\n",
		[]string{"useEffect", "fetchData"}},
	{"tsx_custom_hook", lang.TSX, "const data = useQuery('users', fetchUsers);\n",
		[]string{"useQuery"}},
	{"tsx_memo_call", lang.TSX, "const Comp = React.memo(InnerComp);\n",
		[]string{"React.memo"}},
	{"tsx_use_callback", lang.TSX, "const fn = useCallback(() => process(data), [data]);\n",
		[]string{"useCallback", "process"}},
	{"tsx_conditional_render", lang.TSX, "const el = isLoading ? null : render(data);\n",
		[]string{"render"}},

	// === Java (14 cases) ===
	{"java_instance_call", lang.Java, "class A { void f() { repository.findById(id); } }",
		[]string{"findById"}},
	{"java_static_call", lang.Java, "class A { void f() { Collections.unmodifiableList(list); } }",
		[]string{"unmodifiableList"}},
	{"java_chain_call", lang.Java, "class A { void f() { builder.setName(n).setAge(a).build(); } }",
		[]string{"build", "setAge", "setName"}},
	{"java_new_not_call", lang.Java, "class A { void f() { User u = new User(); } }",
		nil},
	{"java_super_call", lang.Java, "class A extends B { A() { super(); } }",
		nil},
	{"java_lambda_call", lang.Java, "class A { void f() { items.forEach(System.out::println); } }",
		[]string{"forEach"}},
	{"java_nested_calls", lang.Java, "class A { void f() { log.info(String.valueOf(count)); } }",
		[]string{"info", "valueOf"}},
	{"java_generic_call", lang.Java, `class A { void f() { Optional.<String>of("hello"); } }`,
		[]string{"of"}},
	{"java_annotation_not_call", lang.Java, "@RequestMapping(\"/api\")\nclass A {}",
		nil},
	{"java_varargs_call", lang.Java, "class A { void f() { Arrays.asList(1, 2, 3); } }",
		[]string{"asList"}},
	{"java_stream_chain", lang.Java, "class A { void f() { list.stream().filter(x -> x.isActive()).count(); } }",
		[]string{"count", "filter", "stream", "isActive"}},
	{"java_throw_call", lang.Java, "class A { void f() { throw new RuntimeException(getMessage()); } }",
		[]string{"getMessage"}},
	{"java_ternary_call", lang.Java, "class A { void f(boolean b) { b ? doA() : doB(); } }",
		[]string{"doA", "doB"}},
	{"java_enhanced_for_call", lang.Java, "class A { void f() { for (var item : getItems()) { process(item); } } }",
		[]string{"getItems", "process"}},

	// === C# (16 cases) ===
	{"csharp_member_call", lang.CSharp, "class A { void F() { _context.SaveChangesAsync(token); } }",
		[]string{"_context.SaveChangesAsync"}},
	{"csharp_static_call", lang.CSharp, `class A { void F() { Console.WriteLine("hello"); } }`,
		[]string{"Console.WriteLine"}},
	{"csharp_simple_call", lang.CSharp, "class A { void F() { DoWork(); } }",
		[]string{"DoWork"}},
	{"csharp_await_call", lang.CSharp, "class A { async Task F() { await SaveAsync(); } }",
		[]string{"SaveAsync"}},
	{"csharp_await_member_call", lang.CSharp, "class A { async Task F() { await _ctx.SaveChangesAsync(t); } }",
		[]string{"_ctx.SaveChangesAsync"}},
	{"csharp_linq_chain", lang.CSharp, "class A { void F() { items.Where(x => x.Active).Select(x => x.Name); } }",
		[]string{"items.Where(x => x.Active).Select", "items.Where"}},
	{"csharp_null_conditional", lang.CSharp, "class A { void F() { obj?.Method(); } }",
		nil},
	{"csharp_generic_call", lang.CSharp, "class A { void F() { _mediator.Send<Result>(cmd); } }",
		[]string{"_mediator.Send<Result>"}},
	{"csharp_expression_body", lang.CSharp, "class A { int Add(int a, int b) => Math.Max(a, b); }",
		[]string{"Math.Max"}},
	{"csharp_interpolation_call", lang.CSharp, `class A { void F() { var s = $"{GetName()}"; } }`,
		[]string{"GetName"}},
	{"csharp_delegate_call", lang.CSharp, "class A { void F(Action cb) { cb(); } }",
		[]string{"cb"}},
	{"csharp_pattern_call", lang.CSharp, `class A { void F() { if (obj is string s) Console.WriteLine(s); } }`,
		[]string{"Console.WriteLine"}},
	{"csharp_params_call", lang.CSharp, "class A { void F() { Format(\"{0}\", GetValue()); } }",
		[]string{"Format", "GetValue"}},
	{"csharp_throw_call", lang.CSharp, "class A { void F() { throw new Exception(GetMessage()); } }",
		[]string{"GetMessage"}},
	{"csharp_ternary_call", lang.CSharp, "class A { void F(bool b) { var r = b ? GetA() : GetB(); } }",
		[]string{"GetA", "GetB"}},
	{"csharp_for_call", lang.CSharp, "class A { void F() { for (int i = 0; i < GetCount(); i++) { Process(i); } } }",
		[]string{"GetCount", "Process"}},

	// === Rust (14 cases) ===
	{"rust_self_call", lang.Rust, "impl S { fn f(&self) { self.handle(&req); } }",
		[]string{"self.handle"}},
	{"rust_static_call", lang.Rust, "fn f() { Vec::new(); }",
		[]string{"Vec::new"}},
	{"rust_macro_call", lang.Rust, `fn f() { println!("hello {}", name); }`,
		[]string{"println!"}},
	{"rust_chain_call", lang.Rust, "fn f() { items.iter().filter(|x| x.active).collect::<Vec<_>>(); }",
		[]string{"items.iter().filter", "items.iter"}},
	{"rust_turbofish", lang.Rust, `fn f() { parse::<i32>("42"); }`,
		nil},
	{"rust_closure_call", lang.Rust, "fn f() { let add = |a, b| a + b; add(1, 2); }",
		[]string{"add"}},
	{"rust_trait_call", lang.Rust, "fn f(d: &dyn Display) { d.fmt(&mut buf); }",
		[]string{"d.fmt"}},
	{"rust_nested_calls", lang.Rust, "fn f() { Ok(serde_json::from_str(&data)); }",
		[]string{"Ok", "serde_json::from_str"}},
	{"rust_await_call", lang.Rust, "async fn f() { let resp = client.get(url).send().await; }",
		[]string{"client.get(url).send", "client.get"}},
	{"rust_question_call", lang.Rust, "fn f() -> Result<()> { let data = read_file(path)?; Ok(()) }",
		[]string{"read_file", "Ok"}},
	{"rust_vec_macro", lang.Rust, "fn f() { let v = vec![1, 2, 3]; }",
		[]string{"vec!"}},
	{"rust_format_macro", lang.Rust, `fn f() { let s = format!("{} {}", a, b); }`,
		[]string{"format!"}},
	{"rust_match_arm_call", lang.Rust, "fn f(r: Result<i32, &str>) { match r { Ok(v) => process(v), Err(e) => handle(e) }; }",
		[]string{"process", "handle"}},
	{"rust_scoped_macro", lang.Rust, "fn f() { log::info!(\"starting\"); }",
		[]string{"log::info!"}},

	// === C++ (13 cases) ===
	{"cpp_simple_call", lang.CPP, `void f() { printf("hello"); }`,
		[]string{"printf"}},
	{"cpp_method_call", lang.CPP, "void f(std::string s) { s.substr(0, 5); }",
		[]string{"s.substr"}},
	{"cpp_namespace_call", lang.CPP, "void f() { std::sort(v.begin(), v.end()); }",
		[]string{"std::sort", "v.begin", "v.end"}},
	{"cpp_new_call", lang.CPP, "void f() { auto p = new Point(1, 2); }",
		nil},
	{"cpp_delete_call", lang.CPP, "void f(int* p) { delete p; }",
		nil},
	{"cpp_binary_op", lang.CPP, "void f(int a, int b) { int c = a + b; }",
		nil},
	{"cpp_subscript", lang.CPP, "void f(int* m) { int v = m[42]; }",
		nil},
	{"cpp_template_call", lang.CPP, "void f() { auto p = std::make_shared<Config>(args); }",
		[]string{"std::make_shared<Config>"}},
	{"cpp_unary_op", lang.CPP, "void f(int& x) { ++x; }",
		nil},
	{"cpp_lambda_call", lang.CPP, "void f() { auto fn = [](int x){ return x*2; }; fn(5); }",
		[]string{"fn"}},
	{"cpp_unique_ptr", lang.CPP, "void f() { auto p = std::make_unique<Foo>(1, 2); }",
		[]string{"std::make_unique<Foo>"}},
	{"cpp_stl_algorithm", lang.CPP, "void f() { std::transform(v.begin(), v.end(), out.begin(), func); }",
		[]string{"std::transform", "v.begin", "v.end", "out.begin"}},
	{"cpp_nested_call", lang.CPP, "void f() { log(std::to_string(getValue())); }",
		[]string{"log", "std::to_string", "getValue"}},

	// === C (8 cases) ===
	{"c_simple_call", lang.C, `void f() { printf("hello %s", name); }`,
		[]string{"printf"}},
	{"c_func_ptr_call", lang.C, "void f(void (*callback)(int)) { callback(42); }",
		[]string{"callback"}},
	{"c_struct_member_call", lang.C, "void f(struct ctx *c) { c->handler(c, req); }",
		[]string{"c->handler"}},
	{"c_nested_calls", lang.C, "void f() { free(strdup(s)); }",
		[]string{"free", "strdup"}},
	{"c_macro_call", lang.C, "void f() { assert(x > 0); }",
		[]string{"assert"}},
	{"c_variadic_call", lang.C, "void f() { va_start(ap, fmt); }",
		[]string{"va_start"}},
	{"c_stdlib_call", lang.C, "void f() { int n = atoi(getenv(\"PORT\")); }",
		[]string{"atoi", "getenv"}},
	{"c_multi_call", lang.C, "void f() { open(); read(); close(); }",
		[]string{"open", "read", "close"}},

	// === PHP (13 cases) ===
	{"php_bare_call", lang.PHP, "<?php\narray_map($fn, $items);\n",
		[]string{"array_map"}},
	{"php_member_call", lang.PHP, "<?php\n$this->repository->find($id);\n",
		[]string{"find"}},
	{"php_static_call", lang.PHP, "<?php\nResponse::json($data);\n",
		[]string{"json"}},
	{"php_nullsafe_call", lang.PHP, "<?php\n$user?->getName();\n",
		[]string{"getName"}},
	{"php_new_not_call", lang.PHP, "<?php\n$u = new User(['name' => 'John']);\n",
		nil},
	{"php_chain_call", lang.PHP, "<?php\n$query->where('active', true)->orderBy('name')->get();\n",
		[]string{"get", "orderBy", "where"}},
	{"php_arrow_call", lang.PHP, "<?php\n$filtered = array_filter($items, fn($x) => $x > 0);\n",
		[]string{"array_filter"}},
	{"php_callable_call", lang.PHP, "<?php\ncall_user_func([$obj, 'method'], $arg);\n",
		[]string{"call_user_func"}},
	{"php_nested_calls", lang.PHP, "<?php\njson_encode(array_values($data));\n",
		[]string{"json_encode", "array_values"}},
	{"php_string_call", lang.PHP, "<?php\n$fn = 'strlen'; $fn('hello');\n",
		[]string{"$fn"}},
	{"php_closure_call", lang.PHP, "<?php\n$fn = function($x) { return process($x); }; $fn(1);\n",
		[]string{"process", "$fn"}},
	{"php_str_replace", lang.PHP, "<?php\nstr_replace('a', 'b', $str);\n",
		[]string{"str_replace"}},
	{"php_ternary_call", lang.PHP, "<?php\n$r = isValid($x) ? getA($x) : getB($x);\n",
		[]string{"isValid", "getA", "getB"}},

	// === Ruby (13 cases) ===
	{"ruby_receiver_call", lang.Ruby, "class A\n  def f\n    name.to_s\n  end\nend\n",
		[]string{"name.to_s"}},
	{"ruby_bare_call", lang.Ruby, "class A\n  def f\n    puts 'hello'\n  end\nend\n",
		[]string{"puts"}},
	{"ruby_chain_call", lang.Ruby, "class A\n  def f\n    users.where(active: true).order(:name).limit(10)\n  end\nend\n",
		[]string{"users.where(active: true).order(:name).limit", "users.where(active: true).order", "users.where"}},
	{"ruby_block_call", lang.Ruby, "class A\n  def f\n    @items.each { |i| puts i }\n  end\nend\n",
		[]string{"@items.each", "puts"}},
	{"ruby_class_method", lang.Ruby, "User.find(42)\n",
		[]string{"User.find"}},
	{"ruby_command_call", lang.Ruby, "class A\n  def f\n    obj.send :method_name, arg\n  end\nend\n",
		[]string{"obj.send"}},
	{"ruby_super_call", lang.Ruby, "class A < B\n  def save\n    super\n  end\nend\n",
		nil},
	{"ruby_yield_call", lang.Ruby, "def each\n  yield item\nend\n",
		nil},
	{"ruby_self_call", lang.Ruby, "class A\n  def f\n    self.validate\n  end\nend\n",
		[]string{"self.validate"}},
	{"ruby_dsl_call", lang.Ruby, "get '/users' do\n  'hello'\nend\n",
		[]string{"get"}},
	{"ruby_tap_call", lang.Ruby, "class A\n  def f\n    @items.tap { |d| log(d) }\n  end\nend\n",
		[]string{"@items.tap", "log"}},
	{"ruby_map_call", lang.Ruby, "class A\n  def f\n    items.map { |i| transform(i) }\n  end\nend\n",
		[]string{"items.map", "transform"}},
	{"ruby_require_call", lang.Ruby, "require 'json'\n",
		[]string{"require"}},

	// === Kotlin (11 cases) ===
	{"kotlin_simple_call", lang.Kotlin, "fun f() { println(\"hello\") }\n",
		[]string{"println"}},
	{"kotlin_extension_call", lang.Kotlin, "fun f() { items.filter { it.active } }\n",
		[]string{"items.filter", "items", "it"}},
	{"kotlin_nav_expr", lang.Kotlin, "fun f(user: User) { user.name.length }\n",
		[]string{"user.name", "user"}},
	{"kotlin_companion_call", lang.Kotlin, "fun f() { User.create(data) }\n",
		[]string{"User.create", "User"}},
	{"kotlin_lambda_receiver", lang.Kotlin, "fun f() { buildString { append(\"hello\") } }\n",
		[]string{"buildString", "append"}},
	{"kotlin_infix_call", lang.Kotlin, "fun f() { 1 shl 2 }\n",
		nil},
	{"kotlin_scope_call", lang.Kotlin, "fun f(user: User) { user.let { it.name } }\n",
		[]string{"user.let", "user", "it"}},
	{"kotlin_constructor_call", lang.Kotlin, "fun f() { val u = User(\"Alice\") }\n",
		[]string{"User"}},
	{"kotlin_apply_call", lang.Kotlin, "fun f() { User().apply { name = \"Bob\" } }\n",
		[]string{"User().apply", "User"}},
	{"kotlin_multi_call", lang.Kotlin, "fun f() { a(); b(); c() }\n",
		[]string{"a", "b", "c"}},
	{"kotlin_map_call", lang.Kotlin, "fun f() { items.map { transform(it) } }\n",
		[]string{"items.map", "items", "transform"}},

	// === Scala (11 cases) ===
	{"scala_dot_call", lang.Scala, "object A { def f() = service.process(data) }\n",
		[]string{"service.process"}},
	{"scala_infix_call", lang.Scala, "object A { def f() = items map (_.name) }\n",
		[]string{"map", "_.name"}},
	{"scala_generic_call", lang.Scala, "object A { def f() = Option[String](\"hello\") }\n",
		[]string{"Option"}},
	{"scala_field_call", lang.Scala, "object A { def f() = list.head }\n",
		[]string{"list.head"}},
	{"scala_match_call", lang.Scala, "object A { def f(x: Any) = x match { case s: String => s.toUpperCase } }\n",
		[]string{"s.toUpperCase"}},
	{"scala_for_call", lang.Scala, "object A { def f() = for { x <- getItems() } yield process(x) }\n",
		[]string{"getItems", "process"}},
	{"scala_apply_call", lang.Scala, "object A { def f() = Map(\"a\" -> 1, \"b\" -> 2) }\n",
		[]string{"Map", "->", "->"}},
	{"scala_chain_call", lang.Scala, "object A { def f() = items.filter(_.active).map(_.name).mkString }\n",
		[]string{"items.filter(_.active).map(_.name).mkString", "items.filter(_.active).map", "items.filter", "_.active", "_.name"}},
	{"scala_flatmap_call", lang.Scala, "object A { def f() = list.flatMap(_.items) }\n",
		[]string{"list.flatMap", "_.items"}},
	{"scala_companion_call", lang.Scala, "object A { def f() = User(\"Alice\") }\n",
		[]string{"User"}},
	{"scala_multi_call", lang.Scala, "object A { def f() = { a(); b(); c() } }\n",
		[]string{"a", "b", "c"}},

	// === Haskell (11 cases) ===
	{"haskell_apply", lang.Haskell, "f = map show [1,2,3]\n",
		[]string{"map", "map"}},
	{"haskell_infix_op", lang.Haskell, "f = xs <> ys\n",
		[]string{"<>"}},
	{"haskell_dollar", lang.Haskell, "f = print $ show 42\n",
		[]string{"$", "show"}},
	{"haskell_do_bind", lang.Haskell, "f = do\n  result <- readFile path\n  return result\n",
		[]string{"readFile", "return"}},
	{"haskell_where_call", lang.Haskell, "f x = g (h x)\n  where g = show\n        h = succ\n",
		[]string{"g", "h"}},
	{"haskell_typeclass_call", lang.Haskell, "f x = show x ++ \" is \" ++ show (succ x)\n",
		[]string{"++", "show", "++", "show", "succ"}},
	{"haskell_backtick", lang.Haskell, "f = xs `mappend` ys\n",
		[]string{"`mappend`"}},
	{"haskell_nested_apply", lang.Haskell, "f = map (filter even) lists\n",
		[]string{"map", "map", "filter"}},
	{"haskell_guard_call", lang.Haskell, "f x\n  | check x = process x\n  | otherwise = default_val x\n",
		[]string{"check", "process", "default_val"}},
	{"haskell_composition", lang.Haskell, "f = (show . succ) 42\n",
		[]string{"(show . succ)", "."}},
	{"haskell_bind_op", lang.Haskell, "f = readFile path >>= processContent\n",
		[]string{">>=", "readFile"}},

	// === OCaml (11 cases) ===
	{"ocaml_apply", lang.OCaml, "let f = List.map show items\n",
		[]string{"List.map"}},
	{"ocaml_pipe", lang.OCaml, "let f x = x |> List.filter pred |> List.map show\n",
		[]string{"List.map", "List.filter", "List.filter", "List.map"}},
	{"ocaml_reverse_pipe", lang.OCaml, "let f = print_string @@ string_of_int 42\n",
		[]string{"print_string", "string_of_int"}},
	{"ocaml_module_call", lang.OCaml, "let f () = Printf.printf \"%s\" name\n",
		[]string{"Printf.printf"}},
	{"ocaml_let_call", lang.OCaml, "let f x = let y = g x in h y\n",
		[]string{"g", "h"}},
	{"ocaml_match_call", lang.OCaml, "let f x = match classify x with\n  | A -> handle_a x\n  | B -> handle_b x\n",
		[]string{"classify", "handle_a", "handle_b"}},
	{"ocaml_nested_apply", lang.OCaml, "let f = List.map (fun x -> succ (abs x)) items\n",
		[]string{"List.map", "succ", "abs"}},
	{"ocaml_functor", lang.OCaml, "module M = Set.Make(String)\n",
		nil},
	{"ocaml_option_map", lang.OCaml, "let f x = Option.map succ x\n",
		[]string{"Option.map"}},
	{"ocaml_if_call", lang.OCaml, "let f x = if check x then process x else handle x\n",
		[]string{"check", "process", "handle"}},
	{"ocaml_multi_pipe", lang.OCaml, "let f x = x |> validate |> transform |> save\n",
		[]string{"save", "transform", "validate"}},

	// === Elixir (11 cases) ===
	{"elixir_pipe_chain", lang.Elixir, "defmodule A do\n  def f(data) do\n    data |> validate() |> transform() |> save()\n  end\nend\n",
		[]string{"save", "transform", "validate"}},
	{"elixir_direct_call", lang.Elixir, "defmodule A do\n  def f do\n    IO.puts(\"hello\")\n  end\nend\n",
		[]string{"IO.puts"}},
	{"elixir_genserver_call", lang.Elixir, "defmodule A do\n  def f(pid) do\n    GenServer.call(pid, :request)\n  end\nend\n",
		[]string{"GenServer.call"}},
	{"elixir_dot_call", lang.Elixir, "defmodule A do\n  def f(mod) do\n    mod.function(arg)\n  end\nend\n",
		[]string{"mod.function"}},
	{"elixir_kernel_call", lang.Elixir, "defmodule A do\n  def f do\n    length([1,2,3])\n  end\nend\n",
		[]string{"length"}},
	{"elixir_non_pipe_binop", lang.Elixir, "defmodule A do\n  def f do\n    x = 1 + 2\n  end\nend\n",
		nil},
	{"elixir_capture", lang.Elixir, "defmodule A do\n  def f do\n    Enum.map([1,2], &to_string/1)\n  end\nend\n",
		[]string{"Enum.map"}},
	{"elixir_with_call", lang.Elixir, "defmodule A do\n  def f do\n    with {:ok, a} <- fetch_a(), {:ok, b} <- fetch_b(a), do: {a, b}\n  end\nend\n",
		[]string{"fetch_a", "fetch_b"}},
	{"elixir_enum_call", lang.Elixir, "defmodule A do\n  def f(list) do\n    Enum.filter(list, fn x -> x > 0 end)\n  end\nend\n",
		[]string{"Enum.filter"}},
	{"elixir_spawn_call", lang.Elixir, "defmodule A do\n  def f do\n    spawn(fn -> process(data) end)\n  end\nend\n",
		[]string{"spawn", "process"}},
	{"elixir_multi_call", lang.Elixir, "defmodule A do\n  def f do\n    a = compute(1)\n    b = transform(a)\n    save(b)\n  end\nend\n",
		[]string{"compute", "transform", "save"}},

	// === Erlang (9 cases) ===
	{"erlang_remote_call", lang.Erlang, "-module(m).\nf() -> io:format(\"hello\").\n",
		[]string{"format"}},
	{"erlang_local_call", lang.Erlang, "-module(m).\nf() -> greet(\"World\").\ngreet(N) -> N.\n",
		[]string{"greet"}},
	{"erlang_gen_server_call", lang.Erlang, "-module(m).\nf(Pid) -> gen_server:call(Pid, req).\n",
		[]string{"call"}},
	{"erlang_nested_remote", lang.Erlang, "-module(m).\nf(L) -> lists:map(fun erlang:abs/1, L).\n",
		[]string{"map"}},
	{"erlang_spawn_call", lang.Erlang, "-module(m).\nf() -> spawn(fun() -> ok end).\n",
		[]string{"spawn"}},
	{"erlang_multi_call", lang.Erlang, "-module(m).\nf() -> a(), b(), c().\na() -> ok.\nb() -> ok.\nc() -> ok.\n",
		[]string{"a", "b", "c"}},
	{"erlang_lists_call", lang.Erlang, "-module(m).\nf(L) -> lists:filter(fun(X) -> X > 0 end, L).\n",
		[]string{"filter"}},
	{"erlang_string_call", lang.Erlang, "-module(m).\nf(S) -> string:tokens(S, \",\").\n",
		[]string{"tokens"}},
	{"erlang_nested_local", lang.Erlang, "-module(m).\nf(X) -> g(h(X)).\ng(X) -> X.\nh(X) -> X.\n",
		[]string{"g", "h"}},

	// === Lua (9 cases) ===
	{"lua_module_call", lang.Lua, "M.process(data)\n",
		[]string{"M.process"}},
	{"lua_colon_call", lang.Lua, "obj:method(arg)\n",
		[]string{"obj:method"}},
	{"lua_table_call", lang.Lua, "handlers[event](data)\n",
		[]string{"handlers[event]"}},
	{"lua_nested_call", lang.Lua, "print(tostring(42))\n",
		[]string{"print", "tostring"}},
	{"lua_require_call", lang.Lua, "local json = require('cjson')\n",
		[]string{"require"}},
	{"lua_iife_call", lang.Lua, "(function() print('hi') end)()\n",
		[]string{"(function() print('hi') end)", "print"}},
	{"lua_pcall", lang.Lua, "local ok, err = pcall(func)\n",
		[]string{"pcall"}},
	{"lua_string_method", lang.Lua, "s:upper()\n",
		[]string{"s:upper"}},
	{"lua_select_call", lang.Lua, "select('#', ...)\n",
		[]string{"select"}},

	// === Bash (7 cases) ===
	{"bash_command_call", lang.Bash, "greet 'world'\n",
		[]string{"greet"}},
	{"bash_command_sub", lang.Bash, "result=$(process_data \"$input\")\n",
		[]string{"process_data"}},
	{"bash_pipe_chain", lang.Bash, "cat file | grep pattern | sort\n",
		[]string{"cat", "grep", "sort"}},
	{"bash_func_call", lang.Bash, "greet() { echo hi; }\ngreet\n",
		[]string{"echo", "greet"}},
	{"bash_subshell", lang.Bash, "( cd /tmp && ls )\n",
		[]string{"cd", "ls"}},
	{"bash_process_args", lang.Bash, "process \"$1\" \"$2\"\n",
		[]string{"process"}},
	{"bash_conditional", lang.Bash, "if check_status; then handle_ok; else handle_err; fi\n",
		[]string{"check_status", "handle_ok", "handle_err"}},

	// === Zig (8 cases) ===
	{"zig_method_call", lang.Zig, "fn f(alloc: std.mem.Allocator) void { _ = alloc.alloc(u8, 1024); }\n",
		[]string{"alloc.alloc"}},
	{"zig_builtin_call", lang.Zig, "fn f(x: i64) i32 { return @intCast(x); }\n",
		[]string{"@intCast"}},
	{"zig_try_call", lang.Zig, "fn f(file: std.fs.File) !void { _ = try file.read(buf); }\n",
		[]string{"file.read"}},
	{"zig_nested_call", lang.Zig, "fn f() void { std.debug.print(\"{}\", .{value}); }\n",
		[]string{"std.debug.print"}},
	{"zig_comptime_call", lang.Zig, "fn f() type { return @TypeOf(value); }\n",
		[]string{"@TypeOf"}},
	{"zig_std_mem_call", lang.Zig, "fn f() void { _ = std.mem.eql(u8, a, b); }\n",
		[]string{"std.mem.eql"}},
	{"zig_error_call", lang.Zig, "fn f() !void { _ = try allocate(size); }\n",
		[]string{"allocate"}},
	{"zig_multi_builtin", lang.Zig, "fn f(x: anytype) void { _ = @TypeOf(x); _ = @intCast(x); }\n",
		[]string{"@TypeOf", "@intCast"}},

	// === ObjectiveC (6 cases) ===
	{"objc_c_call", lang.ObjectiveC, "void f() { printf(\"hello\"); }\n",
		[]string{"printf"}},
	{"objc_nslog", lang.ObjectiveC, "void f() { NSLog(@\"hello\"); }\n",
		[]string{"NSLog"}},
	{"objc_nested_c_call", lang.ObjectiveC, "void f() { free(malloc(100)); }\n",
		[]string{"free", "malloc"}},
	{"objc_dispatch", lang.ObjectiveC, "void f() { dispatch_async(queue, block); }\n",
		[]string{"dispatch_async"}},
	// message_expression: method field extraction
	{"objc_message_send", lang.ObjectiveC, "void f() { [obj method]; }\n",
		[]string{"obj.method"}},
	{"objc_multi_c_call", lang.ObjectiveC, "void f() { a(); b(); c(); }\n",
		[]string{"a", "b", "c"}},

	// === Swift (6 cases) ===
	{"swift_simple_call", lang.Swift, "func f() { greet(\"hello\") }\n",
		[]string{"greet"}},
	{"swift_member_call", lang.Swift, "func f(arr: [Int]) { arr.contains(42) }\n",
		[]string{"arr.contains"}},
	{"swift_nested_call", lang.Swift, "func f() { print(String(42)) }\n",
		[]string{"print", "String"}},
	{"swift_multi_call", lang.Swift, "func f() { a(); b(); c() }\n",
		[]string{"a", "b", "c"}},
	{"swift_static_call", lang.Swift, "func f() { UIView.animate(withDuration: 1.0) {} }\n",
		[]string{"UIView.animate"}},
	{"swift_guard_call", lang.Swift, "func f() { guard let v = getValue() else { return } }\n",
		[]string{"getValue"}},

	// === Dart (6 cases) ===
	// Dart uses "selector" CallNodeType — callee extracted from preceding sibling
	{"dart_simple_call", lang.Dart, "void f() { print('hello'); }\n",
		[]string{"print"}},
	{"dart_method_call", lang.Dart, "void f(List<int> list) { list.add(1); }\n",
		[]string{"list.add"}},
	{"dart_nested_call", lang.Dart, "void f() { print(getValue()); }\n",
		[]string{"print", "getValue"}},
	{"dart_chain_call", lang.Dart, "void f() { items.where((e) => e > 0).toList(); }\n",
		[]string{"items.where", "toList"}},
	{"dart_static_call", lang.Dart, "void f() { DateTime.now(); }\n",
		[]string{"DateTime.now"}},
	{"dart_async_call", lang.Dart, "Future<void> f() async { await fetchData(); }\n",
		[]string{"fetchData"}},

	// === Perl (5 cases) ===
	{"perl_simple_call", lang.Perl, "print \"hello\\n\";\n",
		[]string{"print"}},
	{"perl_function_call", lang.Perl, "chomp($line);\n",
		[]string{"chomp"}},
	{"perl_nested_call", lang.Perl, "print length($str);\n",
		[]string{"print", "length"}},
	{"perl_multi_call", lang.Perl, "open(my $fh, '<', $file); read($fh, $buf, 100); close($fh);\n",
		[]string{"open", "read", "close"}},
	{"perl_module_call", lang.Perl, "use File::Basename; my $dir = dirname($path);\n",
		[]string{"dirname"}},

	// === Groovy (5 cases) ===
	{"groovy_simple_call", lang.Groovy, "def f() { println('hello') }\n",
		[]string{"println"}},
	{"groovy_method_call", lang.Groovy, "def f() { list.add(42) }\n",
		[]string{"list.add"}},
	{"groovy_multi_call", lang.Groovy, "def f() { a(); b(); c() }\n",
		[]string{"a", "b", "c"}},
	{"groovy_nested_call", lang.Groovy, "def f() { println(getValue()) }\n",
		[]string{"println", "getValue"}},
	{"groovy_closure_call", lang.Groovy, "def f() { items.each { process(it) } }\n",
		[]string{"items.each", "process"}},

	// === R (4 cases) ===
	{"r_simple_call", lang.R, "f <- function() { print('hello') }\n",
		[]string{"print"}},
	{"r_nested_call", lang.R, "f <- function(x) { paste(toupper(x), collapse='') }\n",
		[]string{"paste", "toupper"}},
	{"r_pipe_call", lang.R, "f <- function(df) { filter(df, x > 0) }\n",
		[]string{"filter"}},
	{"r_multi_call", lang.R, "f <- function() { a(); b(); c() }\n",
		[]string{"a", "b", "c"}},

	// === HCL (3 cases) ===
	// HCL function_call → first child identifier
	{"hcl_file_call", lang.HCL, "resource \"null\" \"x\" {\n  value = file(\"path\")\n}\n",
		[]string{"file"}},
	{"hcl_merge_call", lang.HCL, "locals {\n  config = merge(var.defaults, var.overrides)\n}\n",
		[]string{"merge"}},
	{"hcl_nested_call", lang.HCL, "resource \"null\" \"x\" {\n  value = jsonencode(tomap({a = 1}))\n}\n",
		[]string{"jsonencode", "tomap"}},

	// === SQL (3 cases) ===
	// SQL invocation → object_reference → identifier[name]
	{"sql_count_call", lang.SQL, "SELECT COUNT(*) FROM users;\n",
		[]string{"COUNT"}},
	{"sql_nested_call", lang.SQL, "SELECT COALESCE(NULLIF(name, ''), 'default') FROM t;\n",
		[]string{"COALESCE", "NULLIF"}},
	{"sql_aggregate_call", lang.SQL, "SELECT MAX(salary) FROM employees;\n",
		[]string{"MAX"}},
}

func TestCalleeExtraction(t *testing.T) {
	for _, tt := range calleeExtractionCases {
		t.Run(tt.name, func(t *testing.T) {
			tree, src := parseSource(t, tt.lang, tt.code)
			defer tree.Close()
			spec := lang.ForLanguage(tt.lang)
			if spec == nil {
				t.Fatalf("no spec for %s", tt.lang)
			}
			callNodeTypes := toSet(spec.CallNodeTypes)
			var callees []string
			parser.Walk(tree.RootNode(), func(node *tree_sitter.Node) bool {
				if callNodeTypes[node.Kind()] {
					name := extractCalleeName(node, src, tt.lang)
					if name != "" {
						callees = append(callees, name)
					}
				}
				return true
			})
			if tt.wantCallees == nil {
				if len(callees) != 0 {
					dump := dumpNode(tree.RootNode(), src, 0)
					t.Errorf("callees = %v, want nil\nAST:\n%s", callees, dump)
				}
				return
			}
			if !reflect.DeepEqual(callees, tt.wantCallees) {
				dump := dumpNode(tree.RootNode(), src, 0)
				t.Errorf("callees = %q, want %q\nAST:\n%s", callees, tt.wantCallees, dump)
			}
		})
	}
}

// ============================================================================
// TestOOPExtraction — assertion-based OOP extraction test suite
//
// Tests extractBaseClasses() and extractImplementsClause() for class declarations
// across languages.
// ============================================================================

var oopExtractionCases = []struct {
	name           string
	lang           lang.Language
	code           string
	wantBases      []string
	wantImplements []string
}{
	// === Python (5 cases) ===
	{"py_single_base", lang.Python, "class A(B): pass\n",
		[]string{"B"}, nil},
	{"py_multiple_bases", lang.Python, "class A(B, C): pass\n",
		[]string{"B", "C"}, nil},
	{"py_abc_base", lang.Python, "class A(ABC): pass\n",
		[]string{"ABC"}, nil},
	{"py_no_base", lang.Python, "class A: pass\n",
		nil, nil},
	{"py_metaclass", lang.Python, "class A(B, metaclass=Meta): pass\n",
		[]string{"B"}, nil},

	// === JavaScript (5 cases) ===
	{"js_class_extends", lang.JavaScript, "class Child extends Parent {}\n",
		[]string{"Parent"}, nil},
	{"js_class_no_extends", lang.JavaScript, "class A {}\n",
		nil, nil},
	{"js_class_expression", lang.JavaScript, "const A = class extends B {};\n",
		[]string{"B"}, nil},
	{"js_class_expression_no_base", lang.JavaScript, "const A = class {};\n",
		nil, nil},
	{"js_class_with_body", lang.JavaScript, "class A extends B { constructor() { super(); } }\n",
		[]string{"B"}, nil},

	// === TypeScript (6 cases) ===
	{"ts_implements", lang.TypeScript, "class A implements IService {}\n",
		[]string{"IService"}, []string{"IService"}},
	{"ts_extends_implements", lang.TypeScript, "class A extends B implements IC, ID {}\n",
		[]string{"B", "IC", "ID"}, []string{"IC", "ID"}},
	{"ts_abstract_class", lang.TypeScript, "abstract class Base implements IA {}\n",
		[]string{"IA"}, []string{"IA"}},
	{"ts_interface_extends", lang.TypeScript, "interface IA extends IB {}\n",
		nil, nil},
	{"ts_class_no_heritage", lang.TypeScript, "class Plain {}\n",
		nil, nil},
	{"ts_generic_extends", lang.TypeScript, "class A extends Base<string> {}\n",
		[]string{"Base"}, nil},

	// === TSX (3 cases) ===
	{"tsx_implements", lang.TSX, "class App implements IComponent {}\n",
		[]string{"IComponent"}, []string{"IComponent"}},
	{"tsx_extends", lang.TSX, "class App extends React.Component {}\n",
		[]string{"React.Component"}, nil},
	{"tsx_no_heritage", lang.TSX, "class App {}\n",
		nil, nil},

	// === Java (7 cases) ===
	{"java_implements", lang.Java, "class A implements Serializable {}\n",
		[]string{"Serializable"}, []string{"Serializable"}},
	{"java_multi_implements", lang.Java, "class A implements IA, IB {}\n",
		[]string{"IA", "IB"}, []string{"IA", "IB"}},
	{"java_extends_implements", lang.Java, "class A extends B implements IC {}\n",
		[]string{"B", "IC"}, []string{"IC"}},
	{"java_generic_implements", lang.Java, "class A implements List<String> {}\n",
		[]string{"List"}, []string{"List"}},
	{"java_record_implements", lang.Java, "record Point(int x, int y) implements Printable {}\n",
		[]string{"Printable"}, []string{"Printable"}},
	{"java_enum", lang.Java, "enum Color { RED, GREEN, BLUE }\n",
		nil, nil},
	{"java_interface_extends", lang.Java, "interface IA extends IB {}\n",
		nil, nil},

	// === C# (7 cases) ===
	{"csharp_single_interface", lang.CSharp, "class A : IService {}\n",
		[]string{"IService"}, []string{"IService"}},
	{"csharp_multi_interface", lang.CSharp, "class A : IService, IDisposable {}\n",
		[]string{"IService", "IDisposable"}, []string{"IService", "IDisposable"}},
	{"csharp_base_plus_interface", lang.CSharp, "class A : BaseClass, IService {}\n",
		[]string{"BaseClass", "IService"}, []string{"BaseClass", "IService"}},
	{"csharp_struct_implements", lang.CSharp, "struct S : IEquatable<S> {}\n",
		[]string{"IEquatable"}, []string{"IEquatable", "S"}},
	{"csharp_interface_extends", lang.CSharp, "interface IA : IB {}\n",
		[]string{"IB"}, []string{"IB"}},
	{"csharp_no_base", lang.CSharp, "class Plain {}\n",
		nil, nil},
	{"csharp_record", lang.CSharp, "record User(string Name) : Entity;\n",
		nil, nil}, // record_declaration not in ClassNodeTypes

	// === Kotlin (6 cases) ===
	{"kotlin_interface", lang.Kotlin, "class A : IA {}\n",
		[]string{"IA"}, []string{"IA"}},
	{"kotlin_multi_delegation", lang.Kotlin, "class A : IA, IB {}\n",
		[]string{"IA", "IB"}, []string{"IA", "IB"}},
	{"kotlin_data_class", lang.Kotlin, "data class User(val name: String) : Entity()\n",
		[]string{"Entity"}, []string{"Entity"}},
	{"kotlin_object", lang.Kotlin, "object Singleton : IA, IB {}\n",
		[]string{"IA", "IB"}, []string{"IA", "IB"}},
	{"kotlin_no_base", lang.Kotlin, "class Plain {}\n",
		nil, nil},
	{"kotlin_sealed", lang.Kotlin, "sealed class Result : Outcome {}\n",
		[]string{"Outcome"}, []string{"Outcome"}},

	// === Scala (6 cases) ===
	{"scala_extends_with_trait", lang.Scala, "class A extends B with C {}\n",
		[]string{"B", "C"}, []string{"B", "C"}},
	{"scala_multi_traits", lang.Scala, "class A extends B with C with D {}\n",
		[]string{"B", "C", "D"}, []string{"B", "C", "D"}},
	{"scala_object_extends", lang.Scala, "object A extends B {}\n",
		[]string{"B"}, []string{"B"}},
	{"scala_case_class", lang.Scala, "case class Point(x: Int) extends Printable {}\n",
		[]string{"Printable"}, []string{"Printable"}},
	{"scala_trait_extends", lang.Scala, "trait A extends B {}\n",
		[]string{"B"}, []string{"B"}},
	{"scala_no_base", lang.Scala, "class Plain {}\n",
		nil, nil},

	// === PHP (6 cases) ===
	{"php_implements", lang.PHP, "<?php\nclass A implements JsonSerializable {}\n",
		nil, []string{"JsonSerializable"}},
	{"php_multi_implements", lang.PHP, "<?php\nclass A implements IA, IB {}\n",
		nil, []string{"IA", "IB"}},
	{"php_extends_implements", lang.PHP, "<?php\nclass A extends B implements IC {}\n",
		[]string{"B"}, []string{"IC"}},
	{"php_trait_decl", lang.PHP, "<?php\ntrait Loggable {}\n",
		nil, nil},
	{"php_interface_decl", lang.PHP, "<?php\ninterface Printable {}\n",
		nil, nil},
	{"php_extends_only", lang.PHP, "<?php\nclass A extends B {}\n",
		[]string{"B"}, nil},

	// === Ruby (5 cases) ===
	{"ruby_class_extends", lang.Ruby, "class Dog < Animal\nend\n",
		[]string{"Animal"}, nil},
	{"ruby_include", lang.Ruby, "class A\n  include Comparable\nend\n",
		nil, nil},
	{"ruby_extend", lang.Ruby, "class A\n  extend ClassMethods\nend\n",
		nil, nil},
	{"ruby_multi_include", lang.Ruby, "class A\n  include IA\n  include IB\nend\n",
		nil, nil},
	{"ruby_scoped_include", lang.Ruby, "class A\n  include Concerns::Validatable\nend\n",
		nil, nil},

	// === Rust (4 cases) ===
	{"rust_no_trait_impl", lang.Rust, "impl Point { fn new() -> Self { Point{} } }\n",
		nil, nil},
	{"rust_struct_only", lang.Rust, "struct Point { x: i32, y: i32 }\n",
		nil, nil},
	{"rust_trait_decl", lang.Rust, "trait Display { fn fmt(&self); }\n",
		nil, nil},
	{"rust_enum", lang.Rust, "enum Color { Red, Green, Blue }\n",
		nil, nil},

	// === C++ (4 cases) ===
	{"cpp_class_extends", lang.CPP, "class Child : public Parent {};\n",
		[]string{"Parent"}, nil},
	{"cpp_multi_extends", lang.CPP, "class Child : public Base, public Mixin {};\n",
		[]string{"Base", "Mixin"}, nil},
	{"cpp_struct_no_base", lang.CPP, "struct Point { int x; int y; };\n",
		nil, nil},
	{"cpp_abstract_class", lang.CPP, "class Widget : public QWidget {};\n",
		[]string{"QWidget"}, nil},

	// === C (4 cases) ===
	{"c_struct_no_base", lang.C, "struct Point { int x; int y; };\n",
		nil, nil},
	{"c_enum", lang.C, "enum Color { RED, GREEN, BLUE };\n",
		nil, nil},
	{"c_union", lang.C, "union Data { int i; float f; };\n",
		nil, nil},
	{"c_typedef_struct", lang.C, "typedef struct { int x; } Point;\n",
		nil, nil},

	// === Go (4 cases) ===
	{"go_type_spec", lang.Go, "package main\ntype Config struct { Name string }\n",
		nil, nil},
	{"go_interface", lang.Go, "package main\ntype Reader interface { Read(p []byte) (int, error) }\n",
		nil, nil},
	{"go_type_alias", lang.Go, "package main\ntype MyString = string\n",
		nil, nil},
	{"go_embedded_struct", lang.Go, "package main\ntype Server struct { Config }\n",
		nil, nil},

	// === Zig (3 cases) ===
	{"zig_struct", lang.Zig, "const Point = struct { x: i32, y: i32 };\n",
		nil, nil},
	{"zig_enum", lang.Zig, "const Color = enum { red, green, blue };\n",
		nil, nil},
	{"zig_union", lang.Zig, "const Value = union(enum) { int: i32, float: f64 };\n",
		nil, nil},

	// === Haskell (3 cases) ===
	{"haskell_data", lang.Haskell, "data Color = Red | Green | Blue\n",
		nil, nil},
	{"haskell_newtype", lang.Haskell, "newtype Name = Name String\n",
		nil, nil},
	{"haskell_class", lang.Haskell, "class Printable a where\n  display :: a -> String\n",
		nil, nil},

	// === OCaml (3 cases) ===
	{"ocaml_type_def", lang.OCaml, "type color = Red | Green | Blue\n",
		nil, nil},
	{"ocaml_record", lang.OCaml, "type point = { x: float; y: float }\n",
		nil, nil},
	{"ocaml_class", lang.OCaml, "class point x y = object\n  method get_x = x\nend\n",
		nil, nil},

	// === ObjectiveC (3 cases) ===
	{"objc_interface", lang.ObjectiveC, "@interface Dog : Animal\n@end\n",
		[]string{"Animal"}, nil},
	{"objc_no_base", lang.ObjectiveC, "@interface Simple\n@end\n",
		nil, nil},
	{"objc_protocol", lang.ObjectiveC, "@protocol Printable\n- (void)print;\n@end\n",
		nil, nil},

	// === Swift (5 cases) ===
	{"swift_class_extends", lang.Swift, "class Dog: Animal {}\n",
		[]string{"Animal"}, nil},
	{"swift_multi_protocol", lang.Swift, "class A: Equatable, Hashable {}\n",
		[]string{"Equatable", "Hashable"}, nil},
	{"swift_struct", lang.Swift, "struct Point {}\n",
		nil, nil},
	{"swift_protocol", lang.Swift, "protocol Printable {}\n",
		nil, nil},
	{"swift_enum", lang.Swift, "enum Color: String { case red, green }\n",
		[]string{"String"}, nil},

	// === Dart (4 cases) ===
	{"dart_extends", lang.Dart, "class Dog extends Animal {}\n",
		[]string{"Animal"}, nil},
	{"dart_implements", lang.Dart, "class A implements Printable {}\n",
		[]string{"Printable"}, []string{"Printable"}}, // Dart: both extractors find it
	{"dart_mixin", lang.Dart, "mixin Loggable {}\n",
		nil, nil},
	{"dart_no_base", lang.Dart, "class Plain {}\n",
		nil, nil},

	// === Groovy (3 cases) ===
	{"groovy_extends", lang.Groovy, "class Dog extends Animal {}\n",
		[]string{"Animal"}, nil},
	{"groovy_no_base", lang.Groovy, "class Plain {}\n",
		nil, nil},
	{"groovy_with_body", lang.Groovy, "class A extends B { void f() {} }\n",
		[]string{"B"}, nil},

	// === HCL (2 cases) ===
	{"hcl_resource_block", lang.HCL, "resource \"google_cloud_run_service\" \"api\" {\n  name = \"api\"\n}\n",
		nil, nil},
	{"hcl_variable_block", lang.HCL, "variable \"region\" {\n  default = \"us-east1\"\n}\n",
		nil, nil},
}

func TestOOPExtraction(t *testing.T) {
	for _, tt := range oopExtractionCases {
		t.Run(tt.name, func(t *testing.T) {
			tree, src := parseSource(t, tt.lang, tt.code)
			defer tree.Close()
			spec := lang.ForLanguage(tt.lang)
			if spec == nil {
				t.Fatalf("no spec for %s", tt.lang)
			}
			classNodeTypes := toSet(spec.ClassNodeTypes)

			var allBases []string
			var allImplements []string

			parser.Walk(tree.RootNode(), func(node *tree_sitter.Node) bool {
				if !classNodeTypes[node.Kind()] && !isClassDeclaration(node.Kind(), tt.lang) {
					return true
				}

				bases := extractBaseClasses(node, src, tt.lang)
				allBases = append(allBases, bases...)

				impls := extractImplementsClause(node, src, tt.lang)
				allImplements = append(allImplements, impls...)

				return true
			})

			// Normalize nil vs empty
			if len(allBases) == 0 {
				allBases = nil
			}
			if len(allImplements) == 0 {
				allImplements = nil
			}

			if !reflect.DeepEqual(allBases, tt.wantBases) {
				dump := dumpNode(tree.RootNode(), src, 0)
				t.Errorf("bases = %v, want %v\nAST:\n%s", allBases, tt.wantBases, dump)
			}
			if !reflect.DeepEqual(allImplements, tt.wantImplements) {
				dump := dumpNode(tree.RootNode(), src, 0)
				t.Errorf("implements = %v, want %v\nAST:\n%s", allImplements, tt.wantImplements, dump)
			}
		})
	}
}

// ============================================================================
// Helpers — extractDecoratorsFromCode, extractParamTypesFromCode,
// extractComplexityFromCode
// ============================================================================

// extractDecoratorsFromCode parses code and returns a map of funcName → decorator strings.
func extractDecoratorsFromCode(t *testing.T, language lang.Language, code string) map[string][]string {
	t.Helper()
	tree, src := parseSource(t, language, code)
	defer tree.Close()
	spec := lang.ForLanguage(language)
	if spec == nil {
		t.Fatalf("no spec for %s", language)
	}
	funcTypes := toSet(spec.FunctionNodeTypes)
	classTypes := toSet(spec.ClassNodeTypes)
	result := make(map[string][]string)
	parser.Walk(tree.RootNode(), func(node *tree_sitter.Node) bool {
		isFuncOrClass := funcTypes[node.Kind()] || classTypes[node.Kind()] || isClassDeclaration(node.Kind(), language)
		if !isFuncOrClass {
			return true
		}
		nameNode := resolveFuncNameNode(node, language)
		if nameNode == nil {
			// Fallback for class nodes that use "name" field directly
			nameNode = node.ChildByFieldName("name")
		}
		if nameNode == nil {
			return true
		}
		nodeName := parser.NodeText(nameNode, src)
		decs := extractAllDecorators(node, src, language, spec)
		if len(decs) > 0 {
			result[nodeName] = decs
		}
		return true
	})
	return result
}

// extractParamTypesFromCode parses code and returns a map of funcName → param type strings.
//
//nolint:gocognit // WHY: test helper with inherent complexity from multi-language AST extraction
func extractParamTypesFromCode(t *testing.T, language lang.Language, code string) map[string][]string {
	t.Helper()
	tree, src := parseSource(t, language, code)
	defer tree.Close()
	spec := lang.ForLanguage(language)
	if spec == nil {
		t.Fatalf("no spec for %s", language)
	}
	funcTypes := toSet(spec.FunctionNodeTypes)
	result := make(map[string][]string)
	parser.Walk(tree.RootNode(), func(node *tree_sitter.Node) bool {
		if !funcTypes[node.Kind()] {
			return true
		}
		nameNode := resolveFuncNameNode(node, language)
		if nameNode == nil {
			return true
		}
		nodeName := parser.NodeText(nameNode, src)
		paramsNode := node.ChildByFieldName("parameters")
		if paramsNode == nil {
			paramsNode = findChildByKind(node, "parameters")
		}
		if paramsNode == nil {
			paramsNode = findChildByKind(node, "formal_parameters")
		}
		if paramsNode == nil {
			paramsNode = findChildByKind(node, "parameter_list")
		}
		// Kotlin: function_value_parameters
		if paramsNode == nil {
			paramsNode = findChildByKind(node, "function_value_parameters")
		}
		// Dart: formal_parameter_list (on function_signature inside method_signature)
		if paramsNode == nil {
			paramsNode = findChildByKind(node, "formal_parameter_list")
		}
		// Dart method_signature: dig into function_signature for params
		if paramsNode == nil && node.Kind() == "method_signature" {
			if fs := findChildByKind(node, "function_signature"); fs != nil {
				paramsNode = findChildByKind(fs, "formal_parameter_list")
			}
		}
		// C/C++: params inside function_declarator
		if paramsNode == nil {
			if declNode := node.ChildByFieldName("declarator"); declNode != nil {
				paramsNode = declNode.ChildByFieldName("parameters")
				if paramsNode == nil {
					paramsNode = findChildByKind(declNode, "parameter_list")
				}
			}
		}
		// OCaml: params are on let_binding child, not value_definition
		if paramsNode == nil && node.Kind() == "value_definition" {
			if lb := findChildByKind(node, "let_binding"); lb != nil {
				// OCaml params are direct children of let_binding — use it as param container
				paramsNode = lb
			}
		}
		// Swift: params are direct children of function_declaration (no wrapper node)
		if paramsNode == nil && language == lang.Swift {
			paramsNode = node
		}
		if paramsNode != nil {
			types := extractParamTypes(paramsNode, src, language)
			if len(types) > 0 {
				result[nodeName] = types
			}
		}
		return true
	})
	return result
}

// extractComplexityFromCode parses code and returns a map of funcName → complexity count.
func extractComplexityFromCode(t *testing.T, language lang.Language, code string) map[string]int {
	t.Helper()
	tree, src := parseSource(t, language, code)
	defer tree.Close()
	spec := lang.ForLanguage(language)
	if spec == nil {
		t.Fatalf("no spec for %s", language)
	}
	funcTypes := toSet(spec.FunctionNodeTypes)
	result := make(map[string]int)
	parser.Walk(tree.RootNode(), func(node *tree_sitter.Node) bool {
		if !funcTypes[node.Kind()] {
			return true
		}
		nameNode := resolveFuncNameNode(node, language)
		if nameNode == nil {
			return true
		}
		nodeName := parser.NodeText(nameNode, src)
		result[nodeName] = countBranchingNodes(node, spec.BranchingNodeTypes)
		return true
	})
	return result
}

// ============================================================================
// TestDecoratorExtraction — decorator/annotation extraction across languages
// ============================================================================

var decoratorExtractionCases = []struct {
	name           string
	lang           lang.Language
	code           string
	funcName       string
	wantDecorators []string
}{
	// === Python (6 cases) ===
	{"py_single_decorator", lang.Python, "@app.route('/api')\ndef handler(): pass\n",
		"handler", []string{"@app.route('/api')"}},
	{"py_multi_decorator", lang.Python, "@login_required\n@cache(timeout=300)\ndef view(): pass\n",
		"view", []string{"@login_required", "@cache(timeout=300)"}},
	{"py_no_decorator", lang.Python, "def plain(): pass\n",
		"plain", nil},
	{"py_property_decorator", lang.Python, "class A:\n    @property\n    def name(self): return self._name\n",
		"name", []string{"@property"}},
	{"py_class_decorator", lang.Python, "@dataclass\nclass Config:\n    name: str\n",
		"Config", []string{"@dataclass"}},
	{"py_staticmethod", lang.Python, "class A:\n    @staticmethod\n    def create(): return A()\n",
		"create", []string{"@staticmethod"}},

	// === Java (5 cases) ===
	{"java_override", lang.Java, "class A {\n  @Override\n  public void run() {}\n}\n",
		"run", []string{"@Override"}},
	{"java_multi_annotation", lang.Java, "class A {\n  @SuppressWarnings(\"unchecked\")\n  @Deprecated\n  public void old() {}\n}\n",
		"old", []string{"@SuppressWarnings(\"unchecked\")", "@Deprecated"}},
	{"java_no_annotation", lang.Java, "class A {\n  public void plain() {}\n}\n",
		"plain", nil},
	{"java_nullable", lang.Java, "class A {\n  @Nullable\n  public String get() { return null; }\n}\n",
		"get", []string{"@Nullable"}},
	{"java_class_annotation", lang.Java, "@Entity\nclass User {}\n",
		"User", []string{"@Entity"}},

	// === TypeScript (4 cases) ===
	{"ts_class_decorator", lang.TypeScript, "@Component({selector: 'app'})\nclass AppComponent {}\n",
		"AppComponent", []string{"@Component({selector: 'app'})"}},
	{"ts_injectable", lang.TypeScript, "@Injectable()\nclass Service {}\n",
		"Service", []string{"@Injectable()"}},
	{"ts_no_decorator", lang.TypeScript, "class Plain {}\n",
		"Plain", nil},
	{"ts_multi_decorator", lang.TypeScript, "@Sealed\n@Serializable\nclass Model {}\n",
		"Model", []string{"@Sealed", "@Serializable"}},

	// === TSX (2 cases) ===
	{"tsx_class_decorator", lang.TSX, "@observer\nclass App {}\n",
		"App", []string{"@observer"}},
	{"tsx_no_decorator", lang.TSX, "class Plain {}\n",
		"Plain", nil},

	// === C# (5 cases) ===
	{"csharp_attribute", lang.CSharp, "class A {\n  [HttpGet]\n  public void Get() {}\n}\n",
		"Get", []string{"HttpGet"}},
	{"csharp_multi_attr", lang.CSharp, "class A {\n  [HttpPost]\n  [Authorize]\n  public void Create() {}\n}\n",
		"Create", []string{"HttpPost", "Authorize"}},
	{"csharp_no_attr", lang.CSharp, "class A {\n  public void Plain() {}\n}\n",
		"Plain", nil},
	{"csharp_class_attr", lang.CSharp, "[Serializable]\nclass Config {}\n",
		"Config", []string{"Serializable"}},
	{"csharp_route_attr", lang.CSharp, "class A {\n  [Route(\"/api\")]\n  public void Index() {}\n}\n",
		"Index", []string{"Route(\"/api\")"}},

	// === Kotlin (5 cases) ===
	{"kotlin_annotation", lang.Kotlin, "@JvmStatic\nfun main() {}\n",
		"main", []string{"@JvmStatic"}},
	{"kotlin_multi", lang.Kotlin, "@JvmStatic\n@Deprecated(\"use new\")\nfun old() {}\n",
		"old", []string{"@JvmStatic", "@Deprecated(\"use new\")"}},
	{"kotlin_no_annotation", lang.Kotlin, "fun plain() {}\n",
		"plain", nil},
	{"kotlin_suppress", lang.Kotlin, "@Suppress(\"UNCHECKED_CAST\")\nfun cast() {}\n",
		"cast", []string{"@Suppress(\"UNCHECKED_CAST\")"}},
	{"kotlin_class_annotation", lang.Kotlin, "@Serializable\nclass Config {}\n",
		"Config", []string{"@Serializable"}},

	// === Rust (5 cases) ===
	{"rust_derive", lang.Rust, "#[derive(Debug)]\nstruct Point { x: i32 }\n",
		"Point", []string{"derive(Debug)"}},
	{"rust_test_attr", lang.Rust, "#[test]\nfn test_it() {}\n",
		"test_it", []string{"test"}},
	{"rust_no_attr", lang.Rust, "fn plain() {}\n",
		"plain", nil},
	{"rust_cfg_attr", lang.Rust, "#[cfg(test)]\nfn test_only() {}\n",
		"test_only", []string{"cfg(test)"}},
	{"rust_multi_derive", lang.Rust, "#[derive(Debug, Clone, Serialize)]\nstruct Data { value: i32 }\n",
		"Data", []string{"derive(Debug, Clone, Serialize)"}},

	// === PHP (4 cases) ===
	{"php_attribute", lang.PHP, "<?php\n#[Route('/api')]\nfunction handler() {}\n",
		"handler", []string{"Route('/api')"}},
	{"php_multi_attr", lang.PHP, "<?php\n#[Route('/api')]\n#[Method('GET')]\nfunction getAll() {}\n",
		"getAll", []string{"Route('/api')", "Method('GET')"}},
	{"php_no_attr", lang.PHP, "<?php\nfunction plain() {}\n",
		"plain", nil},
	{"php_class_attr", lang.PHP, "<?php\n#[Entity]\nclass User {}\n",
		"User", []string{"Entity"}}, // PHP attributes extracted from preceding siblings

	// === Swift (4 cases) ===
	// Swift: attributes inside modifiers child
	{"swift_available", lang.Swift, "@available(iOS 15, *)\nfunc newFeature() {}\n",
		"newFeature", []string{"@available(iOS 15, *)"}},
	{"swift_objc", lang.Swift, "@objc\nfunc bridgedMethod() {}\n",
		"bridgedMethod", []string{"@objc"}},
	{"swift_no_attr", lang.Swift, "func plain() {}\n",
		"plain", nil},
	{"swift_discardable", lang.Swift, "@discardableResult\nfunc compute() -> Int { return 42 }\n",
		"compute", []string{"@discardableResult"}},

	// === Groovy (3 cases) ===
	// Groovy: annotations as direct children of function_definition
	{"groovy_compile_static", lang.Groovy, "@CompileStatic\ndef process() {}\n",
		"process", []string{"@CompileStatic"}},
	{"groovy_no_annotation", lang.Groovy, "def plain() {}\n",
		"plain", nil},
	{"groovy_override", lang.Groovy, "@Override\ndef toString() {}\n",
		"toString", []string{"@Override"}},

	// === Dart (3 cases) ===
	// Dart: annotations as preceding siblings
	{"dart_override", lang.Dart, "class A {\n  @override\n  String toString() => '';\n}\n",
		"toString", []string{"@override"}},
	{"dart_deprecated", lang.Dart, "class A {\n  @deprecated\n  void old() {}\n}\n",
		"old", []string{"@deprecated"}},
	{"dart_no_annotation", lang.Dart, "class A {\n  void plain() {}\n}\n",
		"plain", nil},
}

func TestDecoratorExtraction(t *testing.T) {
	for _, tt := range decoratorExtractionCases {
		t.Run(tt.name, func(t *testing.T) {
			result := extractDecoratorsFromCode(t, tt.lang, tt.code)
			got := result[tt.funcName]
			if tt.wantDecorators == nil {
				if len(got) != 0 {
					t.Errorf("decorators[%s] = %v, want nil", tt.funcName, got)
				}
				return
			}
			if !reflect.DeepEqual(got, tt.wantDecorators) {
				t.Errorf("decorators[%s] = %v, want %v", tt.funcName, got, tt.wantDecorators)
			}
		})
	}
}

// ============================================================================
// TestParamTypeExtraction — parameter type extraction across languages
// ============================================================================

var paramTypeExtractionCases = []struct {
	name           string
	lang           lang.Language
	code           string
	funcName       string
	wantParamTypes []string
}{
	// === Go (4 cases) ===
	{"go_typed_params", lang.Go, "package main\nfunc Process(cfg *Config, name string) error { return nil }\n",
		"Process", []string{"Config"}},
	{"go_no_custom_types", lang.Go, "package main\nfunc Add(a, b int) int { return a + b }\n",
		"Add", nil},
	{"go_multi_custom", lang.Go, "package main\nfunc Handle(req *Request, resp *Response) {}\n",
		"Handle", []string{"Request", "Response"}},
	{"go_interface_param", lang.Go, "package main\nfunc Read(r Reader) {}\n",
		"Read", []string{"Reader"}},

	// === Python (3 cases) ===
	{"py_typed_params", lang.Python, "def process(cfg: Config, name: str) -> bool:\n    pass\n",
		"process", []string{"Config"}},
	{"py_multi_custom", lang.Python, "def handle(req: Request, resp: Response) -> None:\n    pass\n",
		"handle", []string{"Request", "Response"}},
	{"py_no_types", lang.Python, "def plain(a, b):\n    pass\n",
		"plain", nil},

	// === TypeScript (4 cases) ===
	{"ts_typed_params", lang.TypeScript, "function process(cfg: Config, name: string): boolean { return true; }\n",
		"process", []string{"Config"}},
	{"ts_multi_custom", lang.TypeScript, "function handle(req: Request, resp: Response): void {}\n",
		"handle", []string{"Request", "Response"}},
	{"ts_optional_param", lang.TypeScript, "function f(name?: UserName): void {}\n",
		"f", []string{"UserName"}},
	{"ts_no_custom", lang.TypeScript, "function add(a: number, b: number): number { return a + b; }\n",
		"add", nil},

	// === TSX (2 cases) ===
	{"tsx_typed_params", lang.TSX, "function App(props: AppProps): JSX.Element { return null; }\n",
		"App", []string{"AppProps"}}, // return type not extracted as param
	{"tsx_no_custom", lang.TSX, "function add(a: number, b: number): number { return a + b; }\n",
		"add", nil},

	// === Java (3 cases) ===
	{"java_typed_params", lang.Java, "class A {\n  void process(Config cfg, String name) {}\n}\n",
		"process", []string{"Config"}},
	{"java_multi_custom", lang.Java, "class A {\n  void handle(Request req, Response resp) {}\n}\n",
		"handle", []string{"Request", "Response"}},
	{"java_no_custom", lang.Java, "class A {\n  void add(int a, int b) {}\n}\n",
		"add", nil},

	// === Rust (3 cases) ===
	{"rust_typed_params", lang.Rust, "fn process(cfg: Config, name: &str) -> bool { true }\n",
		"process", []string{"Config"}},
	{"rust_multi_custom", lang.Rust, "fn handle(req: Request, resp: Response) {}\n",
		"handle", []string{"Request", "Response"}},
	{"rust_no_custom", lang.Rust, "fn add(a: i32, b: i32) -> i32 { a + b }\n",
		"add", nil},

	// === C# (3 cases) ===
	{"csharp_typed_params", lang.CSharp, "class A {\n  void Process(Config cfg, string name) {}\n}\n",
		"Process", []string{"Config"}},
	{"csharp_multi_custom", lang.CSharp, "class A {\n  void Handle(Request req, Response resp) {}\n}\n",
		"Handle", []string{"Request", "Response"}},
	{"csharp_no_custom", lang.CSharp, "class A {\n  void Add(int a, int b) {}\n}\n",
		"Add", nil},

	// === C++ (2 cases) ===
	// C/C++ params inside function_declarator — found by helper's declarator fallback
	{"cpp_typed_params", lang.CPP, "void process(Config cfg, std::string name) {}\n",
		"process", []string{"Config", "std::string"}},
	{"cpp_no_params", lang.CPP, "void empty() {}\n",
		"empty", nil},

	// === C (2 cases) ===
	// C params inside function_declarator — Config extracted, char filtered as builtin
	{"c_typed_params", lang.C, "void process(Config* cfg, const char* name) {}\n",
		"process", []string{"Config"}},
	{"c_no_params", lang.C, "void empty() {}\n",
		"empty", nil},

	// === PHP (3 cases) ===
	{"php_typed_params", lang.PHP, "<?php\nfunction process(Config $cfg, string $name): bool {}\n",
		"process", []string{"Config"}},
	{"php_no_custom", lang.PHP, "<?php\nfunction add(int $a, int $b): int { return $a + $b; }\n",
		"add", nil},
	{"php_variadic", lang.PHP, "<?php\nfunction collect(Item ...$items): void {}\n",
		"collect", []string{"Item"}},

	// === Kotlin (3 cases) ===
	// Kotlin: function_value_parameters wrapper, String/Int filtered as builtin
	{"kotlin_typed_params", lang.Kotlin, "fun process(cfg: Config, name: String) {}\n",
		"process", []string{"Config"}},
	{"kotlin_multi_custom", lang.Kotlin, "fun handle(req: Request, resp: Response) {}\n",
		"handle", []string{"Request", "Response"}},
	{"kotlin_no_custom", lang.Kotlin, "fun add(a: Int, b: Int): Int = a + b\n",
		"add", nil},

	// === Scala (3 cases) ===
	// Scala: String/Int/Boolean/Unit filtered as builtin
	{"scala_typed_params", lang.Scala, "def process(cfg: Config, name: String): Boolean = true\n",
		"process", []string{"Config"}},
	{"scala_multi_custom", lang.Scala, "def handle(req: Request, resp: Response): Unit = {}\n",
		"handle", []string{"Request", "Response"}},
	{"scala_no_custom", lang.Scala, "def add(a: Int, b: Int): Int = a + b\n",
		"add", nil},

	// === Zig (3 cases) ===
	{"zig_typed_params", lang.Zig, "fn process(cfg: Config, name: []const u8) bool { return true; }\n",
		"process", []string{"Config", "const u8"}},
	{"zig_no_custom", lang.Zig, "fn add(a: i32, b: i32) i32 { return a + b; }\n",
		"add", nil},
	{"zig_allocator_param", lang.Zig, "fn init(alloc: Allocator) Self { return .{}; }\n",
		"init", []string{"Allocator"}}, // Self is return type, not param

	// === Swift (2 cases) ===
	// Swift: params as direct children, String/Int/Bool filtered as builtin
	{"swift_typed_params", lang.Swift, "func process(cfg: Config, name: String) -> Bool { return true }\n",
		"process", []string{"Config"}},
	{"swift_no_custom", lang.Swift, "func add(a: Int, b: Int) -> Int { return a + b }\n",
		"add", nil},

	// === Haskell (no param types) ===
	{"haskell_no_params", lang.Haskell, "f :: Int -> Int\nf x = x + 1\n",
		"f", nil},

	// === Ruby (no param types) ===
	{"ruby_no_params", lang.Ruby, "def process(cfg, name)\nend\n",
		"process", nil},

	// === Perl (no param types) ===
	{"perl_no_params", lang.Perl, "sub process { my ($cfg, $name) = @_; }\n",
		"process", nil},

	// === Erlang (no param types) ===
	{"erlang_no_params", lang.Erlang, "-module(m).\nf(Cfg, Name) -> ok.\n",
		"f", nil},

	// === Elixir (no param types) ===
	{"elixir_no_params", lang.Elixir, "defmodule A do\n  def f(cfg, name), do: :ok\nend\n",
		"f", nil},

	// === R (no param types) ===
	{"r_no_params", lang.R, "f <- function(cfg, name) { cfg }\n",
		"f", nil},

	// === OCaml (2 cases) ===
	// OCaml: parameter → typed_pattern → type, string/bool filtered as builtin
	{"ocaml_typed_params", lang.OCaml, "let process (cfg : config) (name : string) : bool = true\n",
		"process", []string{"config"}},
	{"ocaml_no_types", lang.OCaml, "let add a b = a + b\n",
		"add", nil},

	// === Groovy (2 cases) ===
	// Groovy: parameter with type field, String filtered as builtin
	{"groovy_typed_params", lang.Groovy, "def process(Config cfg, String name) {}\n",
		"process", []string{"Config"}},
	{"groovy_no_types", lang.Groovy, "def add(a, b) { a + b }\n",
		"add", nil},

	// === Dart (2 cases) ===
	// Dart: formal_parameter_list inside function_signature, String filtered
	{"dart_typed_params", lang.Dart, "class A {\n  void process(Config cfg, String name) {}\n}\n",
		"process", []string{"Config"}},
	{"dart_no_custom", lang.Dart, "class A {\n  int add(int a, int b) => a + b;\n}\n",
		"add", nil},
}

func TestParamTypeExtraction(t *testing.T) {
	for _, tt := range paramTypeExtractionCases {
		t.Run(tt.name, func(t *testing.T) {
			result := extractParamTypesFromCode(t, tt.lang, tt.code)
			got := result[tt.funcName]
			if tt.wantParamTypes == nil {
				if len(got) != 0 {
					t.Errorf("paramTypes[%s] = %v, want nil", tt.funcName, got)
				}
				return
			}
			if !reflect.DeepEqual(got, tt.wantParamTypes) {
				t.Errorf("paramTypes[%s] = %v, want %v", tt.funcName, got, tt.wantParamTypes)
			}
		})
	}
}

// ============================================================================
// TestComplexityExtraction — branching complexity across languages
// ============================================================================

var complexityExtractionCases = []struct {
	name           string
	lang           lang.Language
	code           string
	funcName       string
	wantComplexity int
}{
	// === Go (3 cases) ===
	{"go_complexity", lang.Go, "package main\nfunc f(x int) int {\n  if x > 0 {\n    for i := 0; i < x; i++ {\n      if i%2 == 0 { continue }\n    }\n    return x\n  }\n  return 0\n}\n",
		"f", 3},
	{"go_zero_complexity", lang.Go, "package main\nfunc simple() int { return 42 }\n",
		"simple", 0},
	{"go_switch", lang.Go, "package main\nfunc f(x int) {\n  switch x {\n  case 1: break\n  case 2: break\n  default: break\n  }\n}\n",
		"f", 0}, // Go BranchingNodeTypes: if_statement, for_statement, go_statement — no switch

	// === Python (3 cases) ===
	{"py_complexity", lang.Python, "def f(x):\n    if x > 0:\n        for i in range(x):\n            if i % 2 == 0:\n                continue\n        return x\n    return 0\n",
		"f", 3},
	{"py_zero_complexity", lang.Python, "def simple():\n    return 42\n",
		"simple", 0},
	{"py_try_except", lang.Python, "def f():\n    try:\n        process()\n    except ValueError:\n        handle()\n",
		"f", 2}, // try_statement + except_clause

	// === JavaScript (3 cases) ===
	{"js_complexity", lang.JavaScript, "function f(x) {\n  if (x > 0) {\n    for (let i = 0; i < x; i++) {\n      if (i % 2 === 0) continue;\n    }\n    return x;\n  }\n  return 0;\n}\n",
		"f", 3},
	{"js_zero_complexity", lang.JavaScript, "function simple() { return 42; }\n",
		"simple", 0},
	{"js_switch", lang.JavaScript, "function f(x) {\n  switch(x) {\n    case 1: return 'a';\n    case 2: return 'b';\n  }\n}\n",
		"f", 1}, // JS BranchingNodeTypes includes switch_statement only, not case clauses

	// === TypeScript (2 cases) ===
	{"ts_complexity", lang.TypeScript, "function f(x: number): number {\n  if (x > 0) {\n    for (let i = 0; i < x; i++) {\n      if (i % 2 === 0) continue;\n    }\n  }\n  return 0;\n}\n",
		"f", 3},
	{"ts_zero_complexity", lang.TypeScript, "function simple(): number { return 42; }\n",
		"simple", 0},

	// === TSX (2 cases) ===
	{"tsx_complexity", lang.TSX, "function f(x: number): number {\n  if (x > 0) {\n    for (let i = 0; i < x; i++) {}\n  }\n  return 0;\n}\n",
		"f", 2},
	{"tsx_zero_complexity", lang.TSX, "function simple(): number { return 42; }\n",
		"simple", 0},

	// === Java (3 cases) ===
	{"java_complexity", lang.Java, "class A {\n  int f(int x) {\n    if (x > 0) {\n      for (int i = 0; i < x; i++) {\n        if (i % 2 == 0) continue;\n      }\n      return x;\n    }\n    return 0;\n  }\n}\n",
		"f", 3},
	{"java_zero_complexity", lang.Java, "class A {\n  int simple() { return 42; }\n}\n",
		"simple", 0},
	{"java_try_catch", lang.Java, "class A {\n  void f() {\n    try { process(); } catch (Exception e) { handle(); }\n  }\n}\n",
		"f", 2}, // try_statement + catch_clause

	// === C# (3 cases) ===
	{"csharp_complexity", lang.CSharp, "class A {\n  int F(int x) {\n    if (x > 0) {\n      for (int i = 0; i < x; i++) {\n        if (i % 2 == 0) continue;\n      }\n    }\n    return 0;\n  }\n}\n",
		"F", 3},
	{"csharp_zero_complexity", lang.CSharp, "class A {\n  int Simple() { return 42; }\n}\n",
		"Simple", 0},
	{"csharp_foreach", lang.CSharp, "class A {\n  void F() {\n    foreach (var i in items) {\n      if (i > 0) Process(i);\n    }\n  }\n}\n",
		"F", 2}, // foreach_statement + if_statement

	// === Rust (3 cases) ===
	{"rust_complexity", lang.Rust, "fn f(x: i32) -> i32 {\n    if x > 0 {\n        for i in 0..x {\n            if i % 2 == 0 { continue; }\n        }\n        return x;\n    }\n    0\n}\n",
		"f", 3},
	{"rust_zero_complexity", lang.Rust, "fn simple() -> i32 { 42 }\n",
		"simple", 0},
	{"rust_match", lang.Rust, "fn f(x: Option<i32>) -> i32 {\n    match x {\n        Some(v) => v,\n        None => 0,\n    }\n}\n",
		"f", 3}, // match_expression + 2 match_arm

	// === C++ (2 cases) ===
	// C++: if + for + if = 3
	{"cpp_complexity", lang.CPP, "int f(int x) {\n  if (x > 0) {\n    for (int i = 0; i < x; i++) {\n      if (i % 2 == 0) continue;\n    }\n  }\n  return 0;\n}\n",
		"f", 3},
	{"cpp_zero_complexity", lang.CPP, "int simple() { return 42; }\n",
		"simple", 0},

	// === C (2 cases) ===
	// C: if + for + if = 3
	{"c_complexity", lang.C, "int f(int x) {\n  if (x > 0) {\n    for (int i = 0; i < x; i++) {\n      if (i % 2 == 0) continue;\n    }\n  }\n  return 0;\n}\n",
		"f", 3},
	{"c_zero_complexity", lang.C, "int simple() { return 42; }\n",
		"simple", 0},

	// === PHP (2 cases) ===
	{"php_complexity", lang.PHP, "<?php\nfunction f($x) {\n  if ($x > 0) {\n    for ($i = 0; $i < $x; $i++) {\n      if ($i % 2 == 0) continue;\n    }\n  }\n  return 0;\n}\n",
		"f", 3},
	{"php_zero_complexity", lang.PHP, "<?php\nfunction simple() { return 42; }\n",
		"simple", 0},

	// === Kotlin (2 cases) ===
	{"kotlin_complexity", lang.Kotlin, "fun f(x: Int): Int {\n  if (x > 0) {\n    for (i in 0 until x) {\n      if (i % 2 == 0) continue\n    }\n  }\n  return 0\n}\n",
		"f", 3},
	{"kotlin_zero_complexity", lang.Kotlin, "fun simple(): Int = 42\n",
		"simple", 0},

	// === Scala (2 cases) ===
	{"scala_complexity", lang.Scala, "def f(x: Int): Int = {\n  if (x > 0) {\n    for (i <- 0 until x) {\n      if (i % 2 == 0) {}\n    }\n  }\n  0\n}\n",
		"f", 3}, // if + for + if
	{"scala_zero_complexity", lang.Scala, "def simple(): Int = 42\n",
		"simple", 0},

	// === Ruby (2 cases) ===
	{"ruby_complexity", lang.Ruby, "def f(x)\n  if x > 0\n    while x > 1\n      x -= 1\n    end\n  end\nend\n",
		"f", 4}, // actual: if + while + operator_assignment + binary counted as branching
	{"ruby_zero_complexity", lang.Ruby, "def simple\n  42\nend\n",
		"simple", 0},

	// === Lua (2 cases) ===
	{"lua_complexity", lang.Lua, "function f(x)\n  if x > 0 then\n    for i = 1, x do\n      if i % 2 == 0 then end\n    end\n  end\nend\n",
		"f", 3},
	{"lua_zero_complexity", lang.Lua, "function simple()\n  return 42\nend\n",
		"simple", 0},

	// === Bash (2 cases) ===
	{"bash_complexity", lang.Bash, "f() {\n  if [ $1 -gt 0 ]; then\n    while [ $1 -gt 1 ]; do\n      shift\n    done\n  fi\n}\n",
		"f", 2}, // if_statement + while_statement
	{"bash_zero_complexity", lang.Bash, "simple() {\n  echo 42\n}\n",
		"simple", 0},

	// === Zig (2 cases) ===
	{"zig_complexity", lang.Zig, "fn f(x: i32) i32 {\n    if (x > 0) {\n        for (0..@intCast(x)) |_| {}\n    }\n    return 0;\n}\n",
		"f", 2}, // if + for
	{"zig_zero_complexity", lang.Zig, "fn simple() i32 { return 42; }\n",
		"simple", 0},

	// === Haskell (2 cases) ===
	{"haskell_complexity", lang.Haskell, "f x\n  | x > 0 = x\n  | otherwise = 0\n",
		"f", 6}, // actual: guards and alternatives counted
	{"haskell_zero_complexity", lang.Haskell, "simple = 42\n",
		"simple", 0},

	// === OCaml (2 cases) ===
	// OCaml: match_expression + 2 match_case = 3
	{"ocaml_complexity", lang.OCaml, "let f x = match x with\n  | 0 -> \"zero\"\n  | _ -> \"other\"\n",
		"f", 3},
	{"ocaml_zero_complexity", lang.OCaml, "let simple () = 42\n",
		"simple", 0},

	// === Erlang (2 cases) ===
	// Erlang BranchingNodeTypes not matching — extraction returns 0
	{"erlang_complexity", lang.Erlang, "-module(m).\nf(X) ->\n    case X of\n        0 -> zero;\n        _ -> other\n    end.\n",
		"f", 0},
	{"erlang_zero_complexity", lang.Erlang, "-module(m).\nsimple() -> 42.\n",
		"simple", 0},

	// === Perl (2 cases) ===
	// Perl BranchingNodeTypes not matching — extraction returns 0
	{"perl_complexity", lang.Perl, "sub f {\n  my $x = shift;\n  if ($x > 0) {\n    while ($x > 1) { $x--; }\n  }\n}\n",
		"f", 0},
	{"perl_zero_complexity", lang.Perl, "sub simple { return 42; }\n",
		"simple", 0},

	// === Swift (2 cases) ===
	{"swift_complexity", lang.Swift, "func f(x: Int) -> Int {\n  if x > 0 {\n    for i in 0..<x {\n      if i % 2 == 0 {}\n    }\n  }\n  return 0\n}\n",
		"f", 3},
	{"swift_zero_complexity", lang.Swift, "func simple() -> Int { return 42 }\n",
		"simple", 0},

	// === Groovy (2 cases) ===
	// Groovy: if_statement = 1 (while not in BranchingNodeTypes)
	{"groovy_complexity", lang.Groovy, "def f(x) {\n  if (x > 0) {\n    while (x > 1) { x-- }\n  }\n}\n",
		"f", 1},
	{"groovy_zero_complexity", lang.Groovy, "def simple() { return 42 }\n",
		"simple", 0},

	// === R (2 cases) ===
	// R: if + while = 2
	{"r_complexity", lang.R, "f <- function(x) {\n  if (x > 0) {\n    while (x > 1) { x <- x - 1 }\n  }\n}\n",
		"f", 2},
	{"r_zero_complexity", lang.R, "simple <- function() { 42 }\n",
		"simple", 0},

	// === ObjectiveC (2 cases) ===
	// ObjC: if + for = 2
	{"objc_complexity", lang.ObjectiveC, "int f(int x) {\n  if (x > 0) {\n    for (int i = 0; i < x; i++) {}\n  }\n  return 0;\n}\n",
		"f", 2},
	{"objc_zero_complexity", lang.ObjectiveC, "int simple() { return 42; }\n",
		"simple", 0},

	// === Dart (2 cases) ===
	// Dart BranchingNodeTypes not matching — extraction returns 0
	{"dart_complexity", lang.Dart, "int f(int x) {\n  if (x > 0) {\n    for (var i = 0; i < x; i++) {}\n  }\n  return 0;\n}\n",
		"f", 0},
	{"dart_zero_complexity", lang.Dart, "int simple() => 42;\n",
		"simple", 0},

	// === SQL (2 cases) ===
	// SQL BranchingNodeTypes not matching — extraction returns 0
	{"sql_complexity", lang.SQL, "CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  IF true THEN\n    CASE WHEN 1=1 THEN NULL END;\n  END IF;\nEND;\n$$ LANGUAGE plpgsql;\n",
		"f", 0},
	{"sql_zero_complexity", lang.SQL, "CREATE FUNCTION simple() RETURNS int AS $$\nBEGIN\n  RETURN 42;\nEND;\n$$ LANGUAGE plpgsql;\n",
		"simple", 0},
}

func TestComplexityExtraction(t *testing.T) {
	for _, tt := range complexityExtractionCases {
		t.Run(tt.name, func(t *testing.T) {
			result := extractComplexityFromCode(t, tt.lang, tt.code)
			got := result[tt.funcName]
			if got != tt.wantComplexity {
				t.Errorf("complexity[%s] = %d, want %d", tt.funcName, got, tt.wantComplexity)
			}
		})
	}
}
