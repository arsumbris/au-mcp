# au-mcp tool defs

One `mcp.tool.<tool>.type.yaml` file per callable, split from the former
`tools.yamls` bundle (decision 2608031622). The convention:

The first-party tool vocabulary owned by au-mcp: one `mcp.tool.<tool>` SUBTYPE per
callable plugin (decision 2606191044, model B). A subtype's FIELDS ARE its call-input
shape. Its `meta:` carries: a `plugin-runtime-meta` block (loadable-code + orchestration
data, vendored from au-mcp-sdk) AND a `tool-presentation-meta` block (the agent-facing
description, decision 2606251602 — the daemon surfaces it on the manifest, the adapter
forwards it; descriptions no longer live in the adapter). Field shapes mirror the actual
input the daemon reads in src/plugins/{files,engine}.ts. The engine validates a tool's
input against its subtype at the gate (daemon-side, in `invoke`); discovery enumerates
these via the engine `subtypes('mcp.tool')` read.

Hand-authored until au-type-codegen generates the TS face. `mcp.tool` is OPEN, so
unknown input keys ride as extras; required fields are enforced.
Tool name = plugin id minus the `mcp.` prefix (mcp.read_file_pinned -> read_file_pinned ->
mcp.tool.read_file_pinned). `entry` is relative to the au-mcp package root; first-party tools
run as in-process manifest literals today (plan 6b.3 wires meta-driven loading), so the
entry is a faithful forward pointer (many tools share one module; per-export resolution
is a 6b.3 concern). Engine-read tools (au_*) only surface when an engine is present.
