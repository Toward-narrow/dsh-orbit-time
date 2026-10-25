# Report the display scaling the widget will see.
#
# The pill is designed at 232x64 physical pixels. On a scaled display that is
# either too small (if the process is DPI aware) or bitmap-stretched and blurry
# (if it is not), so both the awareness call and the resulting geometry need to be
# observed rather than assumed.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$dpi = 96
try {
  $graphics = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
  $dpi = [int]$graphics.DpiX
  $graphics.Dispose()
} catch { }

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DpiProbe {
  [DllImport("user32.dll")] public static extern int GetDpiForSystem();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
}
'@
} catch { }

Write-Output "Graphics.DpiX (before awareness): $dpi"

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DpiSet {
  [DllImport("shcore.dll")] private static extern int SetProcessDpiAwareness(int value);
  public static int Apply(int value) { return SetProcessDpiAwareness(value); }
}
'@
} catch { }

try {
  $result = [DpiSet]::Apply(2)
  Write-Output "SetProcessDpiAwareness(2) returned: $result (0 = ok, 0x80070005 = already set)"
} catch {
  Write-Output "SetProcessDpiAwareness threw: $($_.Exception.Message)"
}

try {
  Write-Output "GetDpiForSystem(): $([DpiProbe]::GetDpiForSystem())"
} catch {
  Write-Output "GetDpiForSystem unavailable"
}

$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$f.ShowInTaskbar = $false
$f.ClientSize = New-Object System.Drawing.Size(232, 64)
Write-Output "ClientSize requested 232x64 -> Size=$($f.Size.Width)x$($f.Size.Height) ClientSize=$($f.ClientSize.Width)x$($f.ClientSize.Height)"

$screen = [System.Windows.Forms.Screen]::PrimaryScreen
Write-Output "Screen bounds: $($screen.Bounds.Width)x$($screen.Bounds.Height) work=$($screen.WorkingArea.Width)x$($screen.WorkingArea.Height)"
Write-Output "Scale implied by DPI: $([Math]::Round(100 * [DpiProbe]::GetDpiForSystem() / 96))%"
