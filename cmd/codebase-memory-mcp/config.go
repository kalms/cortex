package main

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// configDefaults documents all known config keys, their defaults, and descriptions.
var configDefaults = []struct {
	Key         string
	Default     string
	Description string
}{
	{store.ConfigAutoIndex, "false", "Enable background auto-indexing on MCP session start"},
	{store.ConfigAutoIndexLimit, "50000", "Max files for auto-indexing new (never-indexed) projects"},
	{store.ConfigMemLimit, "", "GOMEMLIMIT for the server process (e.g. 2G, 512M). Empty = no limit"},
}

func runConfig(args []string) int {
	if len(args) == 0 {
		printConfigHelp()
		return 0
	}

	switch args[0] {
	case "list", "ls":
		return configList()
	case "get":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: codebase-memory-mcp config get <key>")
			return 1
		}
		return configGet(args[1])
	case "set":
		if len(args) < 3 {
			fmt.Fprintln(os.Stderr, "Usage: codebase-memory-mcp config set <key> <value>")
			return 1
		}
		return configSet(args[1], args[2])
	case "reset":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: codebase-memory-mcp config reset <key>")
			return 1
		}
		return configReset(args[1])
	case "--help", "-h", "help":
		printConfigHelp()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "Unknown config command: %s\n", args[0])
		printConfigHelp()
		return 1
	}
}

func configList() int {
	cfg, err := store.OpenConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	defer cfg.Close()

	all, err := cfg.All()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}

	// Merge with defaults to show all known keys
	merged := make(map[string]string)
	for _, d := range configDefaults {
		merged[d.Key] = d.Default
	}
	for k, v := range all {
		merged[k] = v
	}

	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	fmt.Println("Configuration:")
	for _, k := range keys {
		v := merged[k]
		source := "default"
		if _, ok := all[k]; ok {
			source = "set"
		}
		desc := configDescription(k)
		fmt.Printf("  %-25s = %-10s  (%s) %s\n", k, v, source, desc)
	}
	return 0
}

func configGet(key string) int {
	cfg, err := store.OpenConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	defer cfg.Close()

	defVal := configDefaultValue(key)
	val := cfg.Get(key, defVal)
	fmt.Println(val)
	return 0
}

func configSet(key, value string) int {
	// Validate known keys
	if !isKnownConfigKey(key) {
		fmt.Fprintf(os.Stderr, "Unknown config key: %s\n", key)
		fmt.Fprintf(os.Stderr, "Known keys: %s\n", knownConfigKeys())
		return 1
	}

	// Validate mem_limit
	if key == store.ConfigMemLimit && value != "" {
		if _, err := parseByteSize(value); err != nil {
			fmt.Fprintf(os.Stderr, "Invalid value for %s: %q (expected size like 2G, 512M, 4096M)\n", key, value)
			return 1
		}
	}

	// Validate bool keys
	if key == store.ConfigAutoIndex {
		v := strings.ToLower(value)
		if v != "true" && v != "false" && v != "on" && v != "off" && v != "1" && v != "0" {
			fmt.Fprintf(os.Stderr, "Invalid value for %s: %q (expected true/false)\n", key, value)
			return 1
		}
		// Normalize
		switch v {
		case "on", "1":
			value = "true"
		case "off", "0":
			value = "false"
		default:
			value = v
		}
	}

	cfg, err := store.OpenConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	defer cfg.Close()

	if err := cfg.Set(key, value); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	fmt.Printf("%s = %s\n", key, value)
	return 0
}

func configReset(key string) int {
	cfg, err := store.OpenConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	defer cfg.Close()

	if err := cfg.Delete(key); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	fmt.Printf("%s reset to default (%s)\n", key, configDefaultValue(key))
	return 0
}

func printConfigHelp() {
	fmt.Fprintf(os.Stderr, `Usage: codebase-memory-mcp config <command> [args]

Commands:
  list             Show all config values (with defaults)
  get <key>        Get a config value
  set <key> <val>  Set a config value
  reset <key>      Reset a key to its default

Config keys:
`)
	for _, d := range configDefaults {
		fmt.Fprintf(os.Stderr, "  %-25s  default=%-10s  %s\n", d.Key, d.Default, d.Description)
	}
	fmt.Fprintf(os.Stderr, `
Examples:
  codebase-memory-mcp config set auto_index true     Enable auto-indexing on session start
  codebase-memory-mcp config set auto_index false    Disable auto-indexing (default)
  codebase-memory-mcp config set auto_index_limit 20000
  codebase-memory-mcp config list                    Show all settings
`)
}

func configDefaultValue(key string) string {
	for _, d := range configDefaults {
		if d.Key == key {
			return d.Default
		}
	}
	return ""
}

func configDescription(key string) string {
	for _, d := range configDefaults {
		if d.Key == key {
			return d.Description
		}
	}
	return ""
}

func isKnownConfigKey(key string) bool {
	for _, d := range configDefaults {
		if d.Key == key {
			return true
		}
	}
	return false
}

func knownConfigKeys() string {
	keys := make([]string, len(configDefaults))
	for i, d := range configDefaults {
		keys[i] = d.Key
	}
	return strings.Join(keys, ", ")
}
