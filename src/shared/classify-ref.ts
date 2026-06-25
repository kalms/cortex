/** Classify a decision/todo governs/reference target as a qualified name or a
 *  file path. A qualified name (`dir/file.ts::sym`) also contains "/", so the
 *  "::" marker MUST be checked first. */
export function classifyGovernsTarget(target: string): "qn" | "path" {
  return target.includes("::") ? "qn" : target.includes("/") ? "path" : "qn";
}
