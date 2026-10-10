Vendored JavaScript compiled from https://github.com/franzenzenhofer/chrome-tab-group-cleaner
at 3f9d94af3b150583777af27795225e29852a5f80, MIT, Franz Enzenhofer.
Only proto.ts, store.ts and tombstone.ts are included, without source-map comments.
store.js is hardened locally to close failed opens and remove failed snapshots.
The backup function requires an explicit plugin-owned destination; the upstream
global backup directory and environment variable are not used.
No CLI, browser shutdown code or dynamic download is used at runtime.
