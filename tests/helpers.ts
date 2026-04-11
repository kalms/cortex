import { GraphStore } from "../src/graph/store.js";

export function createTestStore(): GraphStore {
  return new GraphStore(":memory:");
}
