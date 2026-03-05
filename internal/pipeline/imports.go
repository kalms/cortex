package pipeline

import "log/slog"

// logImportDrop logs when an import edge cannot be created because the target node wasn't found.
func logImportDrop(moduleQN, localName, targetQN string) {
	slog.Debug("import.drop", "module", moduleQN, "local", localName, "target", targetQN)
}
