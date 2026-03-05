package pipeline

import (
	"strings"

	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// buildSymbolSummary creates a compact symbol list for File node enrichment.
// Format: "kind:name" where kind is func/method/class/interface/type/var/const/macro/field.
func buildSymbolSummary(nodes []*store.Node, moduleQN string) []string {
	symbols := make([]string, 0, len(nodes))
	for _, n := range nodes {
		if n.QualifiedName == moduleQN {
			continue
		}
		prefix := labelToSymbolPrefix(n.Label)
		if prefix == "" {
			continue
		}
		symbols = append(symbols, prefix+":"+n.Name)
	}
	return symbols
}

// tokenizeDecorator strips decorator syntax and splits into lowercase words.
// Example: "@login_required" → ["login", "required"]
// Example: "@GetMapping(\"/api\")" → ["mapping"] (stopword "get" filtered)
func tokenizeDecorator(dec string) []string {
	// Strip leading syntax: @, #[
	dec = strings.TrimPrefix(dec, "@")
	dec = strings.TrimPrefix(dec, "#[")
	dec = strings.TrimSuffix(dec, "]")
	// Strip arguments: everything from first ( onwards
	if idx := strings.Index(dec, "("); idx >= 0 {
		dec = dec[:idx]
	}
	// Split on delimiters: dots, underscores, hyphens, colons, slashes
	parts := strings.FieldsFunc(dec, func(r rune) bool {
		return r == '.' || r == '_' || r == '-' || r == ':' || r == '/'
	})
	// Split camelCase and collect lowercase words
	var words []string
	for _, part := range parts {
		for _, w := range splitCamelCase(part) {
			w = strings.ToLower(w)
			if len(w) >= 2 && !decoratorStopwords[w] {
				words = append(words, w)
			}
		}
	}
	return words
}

// splitCamelCase splits a string on lowercase→uppercase transitions.
// Example: "GetMapping" → ["Get", "Mapping"]
func splitCamelCase(s string) []string {
	if s == "" {
		return nil
	}
	var words []string
	start := 0
	for i := 1; i < len(s); i++ {
		if s[i] >= 'A' && s[i] <= 'Z' && s[i-1] >= 'a' && s[i-1] <= 'z' {
			words = append(words, s[start:i])
			start = i
		}
	}
	words = append(words, s[start:])
	return words
}

// decoratorStopwords are common words filtered from decorator tag candidates.
var decoratorStopwords = map[string]bool{
	"get": true, "set": true, "new": true, "class": true,
	"method": true, "function": true, "value": true, "type": true,
	"param": true, "return": true, "public": true, "private": true,
	"for": true, "if": true, "the": true, "and": true,
	"or": true, "not": true, "with": true, "from": true,
	"app": true, "router": true,
}

func labelToSymbolPrefix(label string) string {
	switch label {
	case "Function":
		return "func"
	case "Method":
		return "method"
	case "Class":
		return "class"
	case "Interface":
		return "interface"
	case "Type":
		return "type"
	case "Enum":
		return "enum"
	case "Variable":
		return "var"
	case "Macro":
		return "macro"
	case "Field":
		return "field"
	default:
		return ""
	}
}
