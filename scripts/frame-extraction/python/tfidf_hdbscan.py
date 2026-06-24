#!/usr/bin/env python3
# scripts/frame-extraction/python/tfidf_hdbscan.py
"""
TF-IDF + HDBSCAN clustering candidate for Cortex frame extraction Phase 2.

Reads a JSONL file of {"path", "text"} per line and writes a ClusterResult
JSON: {"algorithm", "parameters", "clusters", "total_files", "noise_count"}.

Determinism: TF-IDF is deterministic by construction. HDBSCAN is deterministic
given a fixed input ordering and library version — no random initialisation
in its default mode. We sort input rows by path on read so the input order
is stable, then sort cluster members by path on write.

CLI:
    python tfidf_hdbscan.py --in BLOBS_JSONL --out RESULT_JSON \\
        [--min-df INT] [--max-df FLOAT] [--min-cluster-size INT]
"""

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
import hdbscan


def build_co_change_distance(
    paths: list[str], pairs: list[dict]
) -> np.ndarray:
    """Build an (n, n) symmetric co-change DISTANCE matrix.

    Aligned with `paths` row order. Observed pair distance:
        sim = log(1 + count) / log(1 + max_count_in_corpus)
        dist = 1 - sim
    Unobserved pair: dist = 1.0. Diagonal: 0.0.
    Pairs whose endpoints aren't in `paths` are dropped silently.
    """
    n = len(paths)
    # 1.0 off-diagonal; zero out the diagonal at the end.
    dist = np.ones((n, n), dtype=np.float64)
    np.fill_diagonal(dist, 0.0)
    if not pairs:
        return dist

    path_to_idx = {p: i for i, p in enumerate(paths)}
    # First pass: filter to in-corpus pairs and find max_count.
    filtered: list[tuple[int, int, int]] = []
    max_count = 0
    for pair in pairs:
        a = pair.get("a")
        b = pair.get("b")
        count = pair.get("count", 0)
        if a is None or b is None or count <= 0:
            continue
        ia = path_to_idx.get(a)
        ib = path_to_idx.get(b)
        if ia is None or ib is None or ia == ib:
            continue
        filtered.append((ia, ib, int(count)))
        if count > max_count:
            max_count = count

    if max_count == 0:
        return dist  # no usable observations

    denom = math.log1p(max_count)  # log(1 + max_count); > 0 since max_count >= 1
    for ia, ib, count in filtered:
        sim = math.log1p(count) / denom
        d = 1.0 - sim
        dist[ia, ib] = d
        dist[ib, ia] = d
    return dist


def build_hierarchy_distance(
    paths: list[str], pairs: list[dict]
) -> np.ndarray:
    """Cosine-like DISTANCE matrix from shared-base pairs. Identical shape and
    saturation to the co-change matrix: observed pair → 1 - log1p(count)/log1p(max),
    unobserved → 1.0, diagonal 0.0. Endpoints not in `paths` are dropped."""
    return build_co_change_distance(paths, pairs)


def build_embedding_distance(
    paths: list[str], embeddings: dict[str, list[float]]
) -> np.ndarray:
    """Build an (n, n) symmetric cosine DISTANCE matrix from per-file embeddings.

    Aligned with `paths` row order. For a pair where BOTH files have an
    embedding: dist = 1 - cosine_similarity, clipped to [0, 2]. For a pair
    where either file lacks an embedding: dist = 1.0 (max topical distance) —
    same convention as the co-change unobserved-pair fallback, so files we
    cannot embed (no functions/methods defined) drift to noise rather than
    contaminating a real cluster. Diagonal: 0.0.

    Spike-only (embedding-signal experiment). The embeddings are the indexer's
    algorithmic per-function int8 vectors, mean-aggregated to file level by the
    caller. Deterministic by construction.
    """
    n = len(paths)
    dist = np.ones((n, n), dtype=np.float64)
    np.fill_diagonal(dist, 0.0)
    if not embeddings:
        return dist

    dim = len(next(iter(embeddings.values())))
    mat = np.zeros((n, dim), dtype=np.float64)
    has = np.zeros(n, dtype=bool)
    for i, p in enumerate(paths):
        v = embeddings.get(p)
        if v is None or len(v) != dim:
            continue
        mat[i] = v
        has[i] = True

    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normed = mat / norms
    sim = normed @ normed.T
    emb_dist = 1.0 - sim
    np.clip(emb_dist, 0.0, 2.0, out=emb_dist)

    # Only overwrite the default 1.0 where BOTH endpoints have an embedding.
    both = np.outer(has, has)
    dist[both] = emb_dist[both]
    np.fill_diagonal(dist, 0.0)
    return dist


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="inp", required=True, type=Path)
    parser.add_argument("--out", dest="outp", required=True, type=Path)
    parser.add_argument("--min-df", type=int, default=2,
                        help="TF-IDF min document frequency")
    parser.add_argument("--max-df", type=float, default=0.8,
                        help="TF-IDF max document frequency")
    parser.add_argument("--min-cluster-size", type=int, default=5,
                        help="HDBSCAN min_cluster_size")
    parser.add_argument("--min-samples", type=int, default=None,
                        help="HDBSCAN min_samples (default: HDBSCAN's own "
                             "default, which equals min_cluster_size)")
    parser.add_argument("--co-change", dest="co_change", type=Path, default=None,
                        help="Optional co-change JSONL (pair_count records). "
                             "When provided, combined with topical distance via --gamma.")
    parser.add_argument("--gamma", type=float, default=0.0,
                        help="Weight on co-change distance in [0, 1]. "
                             "Combined distance = (1-γ)·topical + γ·co_change. "
                             "Ignored when --co-change is not provided.")
    parser.add_argument("--embeddings", dest="embeddings", type=Path, default=None,
                        help="Spike: per-file embedding JSONL "
                             "({\"path\", \"embedding\":[floats]} per line). When "
                             "provided, blend embedding cosine distance via "
                             "--embed-gamma. Mutually exclusive with --co-change.")
    parser.add_argument("--embed-gamma", dest="embed_gamma", type=float, default=1.0,
                        help="Weight on embedding distance in [0, 1] (default 1.0 "
                             "= pure embedding). Combined = (1-eg)·topical + eg·embed. "
                             "Ignored when --embeddings is not provided.")
    parser.add_argument("--hierarchy", dest="hierarchy", type=Path, default=None,
                        help="Per-pair JSONL ({a,b,count}) of files sharing a "
                             "domain base class. Blended via --hier-gamma.")
    parser.add_argument("--hier-gamma", dest="hier_gamma", type=float, default=1.0,
                        help="Weight on hierarchy distance in [0,1] (default 1.0). "
                             "Combined = (1-hg)·dist + hg·hierarchy. Ignored when "
                             "--hierarchy is not provided.")
    args = parser.parse_args()

    if not 0.0 <= args.gamma <= 1.0:
        parser.error(f"--gamma must be in [0, 1], got {args.gamma}")
    if not 0.0 <= args.embed_gamma <= 1.0:
        parser.error(f"--embed-gamma must be in [0, 1], got {args.embed_gamma}")
    if not 0.0 <= args.hier_gamma <= 1.0:
        parser.error(f"--hier-gamma must be in [0, 1], got {args.hier_gamma}")
    if args.hierarchy is not None and not args.hierarchy.exists():
        parser.error(f"--hierarchy path does not exist: {args.hierarchy}")
    if args.embeddings is not None and args.co_change is not None:
        parser.error("--embeddings and --co-change are mutually exclusive in the spike")
    if args.embeddings is not None and not args.embeddings.exists():
        parser.error(f"--embeddings path does not exist: {args.embeddings}")
    if args.co_change is not None and not args.co_change.exists():
        # Fail loudly. Silently treating a typo'd path as "no co-change"
        # would produce an all-1.0 co-change matrix, which at γ>0 silently
        # poisons the combined distance.
        parser.error(f"--co-change path does not exist: {args.co_change}")

    # Read blobs. Sort by path for determinism — JSONL writers may not
    # guarantee order across runs.
    blobs = []
    with args.inp.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            blobs.append(json.loads(line))
    blobs.sort(key=lambda b: b["path"])

    if len(blobs) < args.min_cluster_size:
        # Not enough files to cluster. Emit a single noise cluster.
        # Load hierarchy pairs so hier_pairs_loaded is always emitted when
        # --hierarchy is provided (even in the early-exit path).
        hier_pairs_loaded_early = 0
        if args.hierarchy is not None:
            with args.hierarchy.open("r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        hier_pairs_loaded_early += 1
        early_params: dict = {
            "min_df": args.min_df,
            "max_df": args.max_df,
            "min_cluster_size": args.min_cluster_size,
            "skipped_reason": "fewer_files_than_min_cluster_size",
        }
        if args.hierarchy is not None:
            early_params["hier_gamma"] = args.hier_gamma
            early_params["hier_pairs_loaded"] = hier_pairs_loaded_early
        write_result(
            outp=args.outp,
            clusters=[],
            total_files=len(blobs),
            noise_count=len(blobs),
            noise_paths=[b["path"] for b in blobs],
            params=early_params,
        )
        return 0

    texts = [b["text"] for b in blobs]
    paths = [b["path"] for b in blobs]

    # TF-IDF over the corpus. Token pattern accepts identifiers including
    # digits and underscores; n-gram range 1..2 catches short phrases.
    vectorizer = TfidfVectorizer(
        min_df=args.min_df,
        max_df=args.max_df,
        ngram_range=(1, 2),
        token_pattern=r"(?u)\b[a-zA-Z_][a-zA-Z0-9_]+\b",
        lowercase=True,
    )
    matrix = vectorizer.fit_transform(texts)

    # HDBSCAN on cosine distance. Convert sparse TF-IDF → dense cosine
    # distance matrix; for the corpus sizes we care about (≤ ~10k files)
    # this is manageable memory-wise.
    # cosine_distance(a, b) = 1 - cosine_similarity(a, b), clipped to [0, 2].
    dense = matrix.toarray()
    norms = np.linalg.norm(dense, axis=1, keepdims=True)
    norms[norms == 0] = 1.0  # avoid div by zero for empty docs
    normed = dense / norms
    sim = normed @ normed.T
    topical_dist = 1.0 - sim
    np.clip(topical_dist, 0.0, 2.0, out=topical_dist)

    # Optional co-change distance term. Cold-start (no --co-change or
    # γ == 0) skips loading entirely — the pipeline is identical to
    # pure topical.
    co_change_pairs_loaded = 0
    if args.co_change is not None and args.gamma > 0:
        pairs = []
        with args.co_change.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                pairs.append(json.loads(line))
        co_change_pairs_loaded = len(pairs)
        co_change_dist = build_co_change_distance(paths, pairs)
        dist = (1.0 - args.gamma) * topical_dist + args.gamma * co_change_dist
        np.clip(dist, 0.0, 2.0, out=dist)
    elif args.embeddings is not None and args.embed_gamma > 0:
        # Spike: blend (or replace, at embed_gamma=1.0) topical distance with
        # the embedding cosine distance. TF-IDF is still fit above so
        # top_tokens_per_cluster (used by the labeler) stays available.
        embeddings: dict[str, list[float]] = {}
        with args.embeddings.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                p = rec.get("path")
                emb = rec.get("embedding")
                if p is not None and emb:
                    embeddings[p] = emb
        embed_dist = build_embedding_distance(paths, embeddings)
        dist = (1.0 - args.embed_gamma) * topical_dist + args.embed_gamma * embed_dist
        np.clip(dist, 0.0, 2.0, out=dist)
    else:
        dist = topical_dist

    hier_pairs_loaded = 0
    if args.hierarchy is not None and args.hier_gamma > 0:
        hpairs = []
        with args.hierarchy.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                hpairs.append(json.loads(line))
        hier_pairs_loaded = len(hpairs)
        hier_dist = build_hierarchy_distance(paths, hpairs)
        dist = (1.0 - args.hier_gamma) * dist + args.hier_gamma * hier_dist
        np.clip(dist, 0.0, 2.0, out=dist)

    # Blending + clipping can leave tiny float residue on the diagonal
    # (a normalized vector's self-cosine is ~1.0 but not bit-exactly 1.0,
    # so 1 - sim is ~1e-16 rather than 0). HDBSCAN tolerates it, but
    # silhouette_score with metric="precomputed" rejects any non-zero
    # diagonal. Force it to exactly zero so both consumers agree.
    np.fill_diagonal(dist, 0.0)

    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=args.min_cluster_size,
        min_samples=args.min_samples,
        metric="precomputed",
    )
    labels = clusterer.fit_predict(dist.astype(np.float64))

    # Algorithm-internal metrics. These live with the algorithm because
    # they're defined in its own feature space — silhouette is over the
    # cosine-distance matrix; top tokens are over the TF-IDF vocabulary.
    # The eval harness reads them as opaque numbers/strings.
    silhouette: float | None = None
    non_noise_mask = labels != -1
    distinct_non_noise = set(int(l) for l in labels if l != -1)
    if len(distinct_non_noise) >= 2 and int(non_noise_mask.sum()) >= 2:
        from sklearn.metrics import silhouette_score as _silhouette
        # Pass only non-noise rows so noise points don't inflate the score.
        silhouette = float(_silhouette(
            dist[non_noise_mask][:, non_noise_mask],
            labels[non_noise_mask],
            metric="precomputed",
        ))

    top_tokens_per_cluster: dict[str, list[str]] = {}
    if distinct_non_noise:
        feature_names = vectorizer.get_feature_names_out()
        for cid in sorted(distinct_non_noise):
            mask = labels == cid
            # Mean TF-IDF weight per feature within this cluster.
            cluster_mat = matrix[mask]
            mean_weights = np.asarray(cluster_mat.mean(axis=0)).flatten()
            top_indices = np.argsort(-mean_weights)[:10]
            top_tokens_per_cluster[str(cid)] = [
                str(feature_names[i]) for i in top_indices if mean_weights[i] > 0
            ]

    # Build clusters dict: id → [paths]. HDBSCAN returns -1 for noise.
    clusters_by_id: dict[int, list[str]] = {}
    for path, label in zip(paths, labels):
        clusters_by_id.setdefault(int(label), []).append(path)

    # Build the output. Noise is reported as a single cluster with id -1.
    noise_paths = sorted(clusters_by_id.pop(-1, []))
    non_noise = []
    for cid, members in clusters_by_id.items():
        non_noise.append({
            "cluster_id": cid,
            "member_paths": sorted(members),
        })
    # Sort by member count desc, then cluster_id asc.
    non_noise.sort(key=lambda c: (-len(c["member_paths"]), c["cluster_id"]))

    write_result(
        outp=args.outp,
        clusters=non_noise,
        total_files=len(blobs),
        noise_count=len(noise_paths),
        noise_paths=noise_paths,
        params={
            "min_df": args.min_df,
            "max_df": args.max_df,
            "min_cluster_size": args.min_cluster_size,
            "min_samples": args.min_samples,
            "vocabulary_size": len(vectorizer.vocabulary_),
            "silhouette_score": silhouette,
            "top_tokens_per_cluster": top_tokens_per_cluster,
            "gamma": args.gamma,
            "co_change_pairs_loaded": co_change_pairs_loaded,
            "embed_gamma": args.embed_gamma if args.embeddings is not None else None,
            "hier_gamma": args.hier_gamma if args.hierarchy is not None else None,
            "hier_pairs_loaded": hier_pairs_loaded,
        },
    )
    return 0


def write_result(*, outp, clusters, total_files, noise_count, noise_paths, params):
    """Write the ClusterResult JSON. Includes the noise cluster (-1) when
    non-empty so the output shape always reflects the full file set."""
    out_clusters = list(clusters)
    if noise_count > 0:
        out_clusters.append({
            "cluster_id": -1,
            "member_paths": noise_paths,
        })
    result = {
        "algorithm": "tfidf+hdbscan",
        "parameters": params,
        "clusters": out_clusters,
        "total_files": total_files,
        "noise_count": noise_count,
    }
    outp.parent.mkdir(parents=True, exist_ok=True)
    with outp.open("w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, sort_keys=False)
        f.write("\n")


if __name__ == "__main__":
    sys.exit(main())
