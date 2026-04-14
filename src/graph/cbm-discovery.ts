import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CBM_DIR = join(homedir(), ".cache", "codebase-memory-mcp");

export function discoverCbmDb(
  rootPath: string,
  cbmDir: string = DEFAULT_CBM_DIR,
  explicitPath?: string
): string | null {
  // Explicit path takes priority
  if (explicitPath) {
    try {
      const db = new Database(explicitPath, { readonly: true });
      db.close();
      return explicitPath;
    } catch {
      return null;
    }
  }

  // Scan cbmDir for .db files
  let files: string[];
  try {
    files = readdirSync(cbmDir).filter((f) => f.endsWith(".db"));
  } catch {
    return null;
  }

  for (const file of files) {
    const dbPath = join(cbmDir, file);
    try {
      const db = new Database(dbPath, { readonly: true });
      const rows = db
        .prepare("SELECT root_path FROM projects WHERE root_path = ?")
        .all(rootPath) as Array<{ root_path: string }>;
      db.close();
      if (rows.length > 0) return dbPath;
    } catch {
      continue;
    }
  }

  return null;
}
