param(
  [string]$statePath = "",
  [string]$out = ""
)

# Orbit Time — pointer-space probe.
#
# Answers one question with measurements instead of reasoning: is
# [System.Windows.Forms.Cursor]::Position in the same space as a DPI-aware
# window's Location, or does it report logical (96 dpi) pixels?
#
# Method: put the real cursor over a used pixel of the widget, then compare the
# cursor position with the window rectangle two ways. The desktop screenshot is
# the tie-breaker, because CopyFromScreen is physical pixels by definition.
#
# ASCII only: this is a diagnostic, not part of the product.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

try {
  if (-not ('OtDpi' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OtDpi {
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] private static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern int GetDpiForSystem();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  public static void Apply() {
    try { SetProcessDpiAwareness(2); } catch { try { SetProcessDPIAware(); } catch { } }
  }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
}
'@
  }
  [OtDpi]::Apply()
} catch { }

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.ClientSize = New-Object System.Drawing.Size(232, 64)
$form.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 0)
$form.Location = New-Object System.Drawing.Point 200, 200
$form.Show()
$form.Activate()
[System.Windows.Forms.Application]::DoEvents()
Start-Sleep -Milliseconds 250
[System.Windows.Forms.Application]::DoEvents()

$dpi = [OtDpi]::GetDpiForSystem()
$windowDpi = [OtDpi]::GetDpiForWindow($form.Handle)

$rect = New-Object OtDpi+RECT
$null = [OtDpi]::GetWindowRect($form.Handle, [ref]$rect)

# Aim at the middle of the window, first with the managed API and then by
# converting the window's own Location, so the two disagree visibly if they are
# in different spaces.
$cx = [int](($rect.Left + $rect.Right) / 2)
$cy = [int](($rect.Top + $rect.Bottom) / 2)
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point $cx, $cy
Start-Sleep -Milliseconds 200
[System.Windows.Forms.Application]::DoEvents()

$cursor = [System.Windows.Forms.Cursor]::Position
$viaLocation = $form.PointToClient($cursor)
$viaRect = New-Object System.Drawing.Point (($cursor.X - $rect.Left), ($cursor.Y - $rect.Top))
$viaScreenToClient = $form.PointToClient($cursor)

# Where did the cursor land on the physical desktop? A black dot is painted at
# the middle of the window, so the screenshot says which coordinate space the
# cursor really occupies.
$shot = New-Object System.Drawing.Bitmap 40, 40
$g = [System.Drawing.Graphics]::FromImage($shot)
$g.CopyFromScreen(($cx - 20), ($cy - 20), 0, 0, (New-Object System.Drawing.Size 40, 40))
$g.Dispose()
$sampled = $shot.GetPixel(20, 20)
$shot.Dispose()

$report = [ordered]@{
  dpi = $dpi
  windowDpi = $windowDpi
  scale = [Math]::Round($dpi / 96.0, 3)
  formLocation = "$($form.Location.X),$($form.Location.Y)"
  formSize = "$($form.Size.Width)x$($form.Size.Height)"
  clientSize = "$($form.ClientSize.Width)x$($form.ClientSize.Height)"
  getWindowRect = "$($rect.Left),$($rect.Top) $($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top)"
  cursorAfterMove = "$($cursor.X),$($cursor.Y)"
  askedFor = "$cx,$cy"
  clientViaPointToClient = "$($viaLocation.X),$($viaLocation.Y)"
  clientViaWindowRect = "$($viaRect.X),$($viaRect.Y)"
  pixelAtCursor = "$($sampled.R),$($sampled.G),$($sampled.B)"
  sameSpaceAsLocation = ([Math]::Abs($rect.Left - $form.Location.X) -le 1)
}

$form.Hide()
$form.Dispose()

$text = ($report | ConvertTo-Json -Compress)
Write-Output $text
if ($out -ne '') { [System.IO.File]::WriteAllText($out, $text, (New-Object System.Text.UTF8Encoding($false))) }
