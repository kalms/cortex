# 3D Graph Viewer — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Replaces:** Current 2D D3 force-directed viewer at `/viewer`

## Goal

Replace the existing 2D SVG graph viewer with a 3D WebGL viewer that is both visually impressive and functionally better at revealing structure in larger graphs (500–5,000 nodes). The graph should feel like something you want to explore while also making relationships between decisions, code entities, and references immediately legible.

## Approach

Use **3d-force-graph** — a purpose-built library for 3D force-directed graphs in WebGL. Built on Three.js, handles 5K+ nodes with instanced rendering. Includes orbit controls, click events, camera transitions, and force simulation (d3-force-3d) out of the box.

Loaded from CDN (unpkg). No build step, no npm dependency added to Cortex.

## Architecture

### Replacement, not addition

Same URL (`/viewer`), same API endpoint (`/api/graph`), same detail panel behavior. Three files change:

- `src/viewer/index.html` — swap D3 CDN script for 3d-force-graph CDN
- `src/viewer/graph-viewer.js` — rewrite: ~220 lines of D3/SVG → ~250 lines of 3d-force-graph/WebGL
- `src/viewer/style.css` — keep toolbar, detail panel, filters. Drop SVG-specific styles. Add canvas/responsive styles.

### Data flow (unchanged)

```
Browser loads /viewer
  → index.html loads graph-viewer.js
    → fetch("/api/graph") returns { nodes, edges }
      → 3d-force-graph renders nodes/edges in WebGL
        → Click node → detail panel (HTML overlay)
        → Search/filter → JS filters on existing data
```

## Visual Design

### Color palette (neon on black, no glow)

Flat colors — no bloom, no emissive materials, no drop shadows. The neon colors pop on their own against the black void.

**Nodes:**

| Kind       | Shape       | Color                    | Size     |
|------------|-------------|--------------------------|----------|
| decision   | Octahedron  | Electric amber `#ff9f1c` | Larger (6) |
| function   | Sphere      | Vivid teal `#2ec4b6`    | Medium (4) |
| component  | Sphere      | Neon mint `#06d6a0`     | Medium (4) |
| path       | Sphere      | Bright grey `#a0a0a0`   | Small (3)  |
| reference  | Box (cube)  | Hot violet `#cb5cff`    | Small (3)  |

**Edges by relation:**

| Relation        | Color                |
|-----------------|----------------------|
| CALLS / IMPORTS | Dark grey `#444`     |
| GOVERNS         | Amber `#ff9f1c`      |
| SUPERSEDES      | Hot pink `#ef476f`   |
| REFERENCES      | Violet `#cb5cff`     |

### Background

Pure black `#000`. No grid, no skybox.

### Node labels

Always visible as small text sprites near each node. Fade with distance from camera.

### Edge labels

Not shown by default. Visible on edge hover as a tooltip. Directional particles always animate along edges to show flow direction (subtle, small, using the edge's relation color).

## Interaction Design

### Desktop camera controls

- **Rotate:** Click + drag
- **Zoom:** Scroll wheel / trackpad pinch
- **Pan:** Cmd + click + drag (Mac) / Ctrl + click + drag (Windows)
- **Click-to-focus:** Click a node → camera smoothly animates to center on it
- **Reset:** Click empty space → camera returns to default position

### Mobile / touch controls

- **Rotate:** One-finger drag
- **Zoom:** Pinch
- **Pan:** Two-finger drag
- **Select node:** Tap → camera flies to node, detail panel slides up from bottom
- **Close panel:** Swipe down or tap ×

### Node interaction states

- **Hover:** Node color → white. Connected edges brighten to their relation color. (Labels are always visible — no change needed on hover.)
- **Selected:** Camera flies to node. Detail panel opens. Connected nodes stay full opacity, everything else dims to 15%.
- **Drag:** Nodes draggable in 3D. Pinned on drop.

### Search (unchanged behavior)

Same text input in toolbar. Matching nodes full opacity, non-matching 10%. Real-time filtering as you type.

### Kind filters (unchanged behavior)

Same checkboxes (functions, components, decisions, paths, references). Unchecked kinds hidden from scene entirely.

### Detail panel

- Desktop: Slide-in panel from right (same as current)
- Mobile (<768px): Slides up from bottom as a half-sheet
- Same fields: name, kind, tier, description, rationale, status, alternatives, connections, ID
- **New:** Connection items are clickable — clicking "→ GOVERNS authMiddleware" flies camera to that node
- Close button with `stopPropagation`

### Mobile layout (< 768px)

- Detail panel: bottom half-sheet instead of right side panel
- Toolbar: search collapses behind a search icon, filters behind a filter icon
- Node labels: slightly larger font for tap targets

## Dependencies

- `3d-force-graph` via CDN (unpkg) — includes Three.js, d3-force-3d
- No npm dependencies added to Cortex

## Testing

- Verify graph renders with seeded data (14 nodes, 14 edges)
- Verify all 5 node kinds render with correct shapes and colors
- Verify edge colors match relation types
- Verify click-to-focus camera animation
- Verify detail panel opens/closes
- Verify search highlighting
- Verify kind filter toggle
- Verify clickable connections in detail panel
- Verify mobile layout at < 768px viewport
- Verify orbit / zoom / pan controls
