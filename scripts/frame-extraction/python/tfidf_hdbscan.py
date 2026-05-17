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
import sys
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
import hdbscan


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
    args = parser.parse_args()

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
        write_result(
            outp=args.outp,
            clusters=[],
            total_files=len(blobs),
            noise_count=len(blobs),
            noise_paths=[b["path"] for b in blobs],
            params={
                "min_df": args.min_df,
                "max_df": args.max_df,
                "min_cluster_size": args.min_cluster_size,
                "skipped_reason": "fewer_files_than_min_cluster_size",
            },
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
    dist = 1.0 - sim
    np.clip(dist, 0.0, 2.0, out=dist)

    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=args.min_cluster_size,
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
            "vocabulary_size": len(vectorizer.vocabulary_),
            "silhouette_score": silhouette,
            "top_tokens_per_cluster": top_tokens_per_cluster,
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
