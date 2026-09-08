Vendored from npm, unmodified except as noted:

- `@trystero-p2p/core@0.25.4` → `core/` (all files, source maps stripped)
- `@trystero-p2p/torrent@0.25.4` → `torrent.mjs` (source map stripped; the
  bare `@trystero-p2p/core` import rewritten to a relative path — see the
  comment at the top of the file)

MIT licensed — see `LICENSE`. Upstream: https://github.com/dmotz/trystero

To upgrade: `npm pack @trystero-p2p/core@<version> @trystero-p2p/torrent@<version>`,
re-copy `dist/*.mjs` (excluding `.map`/`.d.mts`), strip `sourceMappingURL`
comments, and redo the import rewrite in `torrent.mjs`.
