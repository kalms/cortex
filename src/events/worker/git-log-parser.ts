/**
 * Parsed representation of a single git commit.
 *
 * `timestamp` is unix *seconds* (as produced by %at); caller converts to ms.
 * `files` are always post-rename paths.
 */
export interface ParsedCommit {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
  files: { path: string; status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' }[];
}

/**
 * Parses output of:
 *
 *   git log <range> --format=%H%x00%s%x00%an%x00%at --name-status
 *
 * Each commit is a line with 4 NUL-separated fields, followed by 0+ --name-status
 * lines, followed by a blank line. The blank line is omitted for the last commit
 * if the input is truncated.
 *
 * Pure function — no I/O. Paired with `git-watcher.ts` which handles the actual
 * spawning of `git log` and comparing to last-seen HEAD.
 */
export function parseGitLogOutput(raw: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  let current: ParsedCommit | null = null;

  for (const line of raw.split('\n')) {
    if (line === '') {
      if (current) commits.push(current);
      current = null;
      continue;
    }
    if (line.includes('\0')) {
      const [hash, message, author, tsStr] = line.split('\0');
      current = {
        hash,
        message,
        author,
        timestamp: parseInt(tsStr, 10),
        files: [],
      };
      continue;
    }
    if (!current) continue; // orphan line (shouldn't happen)
    // name-status line. Format: <STATUS>\t<path>  OR  <STATUS>\t<old>\t<new>
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const statusRaw = parts[0];
    const statusChar = statusRaw.charAt(0) as ParsedCommit['files'][number]['status'];
    const targetPath = parts.length >= 3 ? parts[parts.length - 1] : parts[1];
    current.files.push({ path: targetPath, status: statusChar });
  }
  if (current) commits.push(current);

  return commits;
}
