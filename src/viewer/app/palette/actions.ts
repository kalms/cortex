import type { IndexEntry } from "./search-index";
import { projectDisplayName } from "../display";

type Ctx = {
  projects: { name: string; root_path?: string | null }[];
  activeProject: string | null;
  layerPrefs: { showFrames: boolean; showDecisions: boolean; showTodos: boolean; layerTint: boolean };
  set: (p: any) => void;
  toggleTheme: () => void;
};

export function buildActions(ctx: Ctx): IndexEntry[] {
  const a = (label: string, sublabel: string, run: () => void): IndexEntry =>
    ({ group: "actions", label, sublabel, haystack: label, ref: { kind: "action", run } });
  const flip = (k: keyof Ctx["layerPrefs"]) =>
    ctx.set({ layerPrefs: { ...ctx.layerPrefs, [k]: !ctx.layerPrefs[k] } });
  return [
    a("Browse decisions & todos", "open the records list",
      () => ctx.set({ drawerStack: [{ kind: "list", tab: "all" }] })),
    ...ctx.projects.filter((p) => p.name !== ctx.activeProject).map((p) =>
      a(`Switch to ${projectDisplayName(p)}`, p.root_path || p.name,
        () => ctx.set({ activeProject: p.name }))),
    a(`${ctx.layerPrefs.showFrames ? "Hide" : "Show"} frames`, "layer toggle", () => flip("showFrames")),
    a(`${ctx.layerPrefs.showDecisions ? "Hide" : "Show"} decisions`, "layer toggle", () => flip("showDecisions")),
    a(`${ctx.layerPrefs.showTodos ? "Hide" : "Show"} todos`, "layer toggle", () => flip("showTodos")),
    a(`${ctx.layerPrefs.layerTint ? "Disable" : "Enable"} layer tint`, "layer toggle", () => flip("layerTint")),
    a("Toggle theme", "light / dark", ctx.toggleTheme),
  ];
}
