import type { DrawerView } from "../ui-store";

const same = (a: DrawerView, b: DrawerView) =>
  a.kind === "record" && b.kind === "record" ? a.type === b.type && a.id === b.id
    && (a.type !== "file" || a.symbol === b.symbol)
  : a.kind === "list" && b.kind === "list" ? a.tab === b.tab && a.frameId === b.frameId : false;

export const openReplace = (_s: DrawerView[], v: DrawerView): DrawerView[] => [v];
export const push = (s: DrawerView[], v: DrawerView): DrawerView[] =>
  s.length && same(s[s.length - 1], v) ? s : [...s, v];
export const pop = (s: DrawerView[]): DrawerView[] => s.slice(0, -1);
export const closeAll = (): DrawerView[] => [];
