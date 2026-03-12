package discover

import (
	"os"
	"path/filepath"
	"strings"
	"sync"

	gitignore "github.com/boyter/gocodewalker/go-gitignore"
)

// ignoreMatchers holds the layered ignore matchers for a repository.
// Evaluation order: hardcoded patterns (fastest) → gitignore → cbmignore.
type ignoreMatchers struct {
	gitignore *repoMatcher        // .gitignore hierarchy + .git/info/exclude (nil for non-git repos)
	cbmignore gitignore.GitIgnore // .cbmignore at repo root (nil if absent)
}

// loadIgnoreMatchers loads all gitignore-style matchers for the repository.
// .gitignore is loaded only for git repos (presence of .git dir).
// .cbmignore stacks on top — patterns there additionally exclude from indexing.
//
// All files are read and closed immediately — no file handle leaks.
// This is critical for Windows where open handles prevent t.TempDir() cleanup.
func loadIgnoreMatchers(repoPath string) ignoreMatchers {
	var m ignoreMatchers

	// .gitignore — only for git repos
	gitDir := filepath.Join(repoPath, ".git")
	if info, err := os.Stat(gitDir); err == nil && info.IsDir() {
		m.gitignore = newRepoMatcher(repoPath)
	}

	// .cbmignore — repo-root file with gitignore-style patterns
	m.cbmignore = safeLoadGitignore(filepath.Join(repoPath, ".cbmignore"))

	return m
}

// shouldIgnore checks if a path should be ignored by gitignore or cbmignore.
// absPath must be absolute; isDir indicates whether the path is a directory.
func (m *ignoreMatchers) shouldIgnore(absPath string, isDir bool) bool {
	if m.gitignore != nil {
		if m.gitignore.shouldIgnore(absPath, isDir) {
			return true
		}
	}
	if m.cbmignore != nil {
		if match := m.cbmignore.Absolute(absPath, isDir); match != nil && match.Ignore() {
			return true
		}
	}
	return false
}

// safeLoadGitignore reads a gitignore-style file and returns a GitIgnore matcher.
// The file is read completely and closed immediately — no handle leak.
// Returns nil if the file doesn't exist or can't be read.
func safeLoadGitignore(path string) gitignore.GitIgnore {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	base := filepath.Dir(path)
	return gitignore.New(strings.NewReader(string(content)), base, nil)
}

// repoMatcher implements gitignore-style matching across a repository's
// .gitignore hierarchy. It replaces the library's repository type to avoid
// file handle leaks (the library's NewWithErrors opens files but never closes them).
//
// Pattern matching uses the library's ignore.Relative() — only the hierarchy
// walker and file loading are reimplemented.
type repoMatcher struct {
	base    string
	exclude gitignore.GitIgnore            // .git/info/exclude patterns
	mu      sync.Mutex                     // protects cache
	cache   map[string]gitignore.GitIgnore // dir path → loaded .gitignore (nil = no file)
}

func newRepoMatcher(base string) *repoMatcher {
	m := &repoMatcher{
		base:  base,
		cache: make(map[string]gitignore.GitIgnore),
	}
	m.exclude = safeLoadGitignore(filepath.Join(base, ".git", "info", "exclude"))
	return m
}

// loadDir loads the .gitignore for a directory, caching the result.
func (m *repoMatcher) loadDir(dir string) gitignore.GitIgnore {
	m.mu.Lock()
	defer m.mu.Unlock()
	if gi, ok := m.cache[dir]; ok {
		return gi // may be nil (cached miss)
	}
	gi := safeLoadGitignore(filepath.Join(dir, ".gitignore"))
	m.cache[dir] = gi
	return gi
}

// shouldIgnore checks if an absolute path should be ignored according to
// the repository's .gitignore hierarchy, following standard git precedence:
// - child .gitignore overrides parent .gitignore
// - negation patterns (!) in child override matching patterns in parent
// - .git/info/exclude is checked last (lowest priority)
func (m *repoMatcher) shouldIgnore(absPath string, isDir bool) bool {
	if !strings.HasPrefix(absPath, m.base) {
		return false
	}
	if absPath == m.base {
		return false
	}

	rel, err := filepath.Rel(m.base, absPath)
	if err != nil {
		return false
	}
	rel = filepath.ToSlash(rel)
	if rel == "." {
		return false
	}

	return m.matchRel(rel, isDir)
}

// matchRel implements the core gitignore hierarchy matching algorithm.
// Mirrors the logic in the library's repository.Relative().
func (m *repoMatcher) matchRel(rel string, isDir bool) bool {
	rel = filepath.ToSlash(filepath.Clean(rel))
	if rel == "." {
		return false
	}

	// First: is the parent directory ignored?
	// An ignored parent means the child is also ignored.
	parent, local := splitPath(rel)
	if parent != "" {
		if m.matchRel(parent, true) {
			return true
		}
	}

	// Walk from the file's directory up to the repo root,
	// checking .gitignore at each level. First match wins.
	dir := parent
	curLocal := local
	for {
		absDir := filepath.Join(m.base, filepath.FromSlash(dir))
		if dir == "" {
			absDir = m.base
		}
		gi := m.loadDir(absDir)
		if gi != nil {
			if match := gi.Relative(curLocal, isDir); match != nil {
				return match.Ignore()
			}
		}

		if dir == "" {
			break
		}

		// Walk up: prepend the current directory component to local
		var last string
		dir, last = splitPath(dir)
		curLocal = last + "/" + curLocal
	}

	// Finally check .git/info/exclude (lowest priority)
	if m.exclude != nil {
		if match := m.exclude.Relative(rel, isDir); match != nil {
			return match.Ignore()
		}
	}

	return false
}

// splitPath splits a forward-slash path into parent and last component.
// "a/b/c" → ("a/b", "c"), "a" → ("", "a"), "" → ("", "")
func splitPath(p string) (parent, last string) {
	if p == "" {
		return "", ""
	}
	i := strings.LastIndex(p, "/")
	if i < 0 {
		return "", p
	}
	return p[:i], p[i+1:]
}
