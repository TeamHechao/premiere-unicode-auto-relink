# Premiere Unicode Auto Relink

公开仓库：[github.com/TeamHechao/premiere-unicode-auto-relink](https://github.com/TeamHechao/premiere-unicode-auto-relink)

Premiere Pro can keep a Mac path such as `/Volumes/Media/...` and a filename
written in decomposed Unicode (NFD). A Windows copy of the same post-production
package may display the same Japanese text while storing the filename in
composed Unicode (NFC). A byte-for-byte lookup then reports the media offline.

This repository provides two conservative tools:

- `auto-link/` is a Premiere UXP panel. Set the local media library once; while
  the panel is visible it compares each path component in NFC without renaming,
  copying, moving, or transcoding media. Only one unambiguous offline audio
  match is changed. New BGM files are found on the next scan automatically.
- `relink_media.py` is an offline `.prproj` copy tool for projects that cannot be
  opened in Premiere yet. It creates a backup, writes a new project, and leaves
  ambiguous or missing files unresolved.

The repository contains source code and synthetic tests only. It does not contain
the original project, media, private drive paths, or generated repair output.

## UXP panel

Requirements: Premiere Pro 25.6 or newer, UXP manifest version 5, and a saved
`.prproj` project. The panel asks for full local file access because it must read
the user-selected media root and write a backup beside its plugin data. It never
starts Premiere or opens a project on its own.

1. Close Premiere Pro.
2. Run `auto-link/install-user-plugin.ps1` from PowerShell.
3. Start Premiere, open `Window > UXP Plugins > 素材自动补链`, and choose the
   actual post-production package folder.
4. Add any old package directory names in the settings area when the package was
   renamed. Keep automatic checking disabled until the root is correct.
5. For the most predictable first test, use the panel's `打开工程并补链` button.
   Ordinary double-click opening may show Premiere's locate dialog before a panel
   can run; this repository does not claim to intercept that path.
6. Review the report and save the project yourself after checking the media.

The plugin stores configuration, backups, journals, and runtime reports in its
UXP data folder, not in the source checkout. A prepared transaction pauses future
automatic work until it is acknowledged in the panel. The host API call is
non-undoable, so the plugin backs up the saved project and rechecks the project,
clip, and candidate file immediately before the call.

## Offline copy tool

The Python tool uses only the standard library. Copy the example config and edit
the roots, or pass a root directly:

```powershell
py -3 relink_media.py --media-root 'D:\Media\PostPackage' 'D:\Projects\episode.prproj'
```

For a dry run:

```powershell
py -3 relink_media.py --dry-run --config .\素材位置.json 'D:\Projects\episode.prproj'
```

Each normal run writes a timestamped directory under `outputs/` containing the
original bytes, a repaired copy when there are changes, a JSON report, and a
Chinese text report. The input project and media names are not changed.

## Tests

```powershell
node --test auto-link/tests/*.test.cjs
node --check auto-link/plugin/core.js
node --check auto-link/plugin/host.js
node --check auto-link/plugin/store.js
node --check auto-link/plugin/main.js
python -m unittest discover -v
```

Tests cover NFC/NFD path matching, new files, path traversal, duplicate
candidates, links, file replacement, project/reference changes during logging,
transaction journals, failed host readback, gzip projects, backups, and repeat
runs.

## Known limits

The panel only handles saved projects and audio extensions listed in the source.
It stops on incomplete Premiere inventory, proxies, merged clips, multicam clips,
non-unique candidates, inaccessible roots, and unfinished transactions. It does
not modify filenames and cannot recreate missing media. Premiere's actual host
load, playback, and save behavior must still be checked by the editor; no such
full application acceptance is claimed by the automated tests.

See [`docs/architecture.md`](docs/architecture.md),
[`docs/limitations.md`](docs/limitations.md), and
[`docs/troubleshooting.md`](docs/troubleshooting.md) for details.
