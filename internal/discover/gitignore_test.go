package discover

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// initGitRepo creates a minimal .git directory to make the temp dir look like a git repo.
func initGitRepo(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".git", "info"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func discoverRelPaths(t *testing.T, dir string) map[string]bool {
	t.Helper()
	files, err := Discover(context.Background(), dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	m := make(map[string]bool, len(files))
	for _, f := range files {
		m[f.RelPath] = true
	}
	return m
}

func TestGitignoreBasicPatterns(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)

	writeFile(t, filepath.Join(dir, ".gitignore"), "*.log\nbuild/\n")
	writeFile(t, filepath.Join(dir, "main.go"), "package main\n")
	writeFile(t, filepath.Join(dir, "app.log"), "log data\n")
	writeFile(t, filepath.Join(dir, "build", "out.go"), "package build\n")

	found := discoverRelPaths(t, dir)
	if !found["main.go"] {
		t.Error("main.go should be discovered")
	}
	if found["app.log"] {
		t.Error("app.log should be ignored by *.log pattern")
	}
	if found["build/out.go"] {
		t.Error("build/out.go should be ignored by build/ pattern")
	}
}

func TestGitignoreNegation(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)

	writeFile(t, filepath.Join(dir, ".gitignore"), "*.log\n!important.log\n")
	writeFile(t, filepath.Join(dir, "debug.log"), "debug\n")
	writeFile(t, filepath.Join(dir, "important.log"), "keep me\n")
	// .log isn't a supported language, so add a Go file to prove discovery works
	writeFile(t, filepath.Join(dir, "main.go"), "package main\n")

	files, err := Discover(context.Background(), dir, nil)
	if err != nil {
		t.Fatal(err)
	}

	found := make(map[string]bool)
	for _, f := range files {
		found[f.RelPath] = true
	}

	if !found["main.go"] {
		t.Error("main.go should be discovered")
	}
	// Note: .log files aren't a supported language, so they won't appear in Discover
	// results regardless. The gitignore negation is still effective — we test it
	// via the matcher directly.
	m := loadIgnoreMatchers(dir)
	if !m.shouldIgnore(filepath.Join(dir, "debug.log"), false) {
		t.Error("debug.log should be ignored")
	}
	if m.shouldIgnore(filepath.Join(dir, "important.log"), false) {
		t.Error("important.log should NOT be ignored (negated)")
	}
}

func TestGitignoreGlobstar(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)

	writeFile(t, filepath.Join(dir, ".gitignore"), "**/vendor/\n")
	writeFile(t, filepath.Join(dir, "main.go"), "package main\n")
	writeFile(t, filepath.Join(dir, "vendor", "lib.go"), "package vendor\n")
	writeFile(t, filepath.Join(dir, "src", "vendor", "dep.go"), "package vendor\n")

	found := discoverRelPaths(t, dir)
	if !found["main.go"] {
		t.Error("main.go should be discovered")
	}
	// vendor/ is also in IGNORE_PATTERNS, but the gitignore globstar should catch nested ones
	if found["src/vendor/dep.go"] {
		t.Error("src/vendor/dep.go should be ignored by **/vendor/ pattern")
	}
}

func TestGitignoreNested(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)

	writeFile(t, filepath.Join(dir, ".gitignore"), "*.txt\n")
	writeFile(t, filepath.Join(dir, "subdir", ".gitignore"), "!readme.txt\n")
	writeFile(t, filepath.Join(dir, "top.txt"), "top\n")
	writeFile(t, filepath.Join(dir, "subdir", "readme.txt"), "readme\n")
	writeFile(t, filepath.Join(dir, "subdir", "notes.txt"), "notes\n")

	// Test via matchers since .txt isn't a supported language
	m := loadIgnoreMatchers(dir)

	if !m.shouldIgnore(filepath.Join(dir, "top.txt"), false) {
		t.Error("top.txt should be ignored by root *.txt")
	}
	if m.shouldIgnore(filepath.Join(dir, "subdir", "readme.txt"), false) {
		t.Error("subdir/readme.txt should NOT be ignored (negated by subdir/.gitignore)")
	}
	if !m.shouldIgnore(filepath.Join(dir, "subdir", "notes.txt"), false) {
		t.Error("subdir/notes.txt should be ignored by root *.txt")
	}
}

func TestGitignoreExcludeFile(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)

	// Pattern only in .git/info/exclude
	writeFile(t, filepath.Join(dir, ".git", "info", "exclude"), "*.secret\n")
	writeFile(t, filepath.Join(dir, "main.go"), "package main\n")

	m := loadIgnoreMatchers(dir)
	if !m.shouldIgnore(filepath.Join(dir, "config.secret"), false) {
		t.Error("config.secret should be ignored by .git/info/exclude")
	}
	if m.shouldIgnore(filepath.Join(dir, "main.go"), false) {
		t.Error("main.go should not be ignored")
	}
}

func TestGitignoreNonGitRepo(t *testing.T) {
	dir := t.TempDir()
	// No .git directory

	writeFile(t, filepath.Join(dir, "main.go"), "package main\n")

	m := loadIgnoreMatchers(dir)
	if m.gitignore != nil {
		t.Error("gitignore should be nil for non-git repo")
	}

	// Discovery should still work with hardcoded patterns
	found := discoverRelPaths(t, dir)
	if !found["main.go"] {
		t.Error("main.go should be discovered in non-git repo")
	}
}

func TestGitignoreDirOnly(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)

	writeFile(t, filepath.Join(dir, ".gitignore"), "logs/\n")
	writeFile(t, filepath.Join(dir, "logs", "app.go"), "package logs\n")

	m := loadIgnoreMatchers(dir)
	// Directory should be ignored
	if !m.shouldIgnore(filepath.Join(dir, "logs"), true) {
		t.Error("logs/ directory should be ignored")
	}
	// File named "logs" should NOT be ignored (trailing slash = dir-only)
	if m.shouldIgnore(filepath.Join(dir, "logs"), false) {
		t.Error("file named 'logs' should NOT be ignored by 'logs/' pattern")
	}
}

func TestCBMIgnoreBasic(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)

	// .cbmignore with patterns that stack on top of .gitignore
	writeFile(t, filepath.Join(dir, ".cbmignore"), "generated/\n*.pb.go\n")
	writeFile(t, filepath.Join(dir, "main.go"), "package main\n")
	writeFile(t, filepath.Join(dir, "generated", "types.go"), "package generated\n")
	writeFile(t, filepath.Join(dir, "api.pb.go"), "package api\n")

	found := discoverRelPaths(t, dir)
	if !found["main.go"] {
		t.Error("main.go should be discovered")
	}
	if found["generated/types.go"] {
		t.Error("generated/types.go should be ignored by .cbmignore")
	}
	if found["api.pb.go"] {
		t.Error("api.pb.go should be ignored by .cbmignore")
	}
}

func TestCBMIgnoreStacksOnGitignore(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)

	// .gitignore ignores *.log
	writeFile(t, filepath.Join(dir, ".gitignore"), "*.log\n")
	// .cbmignore additionally ignores docs/
	writeFile(t, filepath.Join(dir, ".cbmignore"), "docs/\n")
	writeFile(t, filepath.Join(dir, "main.go"), "package main\n")
	writeFile(t, filepath.Join(dir, "docs", "api.go"), "package docs\n")

	m := loadIgnoreMatchers(dir)

	// Both matchers should work
	if !m.shouldIgnore(filepath.Join(dir, "app.log"), false) {
		t.Error("app.log should be ignored by .gitignore")
	}
	if !m.shouldIgnore(filepath.Join(dir, "docs"), true) {
		t.Error("docs/ should be ignored by .cbmignore")
	}
	if m.shouldIgnore(filepath.Join(dir, "main.go"), false) {
		t.Error("main.go should not be ignored")
	}

	// End-to-end via Discover
	found := discoverRelPaths(t, dir)
	if !found["main.go"] {
		t.Error("main.go should be discovered")
	}
	if found["docs/api.go"] {
		t.Error("docs/api.go should be ignored by .cbmignore")
	}
}

func TestCBMIgnoreWithoutGitRepo(t *testing.T) {
	dir := t.TempDir()
	// No .git — but .cbmignore should still work

	writeFile(t, filepath.Join(dir, ".cbmignore"), "scratch/\n")
	writeFile(t, filepath.Join(dir, "main.go"), "package main\n")
	writeFile(t, filepath.Join(dir, "scratch", "tmp.go"), "package scratch\n")

	found := discoverRelPaths(t, dir)
	if !found["main.go"] {
		t.Error("main.go should be discovered")
	}
	if found["scratch/tmp.go"] {
		t.Error("scratch/tmp.go should be ignored by .cbmignore")
	}
}

func TestSymlinkedFilesSkipped(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks require elevated privileges on Windows")
	}

	dir := t.TempDir()
	initGitRepo(t, dir)

	writeFile(t, filepath.Join(dir, "real.go"), "package main\n")
	if err := os.Symlink(filepath.Join(dir, "real.go"), filepath.Join(dir, "link.go")); err != nil {
		t.Fatal(err)
	}

	found := discoverRelPaths(t, dir)
	if !found["real.go"] {
		t.Error("real.go should be discovered")
	}
	// filepath.Walk uses Lstat, so symlinked files show ModeSymlink
	// Our check should skip them
	if found["link.go"] {
		t.Error("link.go (symlink) should be skipped")
	}
}

func TestSymlinkedDirsSkipped(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks require elevated privileges on Windows")
	}

	dir := t.TempDir()
	initGitRepo(t, dir)

	writeFile(t, filepath.Join(dir, "src", "main.go"), "package main\n")
	if err := os.Symlink(filepath.Join(dir, "src"), filepath.Join(dir, "src-link")); err != nil {
		t.Fatal(err)
	}

	found := discoverRelPaths(t, dir)
	if !found["src/main.go"] {
		t.Error("src/main.go should be discovered")
	}
	// filepath.Walk does NOT follow symlinked dirs, so src-link/ contents won't appear.
	// The symlinked dir entry itself should be skipped by our ModeSymlink check.
	if found["src-link/main.go"] {
		t.Error("src-link/main.go should not appear")
	}
}

func TestNewIgnorePatterns(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)

	// Create directories that should now be in IGNORE_PATTERNS
	dirs := []string{".next", ".terraform", "zig-cache", ".cargo", "elm-stuff", "bazel-out"}
	for _, d := range dirs {
		writeFile(t, filepath.Join(dir, d, "file.go"), "package x\n")
	}
	writeFile(t, filepath.Join(dir, "main.go"), "package main\n")

	found := discoverRelPaths(t, dir)
	if !found["main.go"] {
		t.Error("main.go should be discovered")
	}
	for _, d := range dirs {
		if found[d+"/file.go"] {
			t.Errorf("%s/file.go should be ignored by IGNORE_PATTERNS", d)
		}
	}
}

func TestGenericDirsNotIgnoredInFullMode(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)

	// bin, build, out were moved to fastIgnoreDirs — should be discovered in full mode
	dirs := []string{"bin", "build", "out"}
	for _, d := range dirs {
		writeFile(t, filepath.Join(dir, d, "main.go"), "package "+d+"\n")
	}

	found := discoverRelPaths(t, dir)
	for _, d := range dirs {
		if !found[d+"/main.go"] {
			t.Errorf("%s/main.go should be discovered in full mode", d)
		}
	}
}

func TestGenericDirsIgnoredInFastMode(t *testing.T) {
	dir := t.TempDir()
	initGitRepo(t, dir)

	dirs := []string{"bin", "build", "out"}
	for _, d := range dirs {
		writeFile(t, filepath.Join(dir, d, "main.go"), "package "+d+"\n")
	}

	files, err := Discover(context.Background(), dir, &Options{Mode: ModeFast})
	if err != nil {
		t.Fatal(err)
	}
	found := make(map[string]bool, len(files))
	for _, f := range files {
		found[f.RelPath] = true
	}

	for _, d := range dirs {
		if found[d+"/main.go"] {
			t.Errorf("%s/main.go should be ignored in fast mode", d)
		}
	}
}
