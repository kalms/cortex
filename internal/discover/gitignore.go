package discover

import (
	"log/slog"
	"os"
	"path/filepath"

	gitignore "github.com/boyter/gocodewalker/go-gitignore"
)

// ignoreMatchers holds the layered ignore matchers for a repository.
// Evaluation order: hardcoded patterns (fastest) → gitignore → cbmignore.
type ignoreMatchers struct {
	gitignore gitignore.GitIgnore // .gitignore hierarchy + .git/info/exclude (nil for non-git repos)
	cbmignore gitignore.GitIgnore // .cbmignore at repo root (nil if absent)
}

// loadIgnoreMatchers loads all gitignore-style matchers for the repository.
// .gitignore is loaded only for git repos (presence of .git dir).
// .cbmignore stacks on top — patterns there additionally exclude from indexing.
func loadIgnoreMatchers(repoPath string) ignoreMatchers {
	var m ignoreMatchers

	// .gitignore — only for git repos
	gitDir := filepath.Join(repoPath, ".git")
	if info, err := os.Stat(gitDir); err == nil && info.IsDir() {
		gi, err := gitignore.NewRepository(repoPath)
		if err != nil {
			slog.Warn("discover.gitignore_load_err", "err", err)
		} else {
			m.gitignore = gi
		}
	}

	// .cbmignore — repo-root file with gitignore-style patterns
	cbmPath := filepath.Join(repoPath, ".cbmignore")
	if _, err := os.Stat(cbmPath); err == nil {
		ci, err := gitignore.NewFromFile(cbmPath)
		if err != nil {
			slog.Warn("discover.cbmignore_load_err", "err", err)
		} else {
			m.cbmignore = ci
		}
	}

	return m
}

// shouldIgnore checks if a path should be ignored by gitignore or cbmignore.
// absPath must be absolute; isDir indicates whether the path is a directory.
func (m *ignoreMatchers) shouldIgnore(absPath string, isDir bool) bool {
	if m.gitignore != nil {
		if match := m.gitignore.Absolute(absPath, isDir); match != nil && match.Ignore() {
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
