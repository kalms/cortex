/**
 * Connector interface for Phase 2 external system integration (Jira, Confluence, etc.).
 * Phase 1 only defines the interface — no implementations.
 */
export interface ExternalConnector {
  readonly name: string;
  search(query: string): Promise<ExternalReference[]>;
  resolve(id: string): Promise<ExternalReference | null>;
}

export interface ExternalReference {
  id: string;
  source: string;
  title: string;
  url: string;
  metadata: Record<string, unknown>;
}
