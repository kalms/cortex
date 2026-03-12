package pipeline

import (
	"testing"
)

func TestParseCompileCommands(t *testing.T) {
	data := []byte(`[
		{
			"directory": "/home/user/project/build",
			"command": "gcc -I/home/user/project/include -I/home/user/project/src -DDEBUG=1 -DVERSION=\"1.0\" -std=c11 -o main.o -c /home/user/project/src/main.c",
			"file": "/home/user/project/src/main.c"
		},
		{
			"directory": "/home/user/project/build",
			"arguments": ["g++", "-I/home/user/project/include", "-isystem", "/home/user/project/third_party", "-DUSE_SSL", "-std=c++17", "-c", "/home/user/project/src/server.cpp"],
			"file": "/home/user/project/src/server.cpp"
		},
		{
			"directory": "/home/user/project/build",
			"command": "gcc -c /outside/repo/file.c",
			"file": "/outside/repo/file.c"
		}
	]`)

	repoPath := "/home/user/project"
	result := parseCompileCommands(data, repoPath)

	// main.c
	mainFlags := result["src/main.c"]
	if mainFlags == nil {
		t.Fatal("expected flags for src/main.c")
	}
	if len(mainFlags.IncludePaths) != 2 {
		t.Errorf("expected 2 include paths for main.c, got %d: %v", len(mainFlags.IncludePaths), mainFlags.IncludePaths)
	}
	if len(mainFlags.Defines) != 2 {
		t.Errorf("expected 2 defines for main.c, got %d: %v", len(mainFlags.Defines), mainFlags.Defines)
	}
	if mainFlags.Standard != "c11" {
		t.Errorf("expected standard c11, got %q", mainFlags.Standard)
	}

	// server.cpp (using arguments array)
	serverFlags := result["src/server.cpp"]
	if serverFlags == nil {
		t.Fatal("expected flags for src/server.cpp")
	}
	if len(serverFlags.IncludePaths) != 2 {
		t.Errorf("expected 2 include paths for server.cpp, got %d: %v", len(serverFlags.IncludePaths), serverFlags.IncludePaths)
	}
	if len(serverFlags.Defines) != 1 {
		t.Errorf("expected 1 define for server.cpp, got %d: %v", len(serverFlags.Defines), serverFlags.Defines)
	}
	if serverFlags.Standard != "c++17" {
		t.Errorf("expected standard c++17, got %q", serverFlags.Standard)
	}

	// Outside-repo file should be excluded
	if _, ok := result["../outside/repo/file.c"]; ok {
		t.Error("should not include files outside repo")
	}
}

func TestParseCompileCommands_Empty(t *testing.T) {
	result := parseCompileCommands([]byte(`[]`), "/repo")
	if len(result) != 0 {
		t.Errorf("expected empty result, got %d entries", len(result))
	}
}

func TestParseCompileCommands_InvalidJSON(t *testing.T) {
	result := parseCompileCommands([]byte(`not json`), "/repo")
	if result != nil {
		t.Error("expected nil for invalid JSON")
	}
}

func TestSplitCommand(t *testing.T) {
	tests := []struct {
		cmd  string
		want int
	}{
		{"gcc -c main.c", 3},
		{`gcc -DFOO="bar baz" -c main.c`, 4},
		{"g++ -I/usr/include -std=c++17 -o out -c in.cpp", 7},
	}

	for _, tt := range tests {
		got := splitCommand(tt.cmd)
		if len(got) != tt.want {
			t.Errorf("splitCommand(%q): got %d args %v, want %d", tt.cmd, len(got), got, tt.want)
		}
	}
}

func TestExtractFlags(t *testing.T) {
	args := []string{
		"g++",
		"-I", "/abs/include",
		"-I/rel/include",
		"-isystem", "/sys/include",
		"-DFOO",
		"-DBAR=42",
		"-std=c++20",
		"-O2",
		"-Wall",
		"-c", "main.cpp",
	}

	flags := extractFlags(args, "/project")
	if len(flags.IncludePaths) != 3 {
		t.Errorf("expected 3 include paths, got %d: %v", len(flags.IncludePaths), flags.IncludePaths)
	}
	if len(flags.Defines) != 2 {
		t.Errorf("expected 2 defines, got %d: %v", len(flags.Defines), flags.Defines)
	}
	if flags.Standard != "c++20" {
		t.Errorf("expected c++20, got %q", flags.Standard)
	}
}
