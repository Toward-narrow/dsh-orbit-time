# Can a click anywhere along the widget's control strip land on nothing?
#
# The strip used to be three 26 px buttons with 8 px between them: at 200% that
# is a 16 px dead band at each seam, and a click there is swallowed silently --
# which is exactly what "this button does not respond" looks like. This walks the
# whole strip, including the seams, and reports any coordinate that resolves to
# no control.
#
# Prints one JSON line for the calling test.
# ASCII only.

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing

$findings = New-Object System.Collections.ArrayList
$ok = $true

foreach ($scale in @(1.0, 1.25, 1.5, 2.0)) {
  $s = { param([double]$v) [int][Math]::Round($v * $scale) }
  $pillWidth = & $s 232
  $pillHeight = & $s 64
  $button = & $s 26
  $gap = & $s 8
  $edge = & $s 6
  $arm = [Math]::Max(3, (& $s 4))
  $stripTop = & $s 16
  $stripHeight = $pillHeight - 2 * $stripTop

  $closeRight = $pillWidth - $edge
  $closeLeft = $closeRight - $button
  $expandLeft = $closeLeft - $button - $gap
  $minLeft = $expandLeft - $button - $gap

  $hitClose = New-Object System.Drawing.Rectangle ($closeLeft - $arm), $stripTop, (($closeRight + $arm) - ($closeLeft - $arm)), $stripHeight
  $hitExpand = New-Object System.Drawing.Rectangle $expandLeft, $stripTop, ($hitClose.X - $expandLeft), $stripHeight
  $hitMin = New-Object System.Drawing.Rectangle $minLeft, $stripTop, ($hitExpand.X - $minLeft), $stripHeight
  $hitPlay = New-Object System.Drawing.Rectangle (& $s 10), ([int](($pillHeight - (& $s 44)) / 2)), (& $s 44), (& $s 44)

  # Same order as Get-PillHit in hud.ps1.
  function Resolve-Target($point) {
    if ($hitClose.Contains($point)) { return 'close' }
    if ($hitMin.Contains($point)) { return 'min' }
    if ($hitExpand.Contains($point)) { return 'expand' }
    if ($hitPlay.Contains($point)) { return 'play' }
    return 'drag'
  }

  # Walk the whole strip: from the left edge of the minimise region to the right
  # edge of the close region, at three heights.
  $startX = $hitMin.X
  $endX = $hitClose.Right - 1
  $dead = New-Object System.Collections.ArrayList
  foreach ($y in @($hitMin.Y, [int]($hitMin.Y + $hitMin.Height / 2), ($hitMin.Bottom - 1))) {
    for ($x = $startX; $x -le $endX; $x++) {
      $target = Resolve-Target (New-Object System.Drawing.Point $x, $y)
      if ($target -eq 'drag') { [void]$dead.Add("$x,$y") }
    }
  }

  # The seam coordinates are the ones that used to be dead, so name them.
  $seams = @($hitExpand.X, $hitClose.X)
  $seamY = $hitMin.Y + 1
  foreach ($sx in $seams) {
    $target = Resolve-Target (New-Object System.Drawing.Point $sx, $seamY)
    [void]$findings.Add(@{ scale = $scale; seam = $sx; target = $target })
    if ($target -eq 'drag') { $ok = $false }
  }

  [void]$findings.Add(@{
      scale = $scale
      dead = $dead.Count
      min = "$($hitMin.X)..$($hitMin.Right)"
      expand = "$($hitExpand.X)..$($hitExpand.Right)"
      close = "$($hitClose.X)..$($hitClose.Right)"
    })
  if ($dead.Count -gt 0) { $ok = $false }
}

# The minimise target should be comfortably wider than the drawn glyph (26 px).
$s2 = { param([double]$v) [int][Math]::Round($v * 2.0) }
$minWidth = ((& $s2 232) - (& $s2 6)) - ((& $s2 26) * 2 + (& $s2 8) * 2)
$minTarget = ((& $s2 232) - (& $s2 6) - (& $s2 26)) - ((& $s2 232) - (& $s2 6) - (& $s2 26) * 2 - (& $s2 8) * 2)

@{ ok = $ok; findings = $findings; minTargetWidth = $minTarget } | ConvertTo-Json -Depth 5 -Compress
