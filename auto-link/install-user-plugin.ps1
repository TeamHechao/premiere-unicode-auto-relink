#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$PremierePluginRoot = (Join-Path $env:APPDATA 'Adobe\UXP\Plugins\External'),
    [string]$BackupRoot = (Join-Path $env:APPDATA 'Adobe\UXP\PluginBackups')
)

$ErrorActionPreference = 'Stop'
$pluginId = 'com.hechao.premiere.unicode-link-v010'
$releaseFiles = @('core.js', 'host.js', 'store.js', 'main.js', 'index.html', 'manifest.json')

function Assert-PremiereClosed {
    if (Get-Process -Name 'Adobe Premiere Pro' -ErrorAction SilentlyContinue) {
        throw 'Save your work and close Premiere Pro before installing. The installer will not close it.'
    }
}

function Assert-OrdinaryAncestors([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        try {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw ('Reparse points are not supported: ' + $current)
            }
        } catch [System.Management.Automation.ItemNotFoundException] {}
        $parentItem = [IO.Directory]::GetParent($current)
        if (-not $parentItem) { break }
        $current = $parentItem.FullName
    }
}

function Assert-Child([string]$Path, [string]$Parent) {
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('Path escapes its intended parent: ' + $full)
    }
    Assert-OrdinaryAncestors $full
}

function Get-OrdinaryFiles([string]$Root) {
    $stack = New-Object 'System.Collections.Generic.Stack[string]'
    $stack.Push($Root)
    $prefix = $Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    while ($stack.Count -gt 0) {
        $directory = $stack.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw ('Linked entries are not supported: ' + $item.FullName)
            }
            if ($item.PSIsContainer) { $stack.Push($item.FullName); continue }
            [pscustomobject]@{
                Relative = $item.FullName.Substring($prefix.Length)
                Hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
            }
        }
    }
}

function Assert-Release([string]$Root, $Expected) {
    Assert-OrdinaryAncestors $Root
    $actual = @(Get-OrdinaryFiles $Root | Sort-Object Relative)
    if ($actual.Count -ne $Expected.Count) { throw ('Release file count mismatch: ' + $Root) }
    for ($i = 0; $i -lt $actual.Count; $i++) {
        if ($actual[$i].Relative -cne $Expected[$i].Relative -or $actual[$i].Hash -ne $Expected[$i].Hash) {
            throw ('Release SHA-256 mismatch: ' + $actual[$i].Relative)
        }
    }
}

if ($env:OS -ne 'Windows_NT') { throw 'This installer supports Windows only. See the README for UXP Developer Tool loading.' }
$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'plugin')).Path
Assert-OrdinaryAncestors $source
$expected = @(Get-OrdinaryFiles $source | Sort-Object Relative)
if ($expected.Count -ne $releaseFiles.Count -or @($expected | Where-Object { $_.Relative -cnotin $releaseFiles }).Count) {
    throw 'The plugin source contains missing or unexpected release files.'
}
$manifest = Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.id -cne $pluginId -or $manifest.manifestVersion -ne 5 -or $manifest.host.app -cne 'premierepro') {
    throw 'The plugin manifest does not match this installer.'
}
$parent = [IO.Path]::GetFullPath($PremierePluginRoot)
$backups = [IO.Path]::GetFullPath($BackupRoot)
$parentPrefix = $parent.TrimEnd('\', '/') + '\'
if ($backups.Equals($parent, [StringComparison]::OrdinalIgnoreCase) -or
    $backups.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Backups and staging must be outside the Premiere plugin loading directory.'
}
$target = Join-Path $parent $pluginId
Assert-Child $target $parent
Assert-OrdinaryAncestors $backups
Assert-PremiereClosed
if (-not $PSCmdlet.ShouldProcess($target, ('Install Premiere Unicode Auto Relink ' + $manifest.version))) { return }

[IO.Directory]::CreateDirectory($parent) | Out-Null
[IO.Directory]::CreateDirectory($backups) | Out-Null
$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
$stage = Join-Path $backups ($pluginId + '-stage-' + $runId)
$backup = Join-Path $backups ($pluginId + '-before-' + $runId)
$failed = Join-Path $backups ($pluginId + '-failed-' + $runId)
Assert-Child $stage $backups
Assert-Child $backup $backups
Assert-Child $failed $backups
$oldMoved = $false
$newMoved = $false

try {
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    foreach ($name in $releaseFiles) { Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $stage $name) }
    Assert-Release $stage $expected
    Assert-PremiereClosed
    Assert-Child $target $parent
    if (Test-Path -LiteralPath $target) {
        $oldFiles = @(Get-OrdinaryFiles $target | Sort-Object Relative)
        Move-Item -LiteralPath $target -Destination $backup
        $oldMoved = $true
        Assert-Release $backup $oldFiles
    }
    Assert-Child $stage $backups
    Move-Item -LiteralPath $stage -Destination $target
    $newMoved = $true
    Assert-Release $target $expected
    [pscustomobject]@{
        plugin_id = $pluginId
        version = $manifest.version
        installed = $target
        previous_backup = $(if ($oldMoved) { $backup } else { $null })
        verified_files = $expected.Count
        premiere_started = $false
        installed_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json
} catch {
    $failure = $_
    # Keep failed files outside the loader, and restore the previous installation.
    if ($newMoved -and (Test-Path -LiteralPath $target)) {
        Assert-Child $target $parent
        Assert-Child $failed $backups
        Move-Item -LiteralPath $target -Destination $failed
    }
    if ($oldMoved -and -not (Test-Path -LiteralPath $target)) {
        Assert-Child $backup $backups
        Assert-Child $target $parent
        Move-Item -LiteralPath $backup -Destination $target
    }
    Write-Warning ('Installation failed. Diagnostic files, if any, are retained at ' + $backups)
    throw $failure
}
