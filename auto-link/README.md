# Premiere UXP panel

This folder contains the installable panel source. It keeps the media library
names unchanged and compares NFC/NFD spellings only during lookup.

Install from the repository root with:

```powershell
powershell -ExecutionPolicy Bypass -File .\auto-link\install-user-plugin.ps1
```

The installer checks that Premiere is closed, stages the panel, verifies every
file hash, keeps a versioned backup of an existing installation, and never
starts Premiere. The panel itself stores state in its UXP data folder; no source
checkout path is required at runtime.

The panel is intentionally conservative. It requires a saved project, a user-
selected media root, a complete project inventory, and one unique candidate.
It creates a project backup before the first host relink call and records each
transaction. A failed or interrupted transaction pauses future automatic scans
until the user checks it and acknowledges the record.
