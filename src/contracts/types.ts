export type Role = "provides" | "consumes";

/** One side of a contract: a tool's keys as seen at one call/handler. */
export interface Binding {
  tool: string;        // anchor key, e.g. "detect_changes"
  role: Role;
  keys: readonly string[];  // arg keys sent (consumer) or read (provider)
  file: string;        // repo-relative source path
  symbol: string;      // enclosing symbol, e.g. "handle_detect_changes"
  line: number;        // 1-based line of the call/handler
}

export interface ContractMismatch {
  tool: string;
  provider_keys: string[];
  consumer_keys: string[];
  missing_on_provider: string[]; // sent by a consumer, never read by the provider
  missing_on_consumer: string[]; // read by the provider, never sent by a consumer
}

export interface CoverageReport {
  anchors: number;        // distinct tools seen
  providers: number;      // provider bindings
  consumers: number;      // consumer bindings
  matched: number;        // tools with >=1 provider AND >=1 consumer
  provider_only: string[];// tools with a handler but no caller
  consumer_only: string[];// tools called but with no handler
  unrecognized: number;   // call shapes seen but not parseable into keys
}

export type ContractResult =
  | { status: "ok"; anchors: number; mismatches: number; elapsedMs: number }
  | { status: "skipped"; reason: "disabled" | "no_db" }
  | { status: "failed"; reason: string };
