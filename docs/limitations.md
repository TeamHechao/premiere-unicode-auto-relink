# Limitations

- Premiere Pro 25.6 or newer is required for the documented UXP project and clip
  APIs. Other versions may reject the manifest or expose different behavior.
- The panel needs a saved project with a stable path and GUID. Unsaved projects
  are refused because a recoverable backup and project identity cannot be proven.
- The current panel targets audio extensions: `mp3`, `wav`, `m4a`, `aac`, `aif`,
  `aiff`, `flac`, and `ogg`.
- A folder must be selected explicitly. The plugin does not crawl a whole drive.
  The stored root is local to the current machine; another machine selects its
  own root once.
- Matching is by the complete relative suffix below a configured library name.
  Same display names with different content, multiple roots, symlinked entries,
  missing files, and repeated library anchors remain unresolved.
- Proxies, merged clips, multicam clips, sequences, and any clip whose host state
  cannot be confirmed are left alone.
- `changeMediaFilePath` is a non-undoable Premiere host operation. A saved project
  backup and transaction journal are required, but the user must still review and
  save the project in Premiere.
- The repository tests do not replace an application-level Premiere test. They do
  not claim that every Premiere release, codec, plugin, or project variant loads
  and plays correctly after relinking.
