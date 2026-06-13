#Requires -Version 5.1
<#
.SYNOPSIS
    Install dispatch-mcp client-side assets into a project (Windows).

.DESCRIPTION
    Windows / PowerShell equivalent of install-client.sh. Installs the
    dispatch-worktree skill and the /dispatch-next slash command into
    a project's .claude/ directory. Project-local only — dispatch-worktree
    is scoped to the project that actually uses dispatch-mcp, not loaded
    into every Claude Code session on the machine.

    Self-contained: this script lives inside the skill it installs, so
    you can run it from anywhere.

.PARAMETER ProjectRoot
    Path to the project root (not the .claude directory). Defaults to the
    current working directory. The script creates/uses .claude\ under it.

.EXAMPLE
    PS> cd C:\work\myproject
    PS> C:\dispatch-mcp\skills\dispatch-worktree\scripts\install-client.ps1

    Installs into C:\work\myproject\.claude\

.EXAMPLE
    PS> C:\dispatch-mcp\skills\dispatch-worktree\scripts\install-client.ps1 C:\work\myproject

    Same as above but with explicit project root.

.NOTES
    If you hit an execution policy error, run with:
        powershell -ExecutionPolicy Bypass -File install-client.ps1
    or for one-shot bypass on the current session:
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

# ── Resolve paths ──────────────────────────────────────────────────
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
    Write-Error "Project root does not exist: $ProjectRoot"
    exit 1
}
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$Target = Join-Path $ProjectRoot '.claude'
$SkillSrc = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$CmdSrc = Join-Path $SkillSrc 'commands\dispatch-next.md'

if (-not (Test-Path -LiteralPath (Join-Path $SkillSrc 'SKILL.md'))) {
    Write-Error "Skill source missing at $SkillSrc (no SKILL.md)"
    exit 1
}
if (-not (Test-Path -LiteralPath $CmdSrc)) {
    Write-Error "Slash command source missing at $CmdSrc"
    exit 1
}

# ── Create target directories ──────────────────────────────────────
$TargetSkills = Join-Path $Target 'skills'
$TargetCommands = Join-Path $Target 'commands'
New-Item -ItemType Directory -Force -Path $TargetSkills | Out-Null
New-Item -ItemType Directory -Force -Path $TargetCommands | Out-Null

# ── Install the skill (replace if present) ─────────────────────────
# Note: pre-create the target dir and copy contents with a wildcard.
# `Copy-Item -Recurse` of a directory into an existing directory has
# historically been inconsistent across PowerShell versions, so this
# pattern is the most portable.
$InstalledSkill = Join-Path $TargetSkills 'dispatch-worktree'

# Detect the "user copied the skill in and is running the installer
# in place" flow: source and destination are the same directory.
# Don't destroy ourselves — just finalize the slash command below.
$InstalledSkillNorm =
    if (Test-Path -LiteralPath $InstalledSkill) {
        (Resolve-Path -LiteralPath $InstalledSkill).Path
    } else { $InstalledSkill }

if ($SkillSrc -eq $InstalledSkillNorm) {
    Write-Host "  skill already in place at $InstalledSkill"
    Write-Host '  (skipping copy — just finalizing slash command)'
}
else {
    if (Test-Path -LiteralPath $InstalledSkill) {
        Write-Host "  (replacing existing $InstalledSkill)"
        Remove-Item -LiteralPath $InstalledSkill -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $InstalledSkill | Out-Null
    Copy-Item -Path (Join-Path $SkillSrc '*') -Destination $InstalledSkill -Recurse -Force
}

# ── Install the slash command ──────────────────────────────────────
Copy-Item -LiteralPath $CmdSrc -Destination $TargetCommands -Force

# ── Report ─────────────────────────────────────────────────────────
$InstalledCmd = Join-Path $TargetCommands 'dispatch-next.md'
$WatcherPath = Join-Path $InstalledSkill 'scripts\dispatch-watch.js'

Write-Host ''
Write-Host 'Installed (project-local):'
Write-Host "  skill:    $InstalledSkill"
Write-Host "  command:  $InstalledCmd"
Write-Host "  watcher:  $WatcherPath"
Write-Host ''
Write-Host "Next: add dispatch-mcp to this project's .claude\claude.json with"
Write-Host 'your bearer token, then restart Claude Code in this project.'
Write-Host ''
Write-Host 'To start the event-driven watcher:'
Write-Host ''
Write-Host '  # The watcher uses tmux send-keys, which needs WSL or Git Bash'
Write-Host '  # with tmux installed. Inside that shell:'
Write-Host ''
Write-Host '  export DISPATCH_URL=http://YOUR_SERVER:7900/events'
Write-Host "  export DISPATCH_TOKEN='<your bearer token>'"
Write-Host '  export TMUX_TARGET="$(tmux display-message -p ''#{session_name}:#{window_index}.#{pane_index}'')"'
Write-Host '  node .claude/skills/dispatch-worktree/scripts/dispatch-watch.js'
Write-Host ''
Write-Host '(On native Windows without tmux, skip the watcher and trigger'
Write-Host ' tasks manually by typing /dispatch-next in Claude Code.)'
