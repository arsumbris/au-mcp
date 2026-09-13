// The engine daemon's socket path (broker-internal).
//
// The au-mcp daemon's OWN socket path (`socketPath`, the client-facing one) ships
// with the mcp-sdk. This is the ENGINE socket the broker dials.
//
// The engine derives its socket by hashing the realpath'd ENTRY (a folder-repo
// DIRECTORY carrying `.arsumbris/repo.yaml`, schema 16) into an out-of-repo
// `$HOME/.arsumbris/au-engine/run/<hash>.sock` (its own device tenant) — the SUN_LEN
// fix. We reuse engine-sdk's `socketPath` verbatim so the broker dials exactly what
// the daemon binds, for the same entry folder; when engine-sdk moves that path, this
// re-export tracks it automatically.
export { socketPath as engineSocketPath } from '@arsumbris/au-engine-sdk'
