import { describe, it, expect } from "vitest";
import { openReplace, push, pop, closeAll } from "../../src/viewer/app/drawer/drawer-stack.ts";

const rec = (id) => ({ kind: "record", type: "decision", id });

describe("drawer stack", () => {
  it("openReplace resets to a single view", () =>
    expect(openReplace([rec("a"), rec("b")], rec("c"))).toEqual([rec("c")]));
  it("push appends", () => expect(push([rec("a")], rec("b"))).toEqual([rec("a"), rec("b")]));
  it("push of the current top is a no-op", () =>
    expect(push([rec("a")], rec("a"))).toEqual([rec("a")]));
  it("pop removes the top, empty stays empty", () => {
    expect(pop([rec("a"), rec("b")])).toEqual([rec("a")]);
    expect(pop([])).toEqual([]);
  });
  it("closeAll empties", () => expect(closeAll()).toEqual([]));
});
