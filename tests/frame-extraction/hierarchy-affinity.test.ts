import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { parseBaseNames, collectHierarchyPairs } from "../../src/frame-extraction/hierarchy-affinity.js";

describe("parseBaseNames", () => {
  it("normalizes parens, dotted paths, comma lists, generics", () => {
    expect(parseBaseNames(["(nn.Module)"])).toEqual(["module"]);
    expect(parseBaseNames(["torch.nn.Module, LoraLayer"])).toEqual(["module", "loralayer"]);
    expect(parseBaseNames(["BaseTuner<T>"])).toEqual(["basetuner"]);
    expect(parseBaseNames(null)).toEqual([]);
  });
});

describe("collectHierarchyPairs", () => {
  function seed(): Database.Database {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, project TEXT, data TEXT);`);
    const ins = db.prepare("INSERT INTO nodes (kind,name,file_path,project,data) VALUES ('class',?,?,'p',?)");
    // Two subclasses of in-repo BaseTuner → one pair. nn.Module is external → dropped.
    ins.run("BaseTuner", "src/tuners/base.ts", JSON.stringify({}));
    ins.run("LoraTuner", "src/tuners/lora.ts", JSON.stringify({ base_classes: ["BaseTuner"] }));
    ins.run("OftTuner", "src/tuners/oft.ts", JSON.stringify({ base_classes: ["BaseTuner"] }));
    ins.run("Net", "src/models/net.ts", JSON.stringify({ base_classes: ["(nn.Module)"] }));
    return db;
  }
  it("pairs files sharing an in-repo base; drops external bases", () => {
    const pairs = collectHierarchyPairs(seed(), "p");
    expect(pairs).toEqual([{ a: "src/tuners/lora.ts", b: "src/tuners/oft.ts", count: 1 }]);
  });
});
