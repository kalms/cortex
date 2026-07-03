/** Dependency-free subsequence scorer. 0 = no match. Bonuses: contiguous run,
 *  segment-boundary start (after / . - _ or start), penalty: target length. */
export function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase(), t = target.toLowerCase();
  let qi = 0, score = 0, prevHit = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let bonus = 1;
    if (ti === prevHit + 1) bonus += 2;                       // contiguous
    if (ti === 0 || "/._- ".includes(t[ti - 1])) bonus += 3;  // boundary
    score += bonus;
    prevHit = ti;
    qi++;
  }
  if (qi < q.length) return 0;
  return score + 10 / (10 + t.length);
}
