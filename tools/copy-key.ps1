<#
.SYNOPSIS
  Copies this project's publishable (anon) API key to the clipboard.

.DESCRIPTION
  Setup asks you to move a 46-character key from Supabase into the extension,
  and every manual route has a way to go wrong:

    - Selecting the key text in the dashboard copies its MASKED form. The mask
      is made of U+00B7 middle dots, so you end up pasting dots.
    - Piping the CLI through a console whose codepage isn't UTF-8 mangles any
      non-ASCII byte. UTF-8 0xC2 0xB7 arrives as the box-drawing character
      U+252C, which is how a stray "T" glyph ends up inside a key.
    - Header values must be Latin-1, so a bad key surfaces later as
      "String contains non ISO-8859-1 code point" from fetch(), which tells you
      nothing about what went wrong.

  This forces UTF-8, selects the key by its `type` field rather than by
  pattern-matching its text, and refuses to touch the clipboard unless what it
  got is clean printable ASCII.

.EXAMPLE
  .\tools\copy-key.ps1

.EXAMPLE
  .\tools\copy-key.ps1 -ProjectRef abcdefghijklmnop
#>
[CmdletBinding()]
param(
  # Defaults to project_id in supabase/config.toml.
  [string] $ProjectRef,

  # Grab the legacy anon JWT instead of the modern publishable key.
  [switch] $Legacy
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $ProjectRef) {
  $configPath = Join-Path $PSScriptRoot '..\supabase\config.toml'
  if (-not (Test-Path $configPath)) {
    throw "No -ProjectRef given, and no config.toml at $configPath"
  }
  $match = [regex]::Match((Get-Content $configPath -Raw), 'project_id\s*=\s*"([^"]+)"')
  if (-not $match.Success) { throw "Could not read project_id from $configPath" }
  $ProjectRef = $match.Groups[1].Value
}

# A shell opened before the CLI was installed won't have it on PATH, and PATH
# changes never reach a running shell. Fall back to the usual scoop location.
$exe = (Get-Command supabase -ErrorAction SilentlyContinue).Source
if (-not $exe) {
  $candidate = Join-Path $env:USERPROFILE 'scoop\shims\supabase.exe'
  if (Test-Path $candidate) { $exe = $candidate }
}
if (-not $exe) {
  throw "Supabase CLI not found. Install it, or open a new terminal so PATH refreshes."
}

Write-Host "Project : $ProjectRef"
Write-Host "CLI     : $exe"

$raw = & $exe projects api-keys --project-ref $ProjectRef -o json | Out-String
try { $entries = $raw | ConvertFrom-Json } catch {
  throw "Could not parse the CLI output as JSON. Are you logged in? Try: supabase login"
}
if (-not $entries) { throw "The CLI returned no keys for $ProjectRef." }

$wanted = if ($Legacy) { 'legacy' } else { 'publishable' }
$entry = $entries |
  Where-Object { $_.type -eq $wanted -and $_.api_key -notlike 'sb_secret*' -and $_.id -ne 'service_role' } |
  Select-Object -First 1

if (-not $entry) {
  Write-Host "No '$wanted' key found. The project exposes:" -ForegroundColor Yellow
  $entries | ForEach-Object { "  id=$($_.id)  name=$($_.name)  type=$($_.type)" }
  throw "Nothing matched type '$wanted'."
}

$key = [string]$entry.api_key

# Never hand back something that will fail confusingly three steps later.
$stray = [regex]::Match($key, '[^\x21-\x7e]')
if ($stray.Success) {
  throw ("Key contains U+{0:X4} at index {1}. Your console encoding is corrupting it - use the dashboard's copy button instead." -f [int][char]$stray.Value, $stray.Index)
}
if ($key -match '…|\.{3}') {
  throw "That's a masked preview, not a key."
}

Set-Clipboard -Value $key
Write-Host ""
Write-Host ("OK - {0} key, {1} chars, copied to clipboard." -f $entry.type, $key.Length) -ForegroundColor Green
Write-Host ("Starts with: {0}..." -f $key.Substring(0, [Math]::Min(18, $key.Length)))
