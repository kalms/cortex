import { describe, it, expect, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionPromotion } from "../../src/decisions/promotion.js";

describe("DecisionPromotion", () => {
  let store: GraphStore;
  let service: DecisionService;
  let promotion: DecisionPromotion;

  afterEach(() => {
    store?.close();
  });

  it("promotes a decision to team tier", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    promotion = new DecisionPromotion(store);

    const decision = service.create({
      title: "Logging standard",
      description: "desc",
      rationale: "rationale",
    });

    expect(decision.tier).toBe("personal");

    const promoted = promotion.promote(decision.id, "team");
    expect(promoted.tier).toBe("team");
    expect(promoted.title).toBe("Logging standard");
  });

  it("promotes a decision to public tier", () => {
    store = new GraphStore(":memory:");
    service = new DecisionService(store);
    promotion = new DecisionPromotion(store);

    const decision = service.create({
      title: "API versioning",
      description: "desc",
      rationale: "rationale",
    });

    const promoted = promotion.promote(decision.id, "public");
    expect(promoted.tier).toBe("public");
  });

  it("throws for non-existent decision", () => {
    store = new GraphStore(":memory:");
    promotion = new DecisionPromotion(store);

    expect(() => promotion.promote("fake", "team")).toThrow("Decision not found");
  });

  it("throws for non-decision nodes", () => {
    store = new GraphStore(":memory:");
    promotion = new DecisionPromotion(store);

    const fn = store.createNode({ kind: "function", name: "fn" });
    expect(() => promotion.promote(fn.id, "team")).toThrow("is not a decision");
  });
});
