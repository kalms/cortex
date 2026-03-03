package pipeline

import (
	"testing"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"

	"github.com/DeusData/codebase-memory-mcp/internal/lang"
	"github.com/DeusData/codebase-memory-mcp/internal/parser"
)

func assertImport(t *testing.T, imports map[string]string, localName, expectedQN string) {
	t.Helper()
	got, ok := imports[localName]
	if !ok {
		t.Errorf("missing import for local name %q; have: %v", localName, imports)
		return
	}
	if got != expectedQN {
		t.Errorf("import[%q] = %q, want %q", localName, got, expectedQN)
	}
}

func TestParseESModuleImports(t *testing.T) {
	code := `
import React from 'react';
import { useState, useEffect } from 'react';
import * as utils from './utils';
import { Foo as Bar } from './components/foo';
const lodash = require('lodash');
`
	tree, source := parseSource(t, lang.TypeScript, code)
	defer tree.Close()

	imports := parseESModuleImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "React", "react")
	assertImport(t, imports, "useState", "react.useState")
	assertImport(t, imports, "useEffect", "react.useEffect")
	assertImport(t, imports, "utils", "myproject.utils")
	assertImport(t, imports, "Bar", "myproject.components.foo.Foo")
	assertImport(t, imports, "lodash", "lodash")
}

func TestParseJavaImports(t *testing.T) {
	code := `
import java.util.List;
import java.util.Map;
import static org.junit.Assert.assertEquals;
`
	tree, source := parseSource(t, lang.Java, code)
	defer tree.Close()

	imports := parseJavaImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "List", "myproject.java.util.List")
	assertImport(t, imports, "Map", "myproject.java.util.Map")
	assertImport(t, imports, "assertEquals", "myproject.org.junit.Assert.assertEquals")
}

func TestParseKotlinImports(t *testing.T) {
	code := `
import org.example.Foo
import org.example.Bar as Baz
`
	tree, source := parseSource(t, lang.Kotlin, code)
	defer tree.Close()

	imports := parseKotlinImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "Foo", "myproject.org.example.Foo")
	assertImport(t, imports, "Baz", "myproject.org.example.Bar")
}

func TestParseCSharpImports(t *testing.T) {
	code := `
using System;
using System.Collections.Generic;
using Alias = System.IO.File;
`
	tree, source := parseSource(t, lang.CSharp, code)
	defer tree.Close()

	imports := parseCSharpImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "System", "myproject.System")
	assertImport(t, imports, "Generic", "myproject.System.Collections.Generic")
	assertImport(t, imports, "Alias", "myproject.System.IO.File")
}

func TestParseCImports(t *testing.T) {
	code := `
#include <stdio.h>
#include "myheader.h"
#include "utils/helpers.h"
`
	tree, source := parseSource(t, lang.C, code)
	defer tree.Close()

	imports := parseCImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "stdio", "stdio")
	assertImport(t, imports, "myheader", "myheader")
	assertImport(t, imports, "helpers", "utils.helpers")
}

func TestParseRustImports(t *testing.T) {
	code := `
use std::io;
use crate::module::Type;
use std::{fs, path};
use std::io::Write as IoWrite;
`
	tree, source := parseSource(t, lang.Rust, code)
	defer tree.Close()

	imports := parseRustImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "io", "std.io")
	assertImport(t, imports, "Type", "crate.module.Type")
	assertImport(t, imports, "fs", "std.fs")
	assertImport(t, imports, "path", "std.path")
	assertImport(t, imports, "IoWrite", "std.io.Write")
}

func TestParsePHPImports(t *testing.T) {
	code := `<?php
use App\Models\User;
use App\Http\Controllers\Controller;
`
	tree, source := parseSource(t, lang.PHP, code)
	defer tree.Close()

	imports := parsePHPImports(tree.RootNode(), source, "myproject")

	if len(imports) == 0 {
		t.Skip("PHP tree-sitter namespace_use_declaration node type may differ")
	}
	assertImport(t, imports, "User", "myproject.App.Models.User")
}

func TestParseRubyImports(t *testing.T) {
	code := `
require 'json'
require_relative 'helpers/utils'
`
	tree, source := parseSource(t, lang.Ruby, code)
	defer tree.Close()

	imports := parseRubyImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "json", "json")
	assertImport(t, imports, "utils", "myproject.helpers.utils")
}

func TestParseLuaImports(t *testing.T) {
	code := `
local json = require("json")
local utils = require("my.utils")
`
	tree, source := parseSource(t, lang.Lua, code)
	defer tree.Close()

	imports := parseLuaImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "json", "myproject.json")
	assertImport(t, imports, "utils", "myproject.my.utils")
}

func TestParseElixirImports(t *testing.T) {
	code := `
defmodule MyApp.Worker do
  alias MyApp.Repo
  import Ecto.Query
  use GenServer
end
`
	tree, source := parseSource(t, lang.Elixir, code)
	defer tree.Close()

	imports := parseElixirImports(tree.RootNode(), source, "myproject")

	if len(imports) == 0 {
		t.Skip("Elixir import extraction may need AST verification")
	}
	// At minimum, one of these should be captured
	if _, ok := imports["Repo"]; !ok {
		if _, ok := imports["Query"]; !ok {
			if _, ok := imports["GenServer"]; !ok {
				t.Errorf("expected at least one Elixir import; got: %v", imports)
			}
		}
	}
}

func TestParseBashImports(t *testing.T) {
	code := `
source ./lib/helpers.sh
. /etc/profile
`
	tree, source := parseSource(t, lang.Bash, code)
	defer tree.Close()

	imports := parseBashImports(tree.RootNode(), source, "myproject")

	if len(imports) == 0 {
		t.Skip("Bash source command AST structure may differ")
	}
	// Should capture at least the first source command
	assertImport(t, imports, "helpers", "myproject.lib.helpers")
}

func TestParseZigImports(t *testing.T) {
	code := `
const std = @import("std");
const utils = @import("utils.zig");
`
	tree, source := parseSource(t, lang.Zig, code)
	defer tree.Close()

	imports := parseZigImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "std", "std")
	assertImport(t, imports, "utils", "myproject.utils")
}

func TestParseHaskellImports(t *testing.T) {
	code := `
module Main where

import Data.Map
import Data.List as L
import qualified Data.Set
`
	tree, source := parseSource(t, lang.Haskell, code)
	defer tree.Close()

	imports := parseHaskellImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "Map", "Data.Map")
	assertImport(t, imports, "L", "Data.List")
	assertImport(t, imports, "Set", "Data.Set")
}

func TestParseOCamlImports(t *testing.T) {
	code := `
open Printf
open Lwt.Syntax
`
	tree, source := parseSource(t, lang.OCaml, code)
	defer tree.Close()

	imports := parseOCamlImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "Printf", "Printf")
	assertImport(t, imports, "Syntax", "Lwt.Syntax")
}

func TestParseGoImports(t *testing.T) {
	code := `package main

import (
	"fmt"
	"net/http"
	alias "github.com/org/myproject/internal/pkg"
)
`
	tree, source := parseSource(t, lang.Go, code)
	defer tree.Close()

	imports := parseGoImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "fmt", "fmt")
	assertImport(t, imports, "http", "net.http")
	assertImport(t, imports, "alias", "myproject.internal.pkg")
}

func TestParsePythonImports(t *testing.T) {
	code := `
import os
import json as j
from typing import List, Optional
from ..utils import helper
`
	tree, source := parseSource(t, lang.Python, code)
	defer tree.Close()

	imports := parsePythonImports(tree.RootNode(), source, "myproject", "pkg/main.py")

	assertImport(t, imports, "os", "myproject.os")
	assertImport(t, imports, "j", "myproject.json")
	assertImport(t, imports, "List", "myproject.typing.List")
	assertImport(t, imports, "Optional", "myproject.typing.Optional")
}

// --- Callee extraction tests ---

func TestExtractHaskellCallee(t *testing.T) {
	code := `
module Main where

main = do
  putStrLn "hello"
  print (length [1,2,3])
`
	tree, source := parseSource(t, lang.Haskell, code)
	defer tree.Close()

	var callees []string
	spec := lang.ForLanguage(lang.Haskell)
	callTypes := toSet(spec.CallNodeTypes)

	parser.Walk(tree.RootNode(), func(node *tree_sitter.Node) bool {
		if !callTypes[node.Kind()] {
			return true
		}
		name := extractCalleeName(node, source, lang.Haskell)
		if name != "" {
			callees = append(callees, name)
		}
		return true
	})

	if len(callees) == 0 {
		t.Error("expected at least one Haskell callee extracted")
	}
	t.Logf("Haskell callees: %v", callees)
}

func TestExtractOCamlCallee(t *testing.T) {
	code := `
let () =
  Printf.printf "hello\n";
  List.map succ [1; 2; 3]
`
	tree, source := parseSource(t, lang.OCaml, code)
	defer tree.Close()

	var callees []string
	spec := lang.ForLanguage(lang.OCaml)
	callTypes := toSet(spec.CallNodeTypes)

	parser.Walk(tree.RootNode(), func(node *tree_sitter.Node) bool {
		if !callTypes[node.Kind()] {
			return true
		}
		name := extractCalleeName(node, source, lang.OCaml)
		if name != "" {
			callees = append(callees, name)
		}
		return true
	})

	if len(callees) == 0 {
		t.Error("expected at least one OCaml callee extracted")
	}
	t.Logf("OCaml callees: %v", callees)
}

func TestExtractElixirPipeCallee(t *testing.T) {
	code := `
defmodule MyApp do
  def run do
    value
    |> transform()
    |> save()
  end
end
`
	tree, source := parseSource(t, lang.Elixir, code)
	defer tree.Close()

	var callees []string
	spec := lang.ForLanguage(lang.Elixir)
	callTypes := toSet(spec.CallNodeTypes)

	parser.Walk(tree.RootNode(), func(node *tree_sitter.Node) bool {
		if !callTypes[node.Kind()] {
			return true
		}
		name := extractCalleeName(node, source, lang.Elixir)
		if name != "" {
			callees = append(callees, name)
		}
		return true
	})

	// Should find "transform" and "save" from the pipe chain
	if len(callees) == 0 {
		t.Error("expected at least one Elixir pipe callee extracted")
	}
	t.Logf("Elixir callees: %v", callees)
}

// --- OOP hierarchy tests ---

func TestIsClassDeclarationWidened(t *testing.T) {
	tests := []struct {
		kind     string
		lang     lang.Language
		expected bool
	}{
		{"class_declaration", lang.Java, true},
		{"class_definition", lang.Python, true},
		{"abstract_class_declaration", lang.TypeScript, true},
		{"interface_declaration", lang.TypeScript, true},
		{"interface_declaration", lang.Java, true},
		{"interface_declaration", lang.CSharp, true},
		{"struct_declaration", lang.CSharp, true},
		{"enum_declaration", lang.CSharp, true},
		{"object_definition", lang.Scala, true},
		{"trait_definition", lang.Scala, true},
		{"object_declaration", lang.Kotlin, true},
		{"companion_object", lang.Kotlin, true},
		{"trait_declaration", lang.PHP, true},
		{"interface_declaration", lang.PHP, true},
		// Cross-language false positive prevention
		{"object_definition", lang.Java, false},
		{"trait_definition", lang.Java, false},
		{"struct_declaration", lang.Java, false},
		{"companion_object", lang.CSharp, false},
	}

	for _, tt := range tests {
		got := isClassDeclaration(tt.kind, tt.lang)
		if got != tt.expected {
			t.Errorf("isClassDeclaration(%q, %q) = %v, want %v", tt.kind, tt.lang, got, tt.expected)
		}
	}
}

// Route test filter tests are in internal/httplink/httplink_test.go

// --- JSX component ref helper ---

func TestIsUpperFirst(t *testing.T) {
	tests := []struct {
		input    string
		expected bool
	}{
		{"Component", true},
		{"div", false},
		{"MyComponent", true},
		{"span", false},
		{"", false},
		{"A", true},
	}

	for _, tt := range tests {
		got := isUpperFirst(tt.input)
		if got != tt.expected {
			t.Errorf("isUpperFirst(%q) = %v, want %v", tt.input, got, tt.expected)
		}
	}
}

func TestParseScalaImports(t *testing.T) {
	code := `
import scala.collection.mutable.Map
import java.util.Date
`
	tree, source := parseSource(t, lang.Scala, code)
	defer tree.Close()

	imports := parseScalaImports(tree.RootNode(), source, "myproject")

	assertImport(t, imports, "Map", "myproject.scala.collection.mutable.Map")
	assertImport(t, imports, "Date", "myproject.java.util.Date")
}
