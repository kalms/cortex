package pipeline

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/DeusData/codebase-memory-mcp/internal/cbm"
)

// CompileFlags holds extracted compilation flags for a single file.
type CompileFlags struct {
	IncludePaths []string // -I and -isystem paths (resolved to absolute)
	Defines      []string // -D defines as "NAME=VALUE" or "NAME"
	Standard     string   // -std= value (e.g., "c++17", "c11")
}

// CompileFlagsMap maps relative file paths to their compile flags.
type CompileFlagsMap map[string]*CompileFlags

// compileCommandEntry is a single entry in compile_commands.json.
type compileCommandEntry struct {
	Directory string   `json:"directory"`
	File      string   `json:"file"`
	Command   string   `json:"command"`
	Arguments []string `json:"arguments"`
	Output    string   `json:"output"`
}

// loadCompileCommands searches for compile_commands.json in common locations
// relative to repoPath, parses it, and returns per-file compile flags.
func loadCompileCommands(repoPath string) CompileFlagsMap {
	candidates := []string{
		filepath.Join(repoPath, "compile_commands.json"),
		filepath.Join(repoPath, "build", "compile_commands.json"),
		filepath.Join(repoPath, "out", "compile_commands.json"),
	}

	// Also check cmake-build-* directories
	entries, _ := os.ReadDir(repoPath)
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), "cmake-build-") {
			candidates = append(candidates,
				filepath.Join(repoPath, e.Name(), "compile_commands.json"))
		}
	}

	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		result := parseCompileCommands(data, repoPath)
		if len(result) > 0 {
			slog.Info("compile_commands.loaded", "path", path, "entries", len(result))
			return result
		}
	}

	return nil
}

// parseCompileCommands parses compile_commands.json content and extracts
// per-file include paths, defines, and standard flags.
func parseCompileCommands(data []byte, repoPath string) CompileFlagsMap {
	var entries []compileCommandEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		slog.Warn("compile_commands.parse_err", "err", err)
		return nil
	}

	result := make(CompileFlagsMap, len(entries))
	for _, e := range entries {
		// Get the arguments list
		args := e.Arguments
		if len(args) == 0 && e.Command != "" {
			args = splitCommand(e.Command)
		}
		if len(args) == 0 {
			continue
		}

		flags := extractFlags(args, e.Directory)

		// Resolve file path to relative
		filePath := e.File
		if !filepath.IsAbs(filePath) && e.Directory != "" {
			filePath = filepath.Join(e.Directory, filePath)
		}
		relPath, err := filepath.Rel(repoPath, filePath)
		if err != nil || strings.HasPrefix(relPath, "..") {
			continue
		}
		relPath = filepath.ToSlash(relPath)

		result[relPath] = flags
	}

	return result
}

// extractFlags extracts -I, -isystem, -D, and -std= flags from compiler arguments.
func extractFlags(args []string, directory string) *CompileFlags {
	flags := &CompileFlags{}

	for i := 0; i < len(args); i++ {
		arg := args[i]

		// Include paths: -I<path> or -I <path>
		if strings.HasPrefix(arg, "-I") {
			path := arg[2:]
			if path == "" && i+1 < len(args) {
				i++
				path = args[i]
			}
			if path != "" {
				flags.IncludePaths = append(flags.IncludePaths, resolvePath(path, directory))
			}
			continue
		}

		// System include paths: -isystem <path>
		if arg == "-isystem" && i+1 < len(args) {
			i++
			flags.IncludePaths = append(flags.IncludePaths, resolvePath(args[i], directory))
			continue
		}

		// Defines: -D<name> or -D<name>=<value> or -D <name>
		if strings.HasPrefix(arg, "-D") {
			define := arg[2:]
			if define == "" && i+1 < len(args) {
				i++
				define = args[i]
			}
			if define != "" {
				flags.Defines = append(flags.Defines, define)
			}
			continue
		}

		// Standard: -std=c++17 etc.
		if strings.HasPrefix(arg, "-std=") {
			flags.Standard = arg[5:]
			continue
		}
	}

	return flags
}

// resolvePath resolves a path relative to a directory, returning absolute path.
func resolvePath(path, directory string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	if directory != "" {
		return filepath.Clean(filepath.Join(directory, path))
	}
	return filepath.Clean(path)
}

// getRelativeIncludeDirs returns include paths relative to repo root for a file.
// Used by cross-file include resolution (extractionCache uses repo-relative paths).
func (p *Pipeline) getRelativeIncludeDirs(relPath string) []string {
	if p.compileFlags == nil {
		return nil
	}
	flags, ok := p.compileFlags[relPath]
	if !ok || len(flags.IncludePaths) == 0 {
		return nil
	}
	var relDirs []string
	for _, absPath := range flags.IncludePaths {
		rel, err := filepath.Rel(p.RepoPath, absPath)
		if err != nil || strings.HasPrefix(rel, "..") {
			continue // outside repo — skip
		}
		relDirs = append(relDirs, filepath.ToSlash(rel))
	}
	return relDirs
}

// getAllRelativeIncludeDirs returns the union of all include dirs across all files.
// Used when resolving includes for files not in compile_commands.
func (p *Pipeline) getAllRelativeIncludeDirs() []string {
	if p.compileFlags == nil {
		return nil
	}
	seen := make(map[string]bool)
	var dirs []string
	for _, flags := range p.compileFlags {
		for _, absPath := range flags.IncludePaths {
			rel, err := filepath.Rel(p.RepoPath, absPath)
			if err != nil || strings.HasPrefix(rel, "..") {
				continue
			}
			relSlash := filepath.ToSlash(rel)
			if !seen[relSlash] {
				seen[relSlash] = true
				dirs = append(dirs, relSlash)
			}
		}
	}
	return dirs
}

// getCompileFlags returns ExtractionFlags for a file, or nil if no compile_commands data.
func (p *Pipeline) getCompileFlags(relPath string) *cbm.ExtractionFlags {
	if p.compileFlags == nil {
		return nil
	}
	flags, ok := p.compileFlags[relPath]
	if !ok {
		return nil
	}
	return &cbm.ExtractionFlags{
		IncludePaths: flags.IncludePaths,
		Defines:      flags.Defines,
	}
}

// splitCommand does a simple shell-like split of a command string.
// Handles basic quoting but not escapes.
func splitCommand(cmd string) []string {
	var args []string
	var current strings.Builder
	inQuote := byte(0)

	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		switch {
		case inQuote != 0:
			if c == inQuote {
				inQuote = 0
			} else {
				current.WriteByte(c)
			}
		case c == '"' || c == '\'':
			inQuote = c
		case c == ' ' || c == '\t':
			if current.Len() > 0 {
				args = append(args, current.String())
				current.Reset()
			}
		default:
			current.WriteByte(c)
		}
	}
	if current.Len() > 0 {
		args = append(args, current.String())
	}
	return args
}
