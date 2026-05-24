export class UsageError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class DomainError extends Error {
  constructor(message: string, public tip?: string) {
    super(message);
    this.name = "DomainError";
  }
}

export class EnvironmentError extends Error {
  constructor(message: string, public fix?: string) {
    super(message);
    this.name = "EnvironmentError";
  }
}

export function exitCodeFor(e: unknown): number {
  if (e instanceof UsageError) return 2;
  if (e instanceof DomainError) return 3;
  if (e instanceof EnvironmentError) return 4;
  return 1;
}

export function renderError(e: unknown): void {
  if (e instanceof UsageError) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    if (e.hint) process.stderr.write(`\n${e.hint}\n`);
    return;
  }
  if (e instanceof DomainError) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    if (e.tip) process.stderr.write(`\n${e.tip}\n`);
    return;
  }
  if (e instanceof EnvironmentError) {
    process.stderr.write(`ERROR: ${e.message}\n`);
    if (e.fix) process.stderr.write(`\nTo fix: ${e.fix}\n`);
    return;
  }
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`Error: ${msg}\n  (run with --debug to see stack)\n`);
  if (process.env.CORTEX_CLI_DEBUG === "1" && e instanceof Error && e.stack) {
    process.stderr.write(`\n${e.stack}\n`);
  }
}

export async function tryCommand(handler: () => Promise<void>): Promise<void> {
  try {
    await handler();
  } catch (e) {
    renderError(e);
    process.exit(exitCodeFor(e));
  }
}
