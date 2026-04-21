export type PRState = "draft" | "open" | "merged" | "closed";
export type PRSource = "native" | "mirror" | "scenario";
export type PRTouchAction = "added" | "modified";

export interface PRTouch {
  frame_id: string;
  node_name: string;
  action: PRTouchAction;
}

export interface PRExternalRef {
  provider: string;
  repo: string;
  number: number;
  url: string;
}

export interface PullRequest {
  id: string; // node UUID
  number: number; // display id, monotonic
  title: string;
  state: PRState;
  author: string | null;
  opened_at: string;
  merged_at: string | null;
  closed_at: string | null;
  branch: string | null;
  description: string | null;
  introduces_frame: string | null;
  additions: number;
  comment_count: number;
  last_activity_at: string | null;
  source: PRSource;
  external_ref: PRExternalRef | null;
  last_synced_at: string | null;
  touches: PRTouch[];
}

export interface OpenPRInput {
  title: string;
  author: string;
  description?: string | null;
  branch?: string | null;
  state?: PRState; // default 'open'
  introduces_frame?: string | null;
  additions?: number;
  source?: PRSource; // default 'native'
  external_ref?: PRExternalRef | null;
}

export interface AddPRTouchInput {
  pr_number: number;
  frame_id: string;
  node_name: string;
  action: PRTouchAction;
}

export interface PullRequestWithRefs extends PullRequest {
  introduces_decisions: string[]; // decision IDs
  implements_decisions: string[];
  challenges_decisions: string[];
  discusses_decisions: string[];
  linked_prs: { relation: "depends_on" | "related_to"; pr_number: number }[];
}
