import { create } from "zustand";
import type { ProjectInfo } from "./api";

export type DrawerView =
  | { kind: "record"; type: "decision" | "todo" | "file"; id: string; symbol?: string }
  /** `frameId` scopes the list to one frame's records (marginalia "View all"). */
  | { kind: "list"; tab: "all" | "decisions" | "todos"; frameId?: string };

/** localStorage keys — literal strings copied from canvas/engine.js so React
 *  writes the SAME keys the engine reads at boot. */
export const LS_KEYS = {
  layers: "cortex.viewer.layers",
  frames: "cortex.viewer.show.frames",
  decisions: "cortex.viewer.show.decisions",
  todos: "cortex.viewer.show.todos",
  presence: "cortex.viewer.show.presence",
};

/** One roster entry per active session, as emitted by engine.onPresenceRoster. */
export type Roster = { sessionId: string; workspace: string; colorIdx: number; idle: boolean; lastSeenMs: number };

type UiState = {
  theme: "dark" | "light";
  projects: ProjectInfo[];
  activeProject: string | null;
  syncStatus: string;               // 'live' | 'offline' | … (ws-client statuses)
  syncVisible: boolean;
  layerPrefs: { showFrames: boolean; showDecisions: boolean; showTodos: boolean; layerTint: boolean; showPresence: boolean };
  presenceRoster: Roster[];
  framesWarning: string | null;
  bundle: any | null;               // latest adaptProjectData result
  drawerStack: DrawerView[];
  paletteOpen: boolean;
  focusedFrameId: string | null;
  removedSnapshots: Record<string, any>;
  set: (p: Partial<UiState>) => void;
};

export const useUiStore = create<UiState>((set) => ({
  theme: "dark",
  projects: [], activeProject: null,
  syncStatus: "offline", syncVisible: false,
  layerPrefs: { showFrames: true, showDecisions: true, showTodos: true, layerTint: false, showPresence: true },
  presenceRoster: [],
  framesWarning: null,
  bundle: null,
  drawerStack: [],
  paletteOpen: false,
  focusedFrameId: null,
  removedSnapshots: {},
  set: (p) => set(p),
}));
