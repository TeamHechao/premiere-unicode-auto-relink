# Architecture

The project has two independent paths.

`relink_media.py` parses a gzip or plain XML project, resolves a media path by
volume label, configured roots, and component-by-component NFC comparison, then
rewrites only `FilePath`, `ActualMediaFilePath`, `RelativePath`, and the matching
offline marker. It compares an XML signature before and after the edit so a
structural change aborts output. The source bytes are read again before writing,
and the output is verified after writing.

The UXP panel separates host access from matching and persistence:

- `core.js` handles path normalization, safe directory traversal, candidate
  ambiguity, file snapshots, and the guarded non-undoable relink transaction.
- `host.js` inventories the Premiere project. Any unreadable project item makes
  the inventory incomplete and stops the scan instead of silently skipping it.
- `store.js` uses the UXP plugin data directory for configuration, backups,
  journals, and reports. It writes exclusive transaction records and reads them
  back before continuing.
- `main.js` coordinates the visible panel, active-project identity, periodic
  scans, and the explicit user actions.

The matcher normalizes strings only for comparison. It always writes the exact
native path returned by the Windows filesystem. This is why existing names and
future downloads can remain untouched.
