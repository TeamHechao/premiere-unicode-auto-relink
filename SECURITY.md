# Security and privacy

This project works with local Premiere projects and media paths. It does not
upload project files, media, credentials, or telemetry.

Do not commit `.prproj` files, audio/video files, machine-specific JSON
configuration, UXP runtime records, or logs. The repository `.gitignore` is a
guardrail, not a replacement for checking `git diff --cached` before publishing.

The UXP panel requests `localFileSystem: fullAccess` because Premiere must read
user-selected media roots and write a verified project backup. Configure the
media root deliberately and keep the plugin disabled until the root is correct.

Please report security issues privately to the repository owner before opening a
public issue. Include the affected version and a minimal reproduction, but do
not attach real projects or media.
