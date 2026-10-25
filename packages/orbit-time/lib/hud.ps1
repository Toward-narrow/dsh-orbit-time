# Orbit Time — always-on-top desktop HUD.
#
# Spawned by the Orbit Time host plugin. It is a separate process on purpose:
# the DSH Electron main process exposes no window API to plugins, so a genuine
# topmost, taskbar-free widget has to own its own window.
#
# Three states, owned entirely by the widget — no round trip decides what the
# user sees:
#
#   pill   232x64   ring + clock + subject, with — (minimise) » (panel) × (close)
#   mini    56x56   just the ring and the remaining minutes, with + and ×
#   closed          the process exits, and the choice is written down so the host
#                   does not immediately bring it back
#
# Every transition is persisted to `hud-mode.json` beside the state file, so the
# next launch restores the state and position.
#
# Design notes
#   * Everything is painted by hand with GDI+ (rounded card, hairline ring, soft
#     halo) because stock WinForms controls cannot be styled to match the app.
#   * Animation runs on a 40 ms timer with exponential value smoothing, so the
#     ring and the digits move continuously instead of snapping once a second.
#   * Every interaction appends one line to `-logPath`, which is how a human or a
#     test can tell that clicks are actually being delivered.
#
# Contract
#   -statePath <file>   JSON snapshot rewritten by the host twice per second.
#   -port <n>           DSH web port, the fallback for the dashboard URL.
#   -dashboardUrl <url> Opened by » , the context menu, and double-click.
#   -logPath <file>     Optional interaction log.
#   -mode <pill|mini>   Initial state, unless hud-mode.json already says otherwise.
#   -keepClosed         Print the persisted state as JSON and exit without showing
#                       anything. The host asks this before spawning, so a widget
#                       the user closed stays closed.
#   -shutdown           Stop a widget that is already on screen — whoever started
#                       it — and record that the user wanted it closed. This is
#                       the only way the panel can close an orphan: a widget left
#                       over from a previous host generation is nobody's child,
#                       and killing it from outside would leave no record, so the
#                       next boot would faithfully bring it back.
#   -selfTest           Exercise hit-testing and click routing once, then exit.
#   -capturePath <png>  Paint, screenshot the window to this file, then exit.
#   -probe <list>       Move the real cursor onto each named control, click it,
#                       and exit. This is the only check that proves the window
#                       actually receives input — a hit-test call cannot.
#   -drag <dx>,<dy>     Park the widget, press the left button for real, move by
#                       that many pixels, release, and write what happened to
#                       `-reportPath`. The only check that proves the window
#                       actually moves, and the only way to read the answer from
#                       a test (a confined run cannot open the pipe that reading
#                       stdout needs). `-hold <ms>` keeps the widget up afterwards
#                       so the shutdown path can be driven against it.
#   -wiring             Print which mouse events are attached to each window and
#                       exit. WinForms leaves them in a private handler table, so
#                       this is the direct answer to "is it wired up at all?".

param(
  [Parameter(Mandatory = $true)][string]$statePath,
  [Parameter(Mandatory = $true)][int]$port,
  [string]$dashboardUrl = "",
  [string]$logPath = "",
  [string]$mode = "",
  [string]$capturePath = "",
  [string]$probe = "",
  [string]$drag = "",
  [string]$aimAt = "",
  [string]$hold = "",
  [string]$reportPath = "",
  [string]$drive = "ring,min,minigrow,expand,miniclose",
  [switch]$keepClosed,
  [switch]$shutdown,
  [switch]$wiring,
  [switch]$selfDrive,
  [switch]$selfTest
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Declare DPI awareness before any window exists.
#
# Without it Windows bitmap-stretches the window on a scaled display, so the
# hand-drawn ring and the ClearType digits come out blurry, and the window's
# reported size stops matching the 232x64 it was designed at.
try {
  if (-not ('OrbitTimeDpi' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrbitTimeDpi {
  [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] private static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern int GetDpiForSystem();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  public static void Apply() {
    try { SetProcessDpiAwareness(2 /* PROCESS_PER_MONITOR_DPI_AWARE */); }
    catch { try { SetProcessDPIAware(); } catch { } }
  }
}
'@
  }
  [OrbitTimeDpi]::Apply()
} catch { }

# PrintWindow asks the window to render itself into a DC, which works for a
# topmost layered window where a screen-grab can come back empty.
try {
  if (-not ('OrbitTimeCapture' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class OrbitTimeCapture {
  [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  public static Bitmap Grab(IntPtr hwnd, int width, int height) {
    Bitmap bmp = new Bitmap(width, height);
    using (Graphics g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      try { PrintWindow(hwnd, hdc, 2 /* PW_RENDERFULLCONTENT */); }
      finally { g.ReleaseHdc(hdc); }
    }
    return bmp;
  }
}
'@ -ReferencedAssemblies 'System.Drawing', 'System.Windows.Forms'
  }
} catch { }

# Synthesised mouse input, used only by `-probe`.
#
# `-selfTest` can call Get-PillHit and read the right answer while the window is
# wired to nothing at all — that is exactly the bug this widget shipped with. A
# real click is the only evidence that the handlers are attached, so the probe
# injects one through the same OS input queue a person's mouse uses.
try {
  if (-not ('OrbitTimeInput' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OrbitTimeInput {
  [StructLayout(LayoutKind.Sequential)]
  private struct INPUT {
    public int type;
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")]
  private static extern int GetSystemMetrics(int index);

  private const uint MOVE = 0x0001;
  private const uint LEFTDOWN = 0x0002;
  private const uint LEFTUP = 0x0004;
  private const uint ABSOLUTE = 0x8000;
  private const uint VIRTUALDESK = 0x4000;
  private static INPUT Mouse(uint flags, int x, int y) {
    INPUT input = new INPUT();
    input.type = 0; // INPUT_MOUSE
    input.dx = x;
    input.dy = y;
    input.dwFlags = flags;
    return input;
  }

  /** Absolute coordinates covering the whole virtual desktop. */
  public static uint Move(int x, int y) {
    int vx = GetSystemMetrics(76 /* SM_XVIRTUALSCREEN */);
    int vy = GetSystemMetrics(77);
    int vw = GetSystemMetrics(78);
    int vh = GetSystemMetrics(79);
    if (vw <= 0) vw = 1;
    if (vh <= 0) vh = 1;
    int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
    int ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
    INPUT[] batch = new INPUT[] { Mouse(MOVE | ABSOLUTE | VIRTUALDESK, nx, ny) };
    return SendInput(1, batch, Marshal.SizeOf(typeof(INPUT)));
  }

  public static uint Click() {
    INPUT[] batch = new INPUT[] {
      Mouse(LEFTDOWN | ABSOLUTE | VIRTUALDESK, 0, 0),
      Mouse(LEFTUP | ABSOLUTE | VIRTUALDESK, 0, 0)
    };
    return SendInput(2, batch, Marshal.SizeOf(typeof(INPUT)));
  }

  /**
   * Press, move, release — a real drag through the OS input queue.
   *
   * `-drag` uses this. A drag cannot be faked by posting WM_MOUSEMOVE messages
   * either, because the state machine that moves the window reads the button's
   * physical state rather than the messages, and a posted message does not
   * change it.
   */
  public static uint Press() {
    INPUT[] batch = new INPUT[] { Mouse(LEFTDOWN | ABSOLUTE | VIRTUALDESK, 0, 0) };
    return SendInput(1, batch, Marshal.SizeOf(typeof(INPUT)));
  }

  public static uint Release() {
    INPUT[] batch = new INPUT[] { Mouse(LEFTUP | ABSOLUTE | VIRTUALDESK, 0, 0) };
    return SendInput(1, batch, Marshal.SizeOf(typeof(INPUT)));
  }

  [DllImport("user32.dll")]
  private static extern bool GetCursorPos(out POINT point);

  [StructLayout(LayoutKind.Sequential)]
  private struct POINT { public int X; public int Y; }

  /** Where the cursor is now, so a probe can put it back. */
  public static int[] Cursor() {
    POINT point;
    GetCursorPos(out point);
    return new int[] { point.X, point.Y };
  }

  // The polling input path reads the physical button state instead of waiting for
  // a message. GetKeyState is useless here — a process that is not the foreground
  // queue owner gets a stale answer — so this is GetAsyncKeyState.
  [DllImport("user32.dll")]
  private static extern short GetAsyncKeyState(int vKey);

  public static int LeftButtonDown() {
    return (GetAsyncKeyState(0x01 /* VK_LBUTTON */) & 0x8000) != 0 ? 1 : 0;
  }

  // Window messages, used by `-selfDrive`. Posting does not go through the
  // desktop input queue, so it still works where SendInput is refused.
  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool PostMessageW(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);

  public static bool PostMouseMove(IntPtr hwnd, int x, int y) {
    return PostMessageW(hwnd, 0x0200 /* WM_MOUSEMOVE */, IntPtr.Zero, (IntPtr)((y << 16) | (x & 0xFFFF)));
  }

  public static bool PostLeftDown(IntPtr hwnd, int x, int y) {
    return PostMessageW(hwnd, 0x0201 /* WM_LBUTTONDOWN */, (IntPtr)1, (IntPtr)((y << 16) | (x & 0xFFFF)));
  }
}
'@
  }
} catch { }

try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch { }

# Window management for `»`, which brings the panel the user already has open to
# the front instead of opening a second copy in a browser.
try {
  if (-not ('OrbitTimeWindows' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OrbitTimeWindows {
  private delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr pid);
  // The same entry point with the shape this file's newer code needs. One class
  // cannot declare it twice under one name and one signature, and a compile error
  // inside Add-Type is silent here — it takes the *whole* class away, not just the
  // member that failed, which is how a missing overload turned into "Unable to
  // find type [OrbitTimeWindows]" three hundred lines later.
  [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] private static extern uint GetWindowThreadProcessIdOut(IntPtr hwnd, out uint pid);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hwnd, StringBuilder text, int max);

  // The window's own rectangle in physical screen pixels.
  //
  // The pointer path used to derive the widget-local coordinate with
  // Control.PointToClient and ask ClientRectangle whether it was inside. That
  // transform owns a coordinate space of its own on a per-monitor-DPI-aware
  // process, and when it is wrong it is wrong silently: the cursor can sit on
  // the middle of the ring while the widget computes a point thousands of pixels
  // away, reports `hit=` nothing, and drops every click and every drag. The
  // window rectangle and the cursor are both physical screen pixels, so this
  // comparison has no transform to get wrong.
  [StructLayout(LayoutKind.Sequential)]
  private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

  public static int[] Bounds(IntPtr hwnd) {
    RECT rect;
    if (!GetWindowRect(hwnd, out rect)) return null;
    return new int[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
  }

  // The whole virtual desktop, so a widget parked on a second monitor is still
  // on screen. SM_XVIRTUALSCREEN .. SM_CYVIRTUALSCREEN.
  [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
  public static int[] VirtualScreen() {
    return new int[] {
      GetSystemMetrics(76), GetSystemMetrics(77),
      GetSystemMetrics(78), GetSystemMetrics(79)
    };
  }

  private const uint GW_OWNER = 4;

  /**
   * The app's main window: a visible Electron window whose title ends with the
   * product name.
   *
   * Matching a title *prefix* does not work — the window is titled after the
   * session ("<session> — DeepSeek Harness"), so the product name is at the end.
   * The window class is Electron's, which is what identifies it reliably.
   */
  public static IntPtr Find(string prefix) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hwnd, IntPtr param) {
      if (!IsWindowVisible(hwnd)) return true;
      StringBuilder title = new StringBuilder(512);
      GetWindowTextW(hwnd, title, title.Capacity);
      string text = title.ToString();
      if (text.Length == 0 || !text.Contains(prefix)) return true;
      StringBuilder cls = new StringBuilder(512);
      GetClassNameW(hwnd, cls, cls.Capacity);
      if (cls.ToString().IndexOf("Chrome_WidgetWin", StringComparison.Ordinal) < 0) return true;
      found = hwnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public static IntPtr Foreground() { return GetForegroundWindow(); }
  public static bool Raise(IntPtr hwnd) { return SetForegroundWindow(hwnd); }
  public static bool BringToFront(IntPtr hwnd) { return BringWindowToTop(hwnd); }
  public static bool Restore(IntPtr hwnd) { return ShowWindow(hwnd, 9 /* SW_RESTORE */); }
  public static uint CurrentThread() { return GetCurrentThreadId(); }
  public static uint OwnerThread(IntPtr hwnd) { return GetWindowThreadProcessId(hwnd, IntPtr.Zero); }
  public static bool Attach(uint from, uint to) { return AttachThreadInput(from, to, true); }

  /**
   * Does this process own a visible window with exactly this title?
   *
   * The shutdown path uses it instead of reading a command line, because
   * `Get-CimInstance Win32_Process` is refused on a locked-down machine
   * ("access denied") and a close button that cannot work there is not a close
   * button. Window ownership is at least as strong a proof of identity as a
   * command line, it needs no permission beyond what the widget already uses,
   * and it cannot be satisfied by an unrelated process that merely happens to
   * have been handed the same pid.
   */
  public static bool OwnsTitledWindow(int pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hwnd, IntPtr param) {
      if (!IsWindowVisible(hwnd)) return true;
      StringBuilder text = new StringBuilder(512);
      GetWindowTextW(hwnd, text, text.Capacity);
      if (text.ToString() != title) return true;
      uint owner = 0;
      GetWindowThreadProcessIdOut(hwnd, out owner);
      if ((int)owner != pid) return true;
      found = hwnd;
      return false;
    }, IntPtr.Zero);
    return found != IntPtr.Zero;
  }

  /**
   * Put the window at the top of the z-order without activating it.
   *
   * HWND_TOP (0) with SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW.
   * Activating would need the foreground lock, which Windows will not grant to a
   * background process on request; not activating still makes the window visible
   * over the others, which is the point of the button.
   */
  public static bool Lift(IntPtr hwnd) {
    const uint NOMOVE = 0x0002;
    const uint NOSIZE = 0x0001;
    const uint NOACTIVATE = 0x0010;
    const uint SHOWWINDOW = 0x0040;
    return SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, NOMOVE | NOSIZE | NOACTIVATE | SHOWWINDOW);
  }
}
'@
  }
} catch {
  # Add-Type failing is not a small thing: the class simply does not exist, every
  # call into it throws, and each of those throws is caught somewhere that only
  # makes the symptom quieter. A missing overload in this very file once turned
  # into "Unable to find type [OrbitTimeWindows]" in the shutdown path, three
  # hundred lines away and long after the compile error was swallowed here. So the
  # failure is recorded and reported once the logger exists.
  $script:typeFailures = @($script:typeFailures) + @("OrbitTimeWindows: $($_.Exception.Message)")
}
if ($script:typeFailures -eq $null) { $script:typeFailures = @() }

# --------------------------------------------------------------------- logging

$script:logEnabled = -not [string]::IsNullOrWhiteSpace($logPath)

function Write-Log([string]$message) {
  if (-not $script:logEnabled) { return }
  try {
    $line = (Get-Date).ToString('HH:mm:ss.fff') + ' ' + $message + "`r`n"
    [System.IO.File]::AppendAllText($logPath, $line, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

# Anything Add-Type could not compile, said out loud. A missing type is otherwise
# only visible as the silence of a feature that used to work.
if ($script:typeFailures -ne $null -and $script:typeFailures.Count -gt 0) {
  foreach ($failure in $script:typeFailures) { Write-Log "Add-Type failed: $failure" }
}

<#
Keep a throwing event handler from putting a modal dialog on screen.

Windows Forms shows an "Unhandled exception has occurred in your application"
box for any exception that escapes a handler, and it keeps showing it: the widget
then sits behind that dialog on every mouse move and cannot be clicked at all.
The dialog is also useless here, because it truncates the message.

An exception in one handler is a bug to fix, but it must not take the widget
hostage while it is being fixed. This records the whole thing — message, type and
stack — and leaves the window running.
#>
try {
  [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
  [System.Windows.Forms.Application]::add_ThreadException({
    param($sender, $eventArgs)
    $failure = $eventArgs.Exception
    Write-Log ("UI exception: " + $failure.GetType().FullName + ": " + $failure.Message)
    try {
      Write-Log ("UI exception stack: " + $failure.StackTrace)
      if ($failure.InnerException -ne $null) {
        Write-Log ("UI exception inner: " + $failure.InnerException.GetType().FullName + ": " + $failure.InnerException.Message)
      }
    } catch { }
  })
} catch {
  Write-Log ("could not install the UI exception handler: " + $_.Exception.Message)
}

# ------------------------------------------------------------------- geometry
#
# These are the values for a 100% display. A DPI-aware process draws in physical
# pixels, so on a scaled monitor an unscaled 232x64 pill comes out physically
# half the intended size — the whole widget has to be multiplied by the monitor's
# scale factor. Scale-Ui() redoes all of it once the handle exists and the real
# DPI is known. They are `script:` scoped so the paint handlers, which resolve at
# call time, see the scaled values.

$script:uiScale = 1.0
$script:pillWidth = 232
$script:pillHeight = 64
$script:pillCorner = 20
$script:miniSize = 56
$script:miniCorner = 18

$script:ringSize = 44
$script:ringStroke = 4.5
$script:ringX = 10
$script:ringY = [int](($script:pillHeight - $script:ringSize) / 2)

# Hit regions in the pill's own coordinates. The play/pause target is the ring
# itself: a 44 px circle is a far easier target than a small glyph.
$script:hitPlay = New-Object System.Drawing.Rectangle $script:ringX, $script:ringY, $script:ringSize, $script:ringSize
$script:hitMin = New-Object System.Drawing.Rectangle ($script:pillWidth - 84), 19, 26, 26
$script:hitExpand = New-Object System.Drawing.Rectangle ($script:pillWidth - 56), 19, 26, 26
$script:hitClose = New-Object System.Drawing.Rectangle ($script:pillWidth - 28), 19, 26, 26

# The minimal state has only two targets, so each can be generous.
$script:miniRingSize = 40
$script:hitMiniRing = New-Object System.Drawing.Rectangle 0, 0, 0, 0
$script:hitMiniClose = New-Object System.Drawing.Rectangle 0, 0, 0, 0
$script:hitMiniGrow = New-Object System.Drawing.Rectangle 0, 0, 0, 0

function Get-UiScale {
  try {
    $dpi = [int][OrbitTimeDpi]::GetDpiForSystem()
    if ($dpi -le 0) { return 1.0 }
    return $dpi / 96.0
  } catch {
    return 1.0
  }
}

<#
Keep the remembered position inside the desktop it is being restored onto.

`hud-mode.json` is a position, and a position is only meaningful for the display
layout that produced it. The old restore test compared it against the *primary*
screen's working area — so a widget parked on a second monitor failed the test
and stayed at the default corner, and a widget whose monitor is now gone
succeeded against nothing and was restored off screen, where it paints over
nothing the user can reach and answers no clicks, because `inside` is computed
against where the window is. Either way "拖动也拖不动, 按钮也没反应" is the report.

The virtual desktop is the honest boundary: every monitor, in physical pixels,
which is the same space GetWindowRect and Cursor.Position use.
#>
function Clamp-ToScreen {
  try {
    $bounds = [OrbitTimeWindows]::VirtualScreen()
    if ($bounds -eq $null) { return }
    $minX = $bounds[0]
    $minY = $bounds[1]
    $maxX = $bounds[0] + $bounds[2]
    $maxY = $bounds[1] + $bounds[3]
    foreach ($pair in @(@('pill', $pill, $script:pillWidth, $script:pillHeight), @('mini', $mini, $script:miniSize, $script:miniSize))) {
      $name = $pair[0]
      $form = $pair[1]
      $w = [int]$pair[2]
      $h = [int]$pair[3]
      $x = [Math]::Min([Math]::Max($form.Location.X, $minX), $maxX - $w)
      $y = [Math]::Min([Math]::Max($form.Location.Y, $minY), $maxY - $h)
      if ($x -ne $form.Location.X -or $y -ne $form.Location.Y) {
        Write-Log "clamped $name from $($form.Location.X),$($form.Location.Y) to $x,$y (desktop $minX,$minY .. $maxX,$maxY)"
        $form.Location = New-Object System.Drawing.Point $x, $y
      }
    }
  } catch {
    Write-Log "clamp failed: $($_.Exception.Message)"
  }
}

# Whether any part of the window is outside the desktop.
function Test-OffScreen($form) {
  try {
    $bounds = [OrbitTimeWindows]::VirtualScreen()
    if ($bounds -eq $null) { return $false }
    if ($form.Location.X -lt $bounds[0]) { return $true }
    if ($form.Location.Y -lt $bounds[1]) { return $true }
    if (($form.Location.X + $form.Size.Width) -gt ($bounds[0] + $bounds[2])) { return $true }
    if (($form.Location.Y + $form.Size.Height) -gt ($bounds[1] + $bounds[3])) { return $true }
    return $false
  } catch {
    return $false
  }
}

<#
Multiply the whole design by the monitor's scale factor.

Called once, after the handle exists — GetDpiForSystem is meaningless before the
process has a window. Fonts scale with everything else, so the proportions are
identical at 100%, 125%, 150% and 200%.
#>
function Scale-Ui([double]$factor) {
  $script:uiScale = $factor
  # Scale from the 100% design values, never from the already-scaled ones, so
  # calling this twice cannot compound the factor.
  $s = { param([double]$value) [int][Math]::Round($value * $factor) }

  $script:pillWidth = & $s 232
  $script:pillHeight = & $s 64
  $script:pillCorner = & $s 20
  # 64, not 56. The minimal state has to hold three targets and a drag strip, and
  # at 56 they were 36 physical pixels each at this display's 200% — "按钮也还是
  # 一样的鸡肋". 64 buys every one of them a third more area for 16 px of screen.
  $script:miniSize = & $s 64
  $script:miniCorner = & $s 18

  $script:ringSize = & $s 44
  $script:ringStroke = 4.5 * $factor
  $script:ringX = & $s 10
  $script:ringY = [int](($script:pillHeight - $script:ringSize) / 2)

  # The ring is the play/pause target: a 44 px circle is a far easier target than
  # the small glyph inside it.
  $script:hitPlay = New-Object System.Drawing.Rectangle $script:ringX, $script:ringY, $script:ringSize, $script:ringSize

  # The three window controls, tiled across the right-hand strip.
  #
  # They are drawn 26 px wide with 8 px between them, which at 200% is 13 px of
  # screen per button — and a 16 px gutter that does nothing at all. That gutter
  # is the bug behind "this one button does not respond": the glyph is small, the
  # strip you can aim at is smaller, and the space between two controls silently
  # swallows the click.
  #
  # So each region is stretched to meet its neighbour and the strip is
  # continuous. Overlap is resolved by order in Get-PillHit, so widening one can
  # never make another unreachable.
  $button = & $s 26
  $gap = & $s 8
  $edge = & $s 6
  $arm = [Math]::Max(3, (& $s 4))
  $stripTop = & $s 16
  $stripHeight = $script:pillHeight - 2 * $stripTop

  $closeRight = $script:pillWidth - $edge
  $closeLeft = $closeRight - $button
  $expandLeft = $closeLeft - $button - $gap
  $minLeft = $expandLeft - $button - $gap

  # The close region keeps a little margin on the right; the others start where
  # their neighbour ends.
  $script:hitClose = New-Object System.Drawing.Rectangle ($closeLeft - $arm), $stripTop, (($closeRight + $arm) - ($closeLeft - $arm)), $stripHeight
  $script:hitExpand = New-Object System.Drawing.Rectangle $expandLeft, $stripTop, ($script:hitClose.X - $expandLeft), $stripHeight
  $script:hitMin = New-Object System.Drawing.Rectangle $minLeft, $stripTop, ($script:hitExpand.X - $minLeft), $stripHeight

  # The minimal state has three targets, and the split between them is the whole
  # of "变小之后什么按钮都按不了":
  #
  #   * the play ring, centred, as large as the square allows;
  #   * `+` and `×` in the top corners, 18 px each — big enough to hit, small
  #     enough to stay clear of the ring's arc (at 26 px they were drawn across
  #     the arc and the number, which is what made this state look scribbled on);
  #   * a strip along the bottom, the only place a drag starts, marked with a grip.
  #
  # Every other part of the window is *not* a drag surface. That is the fix for
  # the complaint itself: the press that begins on a control stays that control's
  # press, so a button can no longer be turned into a drag by four pixels of
  # hand-shake — and the cursor stays a hand while it is over one.
  $script:miniRingSize = & $s 40
  $script:miniRingX = [int](($script:miniSize - $script:miniRingSize) / 2)
  $script:hitMiniRing = New-Object System.Drawing.Rectangle $script:miniRingX, $script:miniRingX, $script:miniRingSize, $script:miniRingSize
  $corner = & $s 22
  $script:hitMiniClose = New-Object System.Drawing.Rectangle ($script:miniSize - $corner), 0, $corner, $corner
  $script:hitMiniGrow = New-Object System.Drawing.Rectangle 0, 0, $corner, $corner
  $strip = & $s 16
  $stripHeight = & $s 14
  $script:hitMiniDrag = New-Object System.Drawing.Rectangle $strip, ($script:miniSize - $stripHeight), ($script:miniSize - 2 * $strip), $stripHeight

  # Fonts are sized in PIXELS, not points.
  #
  # A point size is converted with the display DPI, and since this process is DPI
  # aware .NET already multiplies by 192/96 — so scaling a point size by the same
  # factor applies it twice and the text comes out four times the intended height
  # at 200%. Pixels are taken literally, so the scale is applied exactly once.
  $pixels = { param([double]$points) [float]($points * (96.0 / 72.0) * $factor) }
  $script:fontTime = New-Object System.Drawing.Font 'Segoe UI Variable Display', (& $pixels 17), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $script:fontSubject = New-Object System.Drawing.Font 'Microsoft YaHei UI', (& $pixels 9), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $script:fontMeta = New-Object System.Drawing.Font 'Microsoft YaHei UI', (& $pixels 8), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $script:fontMini = New-Object System.Drawing.Font 'Segoe UI Variable Display', (& $pixels 13), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $script:fontGlyph = New-Object System.Drawing.Font 'Segoe UI', (& $pixels 10), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $script:fontGlyphSmall = New-Object System.Drawing.Font 'Segoe UI', (& $pixels 9), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)

  # Text column offsets, from the same 100% design: the clock's top edge, the gap
  # between the ring and the text, and the subject line's top edge.
  $script:textGap = & $s 12
  $script:clockY = & $s 7
  $script:subjectY = & $s 36
}

# --------------------------------------------------------------- mode storage

$script:modePath = Join-Path (Split-Path -Parent $statePath) 'hud-mode.json'
$script:requestDir = Split-Path -Parent $statePath
$script:alivePath = Join-Path $script:requestDir 'hud-alive.json'
$script:pidPath = Join-Path $script:requestDir 'hud.pid'

function Read-ModePreference {
  try {
    if (-not (Test-Path -LiteralPath $script:modePath)) { return $null }
    $raw = [System.IO.File]::ReadAllText($script:modePath, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Save-ModePreference([string]$stateName, [int]$x, [int]$y) {
  # Capture and self-test runs must not touch the preference: they are probes,
  # and writing from them would fight the real widget for the same file.
  if (-not $script:writeMode) { return }
  try {
    $payload = @{ state = $stateName; x = $x; y = $y; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($script:modePath, $payload, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Write-Log "could not persist the mode: $($_.Exception.Message)"
  }
}

<#
Put the active window back to the size its state was designed for.

Showing a form is allowed to change its size. On this machine a borderless
112x112 window comes back **262x112** the moment it is shown — whatever the title,
`MinimumSize`, `MaximumSize` or `SetWindowPos` say, and with `WM_GETMINMAXINFO`
reporting a minimum track size of 0x0. The width is not clamped in the form's own
coordinate space at all: it is the *window* that gets wider, and its client area
follows.

That single number is the whole of "点 — 之后是这样的": the minimal state is square
by design, its ring, its digits and its two corner controls are all laid out from
that square — and in a box 2.3x too wide the ring sits centred in a space nobody
drew for, the digits look lost, and the corner controls end up somewhere the user
did not aim at. The pill never suffered from it because the pill is wider than the
clamp to begin with.

`ClientSize` is honoured once the window exists, so the size is simply set again
after `Show()`. Every transition does this, because every transition shows a
window: pill ⇄ mini both go through `Show-Pill` / `Show-Mini`.
#>
function Refresh-WindowSize {
  try {
    $window = Get-ActiveWindow
    $form = $window.form
    if ($form -eq $null) { return }
    $w = $script:pillWidth
    $h = $script:pillHeight
    if ($window.name -eq 'mini') { $w = $script:miniSize; $h = $script:miniSize }
    if ($form.ClientSize.Width -eq $w -and $form.ClientSize.Height -eq $h) { return }
    Write-Log "resizing $($window.name) from $($form.ClientSize.Width)x$($form.ClientSize.Height) to $($w)x$($h)"
    $form.ClientSize = New-Object System.Drawing.Size($w, $h)
    # A window that grew to the right may now hang off the screen edge; the
    # position is re-clamped rather than left where the wider box pushed it.
    if (Test-OffScreen $form) { Clamp-ToScreen }
    $form.Invalidate()
  } catch {
    Write-HandlerError 'refresh-size' $_
  }
}

# --------------------------------------------------------------- shutdown mode

<#
Announce that this widget is alive, right now.

The host has to answer "is the widget on screen?" for the panel, and the honest
answer cannot come from the process it spawned: a widget survives a DSH restart,
so the new host has no child of its own while a window sits there on screen. The
pid file alone is not enough either — a pid outlives its process and gets reused.

This file is written on every frame (about twice a second) and deleted on the way
out, so a *fresh* mtime can only come from a widget that is running at this
moment. The host reads it with one `stat`, which matters because the panel polls
the same question.
#>
function Write-AliveFile {
  try {
    $payload = @{ pid = $PID; mode = $script:active; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($script:alivePath, $payload, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    # Losing the heartbeat is not fatal to the widget; the host simply stops
    # offering to close it.
  }
}

function Remove-AliveFile {
  try {
    if (Test-Path -LiteralPath $script:alivePath) { Remove-Item -LiteralPath $script:alivePath -Force }
  } catch { }
}

<#
Clean up after this run, but only if this run still owns the files.

`-keepClosed` writes a pid and an alive stamp on its way past, so a probe must not
delete a *running* widget's records — the widget would then look dead to the host
and the panel's close button would silently stop working. Same for the pid file:
whoever wrote the last one owns it.
#>
function Remove-OwnAliveFile {
  try {
    if (-not (Test-Path -LiteralPath $script:pidPath)) { return }
    $owner = [System.IO.File]::ReadAllText($script:pidPath, [System.Text.Encoding]::UTF8).Trim()
    if ($owner -ne [string]$PID) { return }
    Remove-Item -LiteralPath $script:pidPath -Force -ErrorAction SilentlyContinue
    Remove-AliveFile
  } catch { }
}

<#
Stop a widget that is already running. See `-shutdown` in the header.

The panel used to have no way to do this: it could only kill a process it had
spawned itself, so a widget left over from a previous DSH run — which is exactly
the one a user is looking at when they say "关闭都管不了" — ignored every command.
This runs as a second, short-lived hud.ps1 beside the live one, which is safe
because nothing else is running yet: the script never creates a window on this
path, so it cannot fight the live widget for the screen or the mode file.

Killing by pid alone would be reckless, because a pid on disk outlives the
process it named and the OS hands the number out again. So the command line is
read first and the process is only stopped when it is plainly this script.
#>
function Stop-RunningWidget {
  $pidPath = $script:pidPath
  if (-not (Test-Path -LiteralPath $pidPath)) {
    Write-Log 'shutdown: no pid file, so no widget was recorded'
    return $false
  }
  $raw = ''
  try {
    $raw = [System.IO.File]::ReadAllText($pidPath, [System.Text.Encoding]::UTF8).Trim()
  } catch {
    Write-Log "shutdown: could not read the pid file: $($_.Exception.Message)"
    return $false
  }
  $target = 0
  if (-not [int]::TryParse($raw, [ref]$target) -or $target -le 0) {
    Write-Log "shutdown: pid file does not hold a pid ($raw)"
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    return $false
  }
  $process = $null
  try {
    $process = Get-Process -Id $target -ErrorAction Stop
  } catch {
    Write-Log "shutdown: pid $target is not running"
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    return $false
  }
  # What the pid names *now*, not what it named when the file was written. A pid
  # on disk outlives its process and the OS hands the number out again, so
  # identity has to be proven before anything is stopped. Two proofs, cheapest
  # first: the process owns a window titled "Orbit Time" (unambiguous, and needs
  # no permission), or its command line names hud.ps1 *and* this very state path.
  $ownsWindow = $false
  try {
    $ownsWindow = [OrbitTimeWindows]::OwnsTitledWindow($target, 'Orbit Time')
  } catch {
    Write-Log "shutdown: the window check failed: $($_.Exception.Message)"
  }
  $namesOurScript = $false
  if (-not $ownsWindow) {
    $commandLine = ''
    try {
      $info = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $target) -ErrorAction Stop
      if ($info -ne $null) { $commandLine = [string]$info.CommandLine }
    } catch {
      # Access denied is the normal answer on a locked-down machine, and it is not
      # a reason to leave the widget on screen — the window check above is the
      # one that works there.
      Write-Log "shutdown: could not read the command line of pid $target ($($_.Exception.Message))"
    }
    $namesOurScript = ($commandLine -like '*hud.ps1*') -and ($commandLine -like ('*' + $statePath + '*'))
  }
  if (-not $ownsWindow -and -not $namesOurScript) {
    Write-Log "shutdown: pid $target is not this widget (name=$($process.ProcessName)); leaving it alone"
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    return $false
  }
  Write-Log "shutdown: pid $target is the widget (window=$ownsWindow commandLine=$namesOurScript)"
  try {
    Stop-Process -Id $target -Force -ErrorAction Stop
    Write-Log "shutdown: stopped the widget pid $target"
  } catch {
    Write-Log "shutdown: could not stop pid $target : $($_.Exception.Message)"
    return $false
  }
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  return $true
}

if ($shutdown) {
  # The preference is written first and unconditionally: the point of this mode is
  # that whoever asked for the widget to go away does not have it come back.
  # The position it had is preserved, because closing should not also move it.
  $previous = Read-ModePreference
  $lastX = 0
  $lastY = 0
  if ($previous -ne $null) {
    if ($previous.x -ne $null) { $lastX = [int]$previous.x }
    if ($previous.y -ne $null) { $lastY = [int]$previous.y }
  }
  Write-Log "shutdown: requested; remembered position $lastX,$lastY"
  [void](Stop-RunningWidget)
  try {
    $payload = @{ state = 'closed'; x = $lastX; y = $lastY; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($script:modePath, $payload, (New-Object System.Text.UTF8Encoding($false)))
    Write-Log "shutdown: recorded closed at $lastX,$lastY"
  } catch {
    Write-Log "shutdown: could not record the preference: $($_.Exception.Message)"
  }
  if ($keepClosed) {
    [Console]::Out.WriteLine((@{ state = 'closed'; x = $lastX; y = $lastY } | ConvertTo-Json -Compress))
  }
  exit 0
}

# --------------------------------------------------------------------- state

$script:state = $null
$script:stale = $false
$script:shownSeconds = 0.0
$script:colonPhase = 0
$script:flashUntil = [DateTime]::MinValue
$script:previousPhase = ''
$script:previousRemaining = -1
$script:frame = 0
$script:hover = ''
$script:pressTarget = ''
$script:pressed = ''
$script:dragging = $false
$script:moved = $false
$script:closing = $false
$script:active = 'pill'
$script:startMode = 'pill'
# Set while a press is being served by the mouse messages, so the polling input
# path stands down. `pressAt` bounds it: if the matching release never arrives,
# polling takes over again rather than staying disabled for the rest of the run.
$script:messagePress = $false
$script:pressAt = [DateTime]::MinValue
$script:pollDown = $false
$script:pollTarget = ''
$script:pollPoint = New-Object System.Drawing.Point 0, 0
# Watchdog for the message path. A handler that stops returning takes the whole
# window with it — the queue backs up and every later message piles in behind.
# The frame loop counts mouse messages and, if they stop arriving while the
# cursor is plainly moving over the widget, stops trusting that path.
$script:mouseMessages = 0
$script:mouseMessagesAt = [DateTime]::Now
$script:mouseSeen = 0
$script:messagePathDead = $false
# The drag that the pointer handlers have decided on, applied by the frame loop.
# A message handler is not the place to touch the window: `$form` is the enclosing
# function's parameter and resolves to $null inside the delegate, and `$sender`
# arrives $null as well, while `$script:` state is always reachable.
$script:pillOrigin = New-Object System.Drawing.Point 0, 0
$script:dragTo = $null
# The drag state machine itself, which runs in the frame loop rather than inside
# the MouseMove handler: see Update-Drag.
$script:dragActive = $false
$script:dragTarget = ''
$script:dragMoved = $false
$script:dragCursor = $null
# Where the press began, as a hit name. A press on a control must never become a
# drag, and this is what the whole drag decision is made from — see Update-Drag.
$script:dragFrom = ''
# A probe run leaves no trace: it never writes the preference file, and an
# explicit `-mode` wins over whatever the real widget last chose.
$script:ephemeral = (-not [string]::IsNullOrWhiteSpace($capturePath)) -or $selfTest
# `-probe` and `-drag` are ephemeral like the other diagnostics, but they must
# still write the mode file: proving that the widget persists where it was left
# is half the point of running them.
$script:writeMode = (-not $script:ephemeral) -or (-not [string]::IsNullOrWhiteSpace($probe)) -or (-not [string]::IsNullOrWhiteSpace($drag))

function Read-State {
  $parsed = $null
  for ($attempt = 0; $attempt -lt 4; $attempt++) {
    try {
      $raw = [System.IO.File]::ReadAllText($statePath, [System.Text.Encoding]::UTF8)
      if (-not [string]::IsNullOrWhiteSpace($raw)) {
        $parsed = $raw | ConvertFrom-Json
        break
      }
    } catch {
      # The host may be mid-write; retry shortly.
    }
    Start-Sleep -Milliseconds 15
  }
  if ($parsed -ne $null) {
    $script:state = $parsed
    $script:stale = $false
  } else {
    $script:stale = $true
  }
}

function Send-Action([string]$action, [int]$minutes = 0) {
  $id = [Guid]::NewGuid().ToString('N')
  $requestPath = Join-Path $script:requestDir ('hud-request-' + $id + '.json')
  $payload = @{ id = $id; action = $action; minutes = $minutes } | ConvertTo-Json -Compress
  try {
    [System.IO.File]::WriteAllText($requestPath, $payload, (New-Object System.Text.UTF8Encoding($false)))
    Write-Log "action $action -> $id"
  } catch {
    Write-Log "action $action FAILED: $($_.Exception.Message)"
  }
}

# Bring a window owned by the harness itself to the front.
#
# `»` is labelled "there is more over there", and the thing over there is the
# panel in the app the user already has open — not a second copy of it in a
# browser. Opening the URL is the fallback for when the app window cannot be
# found, not the first move.
#
# Windows refuses a foreground change requested by a process that does not own
# the foreground (the foreground lock), so this does not try to take focus. It
# restores the window and lifts it above the others without activating it, which
# is what makes it visible without stealing the caret from whatever the user is
# typing into.
function Focus-AppWindow {
  try {
    $found = [OrbitTimeWindows]::Find('DeepSeek Harness')
    if ($found -eq [IntPtr]::Zero) {
      Write-Log 'focus-dashboard: no DeepSeek Harness window is open'
      return $false
    }
    [OrbitTimeWindows]::Restore($found)
    $raised = [OrbitTimeWindows]::Lift($found)
    $now = [OrbitTimeWindows]::Foreground()
    Write-Log ("focus-dashboard: lifted=" + $raised + " hwnd=" + $found + " foreground=" + $now)
    # Lifting is the successful outcome. Focus may legitimately stay elsewhere.
    return $raised
  } catch {
    Write-Log ("focus-dashboard FAILED: " + $_.Exception.Message)
    return $false
  }
}

function Open-Dashboard {
  if (Focus-AppWindow) { return }
  $target = $dashboardUrl
  if ([string]::IsNullOrWhiteSpace($target)) {
    if ($port -le 0) {
      Write-Log 'open-dashboard skipped: no url and no port'
      return
    }
    $target = 'http://127.0.0.1:' + $port + '/'
  }
  try {
    Start-Process $target | Out-Null
    Write-Log "open-dashboard $target"
  } catch {
    Write-Log "open-dashboard FAILED: $($_.Exception.Message)"
  }
}

function Get-PhaseLabel([string]$phase) {
  switch ($phase) {
    'focus' { return '专注' }
    'short' { return '短休' }
    'long' { return '长休' }
    default { return '待机' }
  }
}

function New-RoundPath([int]$w, [int]$h, [int]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $r, $r, 180, 90)
  $p.AddArc(($w - $r), 0, $r, $r, 270, 90)
  $p.AddArc(($w - $r), ($h - $r), $r, $r, 0, 90)
  $p.AddArc(0, ($h - $r), $r, $r, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw-RoundRect($g, $brush, $rect, [int]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($rect.X, $rect.Y, $r, $r, 180, 90)
  $p.AddArc(($rect.Right - $r), $rect.Y, $r, $r, 270, 90)
  $p.AddArc(($rect.Right - $r), ($rect.Bottom - $r), $r, $r, 0, 90)
  $p.AddArc($rect.X, ($rect.Bottom - $r), $r, $r, 90, 90)
  $p.CloseFigure()
  $g.FillPath($brush, $p)
  $p.Dispose()
}

# -------------------------------------------------------------------- palette
#
# Created empty and filled in by Scale-Ui(), because a font size in points is
# meaningless until the display scale is known.

$script:fontTime = New-Object System.Drawing.Font 'Segoe UI', 17, ([System.Drawing.FontStyle]::Bold)
$script:fontSubject = New-Object System.Drawing.Font 'Microsoft YaHei UI', 9
$script:fontMeta = New-Object System.Drawing.Font 'Microsoft YaHei UI', 8
$script:fontMini = New-Object System.Drawing.Font 'Segoe UI', 13, ([System.Drawing.FontStyle]::Bold)
$script:fontGlyph = New-Object System.Drawing.Font 'Segoe UI', 10, ([System.Drawing.FontStyle]::Bold)
$script:fontGlyphSmall = New-Object System.Drawing.Font 'Segoe UI', 9, ([System.Drawing.FontStyle]::Bold)

$colBg1 = [System.Drawing.Color]::FromArgb(31, 34, 43)
$colBg2 = [System.Drawing.Color]::FromArgb(20, 22, 29)
$colStroke = [System.Drawing.Color]::FromArgb(60, 66, 82)
$colTrack = [System.Drawing.Color]::FromArgb(50, 55, 68)
$colAccent = [System.Drawing.Color]::FromArgb(96, 158, 255)
$colBreak = [System.Drawing.Color]::FromArgb(61, 214, 178)
$colText = [System.Drawing.Color]::FromArgb(243, 245, 249)
$colDim = [System.Drawing.Color]::FromArgb(148, 157, 173)
$colWarn = [System.Drawing.Color]::FromArgb(255, 118, 110)
$colClose = [System.Drawing.Color]::FromArgb(255, 138, 130)

# --------------------------------------------------------------------- forms

$formType = [System.Windows.Forms.Form]
try {
  if (-not ('OrbitTimeHudForm' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Windows.Forms;
public sealed class OrbitTimeHudForm : Form {
  public OrbitTimeHudForm() {
    this.DoubleBuffered = true;
    this.SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);
  }
}
'@ -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing'
  }
  $formType = [OrbitTimeHudForm]
} catch {
  $formType = [System.Windows.Forms.Form]
}

$workArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

function New-HudForm([int]$w, [int]$h, [int]$corner, [string]$text) {
  $f = New-Object $formType
  $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $f.ShowInTaskbar = $false
  $f.TopMost = $true
  $f.BackColor = [System.Drawing.Color]::FromArgb(22, 24, 31)
  $f.ForeColor = [System.Drawing.Color]::White
  $f.Text = $text
  $f.ClientSize = New-Object System.Drawing.Size($w, $h)
  $f.Region = New-Object System.Drawing.Region (New-RoundPath $w $h $corner)
  return $f
}

$pill = New-HudForm $script:pillWidth $script:pillHeight $script:pillCorner 'Orbit Time'
$script:pillPath = New-RoundPath $script:pillWidth $script:pillHeight $script:pillCorner

$mini = New-HudForm $script:miniSize $script:miniSize $script:miniCorner 'Orbit Time · mini'
$script:miniPath = New-RoundPath $script:miniSize $script:miniSize $script:miniCorner

<#
Apply the display scale and the resulting window size.

The path and the region have to be rebuilt because both are in window
coordinates, and the position is re-derived so the widget still sits near the
bottom-right rather than drifting off screen.
#>
function Apply-Scale([double]$factor) {
  Scale-Ui $factor
  $pill.ClientSize = New-Object System.Drawing.Size($script:pillWidth, $script:pillHeight)
  $pill.Region = New-Object System.Drawing.Region (New-RoundPath $script:pillWidth $script:pillHeight $script:pillCorner)
  $script:pillPath = New-RoundPath $script:pillWidth $script:pillHeight $script:pillCorner
  $mini.ClientSize = New-Object System.Drawing.Size($script:miniSize, $script:miniSize)
  $mini.Region = New-Object System.Drawing.Region (New-RoundPath $script:miniSize $script:miniSize $script:miniCorner)
  $script:miniPath = New-RoundPath $script:miniSize $script:miniSize $script:miniCorner
  $margin = [int][Math]::Round(20 * $factor)
  $taskbar = [int][Math]::Round(48 * $factor)
  $script:homePosition = New-Object System.Drawing.Point (($workArea.Right - $script:pillWidth - $margin), ($workArea.Bottom - $script:pillHeight - $taskbar))
  # The scale determines the window size, and the window size determines whether
  # a remembered position is still on screen — so this is the one moment where
  # both are known together.
  Clamp-ToScreen
}

Apply-Scale (Get-UiScale)
$pill.Location = $script:homePosition
$mini.Location = $script:homePosition

# ------------------------------------------------------------------- painting

function Get-StateValues {
  $phase = 'idle'
  $running = $false
  $remaining = 0
  $total = 1500
  $subject = ''
  $nextTitle = ''
  $completed = 0
  if ($script:state -ne $null) {
    if ($script:state.phase -ne $null) { $phase = [string]$script:state.phase }
    if ($script:state.running -ne $null) { $running = [bool]$script:state.running }
    if ($script:state.remainingSeconds -ne $null) { $remaining = [int]$script:state.remainingSeconds }
    if ($script:state.totalSeconds -ne $null) { $total = [int]$script:state.totalSeconds }
    if ($script:state.subject -ne $null) { $subject = [string]$script:state.subject }
    if ($script:state.nextTitle -ne $null) { $nextTitle = [string]$script:state.nextTitle }
    if ($script:state.completedToday -ne $null) { $completed = [int]$script:state.completedToday }
  }
  return @{
    phase = $phase; running = $running; remaining = $remaining; total = $total
    subject = $subject; nextTitle = $nextTitle; completed = $completed
  }
}

function Update-Smoothing([int]$remaining, [int]$total) {
  # Exponential smoothing toward the true value keeps the sweep continuous
  # between the host's publishes and the local frames.
  if ($script:shownSeconds -le 0 -or [Math]::Abs($script:shownSeconds - $remaining) -gt 90) {
    $script:shownSeconds = [double]$remaining
  } else {
    $script:shownSeconds = $script:shownSeconds + ([double]$remaining - $script:shownSeconds) * 0.18
  }
  if ($total -le 0) { return 0.0 }
  $progress = 1.0 - ($script:shownSeconds / [double]$total)
  if ($progress -lt 0) { return 0.0 }
  if ($progress -gt 1) { return 1.0 }
  return $progress
}

function Note-PhaseChange($values) {
  # A phase handoff or a fresh round is worth a brief highlight, so the eye
  # catches it without a sound.
  if ($script:previousPhase -ne '' -and $script:previousPhase -ne $values.phase) {
    $script:flashUntil = (Get-Date).AddMilliseconds(900)
    Write-Log "phase $($script:previousPhase) -> $($values.phase)"
  }
  if ($values.phase -eq 'focus' -and $script:previousRemaining -ge 0 -and $values.remaining -gt ($script:previousRemaining + 30)) {
    $script:flashUntil = (Get-Date).AddMilliseconds(900)
  }
  $script:previousPhase = $values.phase
  $script:previousRemaining = $values.remaining
}

function Draw-Card($g, $path, [int]$w, [int]$h) {
  $bounds = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush $bounds, $colBg1, $colBg2, 90.0
  $g.FillPath($gradient, $path)
  $gradient.Dispose()
  $pen = New-Object System.Drawing.Pen $colStroke, 1
  $g.DrawPath($pen, $path)
  $pen.Dispose()
}

<#
The progress ring with a soft halo under the arc.

`cx`/`cy` is the centre and `size` the outer diameter, so one drawing serves the
pill (44 px) and the minimal state (40 px).
#>
function Draw-Ring($g, [double]$cx, [double]$cy, [double]$size, [double]$progress, $accent, [string]$glyph) {
  $half = $script:ringStroke / 2
  $rect = New-Object System.Drawing.RectangleF ([float]($cx - $size / 2 + $half)), ([float]($cy - $size / 2 + $half)), ([float]($size - $script:ringStroke)), ([float]($size - $script:ringStroke))

  $trackPen = New-Object System.Drawing.Pen $colTrack, $script:ringStroke
  $trackPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $trackPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawEllipse($trackPen, $rect)
  $trackPen.Dispose()

  if ($progress -gt 0.004) {
    for ($layer = 3; $layer -ge 1; $layer--) {
      $halo = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(13 * $layer, $accent.R, $accent.G, $accent.B)), ($script:ringStroke + $layer * 3.0)
      $halo.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
      $halo.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
      $g.DrawArc($halo, $rect, -90, [float](360 * $progress))
      $halo.Dispose()
    }
    $arcPen = New-Object System.Drawing.Pen $accent, $script:ringStroke
    $arcPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $arcPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawArc($arcPen, $rect, -90, [float](360 * $progress))
    $arcPen.Dispose()
  }

  if ($glyph -eq 'pause') {
    $brush = New-Object System.Drawing.SolidBrush $colText
    $g.FillRectangle($brush, [float]($cx - 4.6), [float]($cy - 6.0), 3.2, 12)
    $g.FillRectangle($brush, [float]($cx + 1.4), [float]($cy - 6.0), 3.2, 12)
    $brush.Dispose()
  } elseif ($glyph -eq 'play') {
    $points = @(
      (New-Object System.Drawing.PointF ([float]($cx - 3.4)), ([float]($cy - 6.4))),
      (New-Object System.Drawing.PointF ([float]($cx + 6.2)), ([float]$cy)),
      (New-Object System.Drawing.PointF ([float]($cx - 3.4)), ([float]($cy + 6.4)))
    )
    $brush = New-Object System.Drawing.SolidBrush $colText
    $g.FillPolygon($brush, $points)
    $brush.Dispose()
  }
}

<#
A small square control drawn as vector strokes.

The glyphs are drawn rather than typed because the typeface's `—` and `×` carry
their own side bearings and optical weight, which read as "text" rather than
"window control" at this size.
#>
function Draw-Control($g, $rect, [string]$kind, [bool]$hover, [bool]$pressed) {
  $box = New-Object System.Drawing.Rectangle ($rect.X + 2), ($rect.Y + 2), ($rect.Width - 4), ($rect.Height - 4)
  if ($hover -or $pressed) {
    # Holding a button has to look different from merely hovering it, or a click
    # that is registered still feels like nothing happened.
    $alpha = 42
    if ($pressed) { $alpha = 78 }
    $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($alpha, 255, 255, 255))
    Draw-RoundRect $g $fill $box 7
    $fill.Dispose()
  }
  $colour = $colDim
  if ($kind -eq 'close') { $colour = $colClose }
  if ($hover) { $colour = $colText }
  if ($pressed) { $colour = $colText }
  $pen = New-Object System.Drawing.Pen $colour, (1.6 * $script:uiScale)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $cx = $box.X + $box.Width / 2.0
  $cy = $box.Y + $box.Height / 2.0
  $arm = $box.Width * 0.23
  switch ($kind) {
    'min' {
      $g.DrawLine($pen, [float]($cx - $arm), [float]$cy, [float]($cx + $arm), [float]$cy)
    }
    'expand' {
      # Two chevrons: "there is more over there", pointing away from the widget.
      $step = $arm * 0.62
      $g.DrawLines($pen, @(
          (New-Object System.Drawing.PointF ([float]($cx - $arm * 0.7), ([float]($cy - $arm)))),
          (New-Object System.Drawing.PointF ([float]($cx + $step * 0.2), ([float]$cy))),
          (New-Object System.Drawing.PointF ([float]($cx - $arm * 0.7), ([float]($cy + $arm))))
        ))
      $g.DrawLines($pen, @(
          (New-Object System.Drawing.PointF ([float]($cx - $arm * 0.0), ([float]($cy - $arm)))),
          (New-Object System.Drawing.PointF ([float]($cx + $arm * 0.9), ([float]$cy))),
          (New-Object System.Drawing.PointF ([float]($cx - $arm * 0.0), ([float]($cy + $arm))))
        ))
    }
    'grow' {
      # A plus: back to the full capsule.
      $g.DrawLine($pen, [float]($cx - $arm), [float]$cy, [float]($cx + $arm), [float]$cy)
      $g.DrawLine($pen, [float]$cx, [float]($cy - $arm), [float]$cx, [float]($cy + $arm))
    }
    'close' {
      $g.DrawLine($pen, [float]($cx - $arm), [float]($cy - $arm), [float]($cx + $arm), [float]($cy + $arm))
      $g.DrawLine($pen, [float]($cx + $arm), [float]($cy - $arm), [float]($cx - $arm), [float]($cy + $arm))
    }
  }
  $pen.Dispose()
}

<#
Draw a clock string with every glyph on one advance width.

A proportional face gives '1' a narrower box than '8', so once a second the
digits shuffle sideways and the widget looks like it is vibrating. Laying the
glyphs out by hand keeps them still. The colon keeps its own narrower cell, and
stays in the string while running — it only fades, so the layout never shifts and
the time never reads as two separate numbers.
#>
function Draw-Clock($g, [string]$clock, [float]$x, [float]$y, [int]$colonAlpha) {
  $digitAdvance = 0.0
  $colonAdvance = 0.0
  foreach ($ch in $clock.ToCharArray()) {
    $size = $g.MeasureString([string]$ch, $script:fontTime)
    if ($ch -eq ':') {
      if ($size.Width -gt $colonAdvance) { $colonAdvance = $size.Width }
    } elseif ($size.Width -gt $digitAdvance) {
      $digitAdvance = $size.Width
    }
  }
  if ($colonAdvance -le 0) { $colonAdvance = $digitAdvance * 0.45 }
  $textBrush = New-Object System.Drawing.SolidBrush $colText
  $colonBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($colonAlpha, $colText.R, $colText.G, $colText.B))
  $cursor = $x
  foreach ($ch in $clock.ToCharArray()) {
    $cell = if ($ch -eq ':') { $colonAdvance } else { $digitAdvance }
    $size = $g.MeasureString([string]$ch, $script:fontTime)
    $brush = if ($ch -eq ':') { $colonBrush } else { $textBrush }
    $g.DrawString([string]$ch, $script:fontTime, $brush, [float]($cursor + ($cell - $size.Width) / 2), $y)
    $cursor += $cell
  }
  $colonBrush.Dispose()
  $textBrush.Dispose()
  return ($cursor - $x)
}

# --------------------------------------------------------------- transitions

function Show-Pill {
  if ($script:active -eq 'pill' -and $pill.Visible) { return }
  $script:active = 'pill'
  $mini.Hide()
  $pill.Location = $mini.Location
  $pill.Show()
  # Showing is allowed to resize the window; put it back before anything is drawn.
  Refresh-WindowSize
  $pill.Activate()
  $pill.Invalidate()
  Save-ModePreference 'pill' $pill.Location.X $pill.Location.Y
  Write-Log 'mode -> pill'
}

function Show-Mini {
  if ($script:active -eq 'mini' -and $mini.Visible) { return }
  $script:active = 'mini'
  $pill.Hide()
  $mini.Location = $pill.Location
  $mini.Show()
  Refresh-WindowSize
  $mini.Activate()
  $mini.Invalidate()
  Save-ModePreference 'mini' $mini.Location.X $mini.Location.Y
  Write-Log 'mode -> mini'
}

function Close-Hud([string]$reason) {
  # The preference is written BEFORE closing: otherwise the host sees a dead
  # process with no record of why and simply starts it again.
  Save-ModePreference 'closed' $pill.Location.X $pill.Location.Y
  Remove-AliveFile
  Write-Log "closed by the user ($reason)"
  $script:closing = $true
  $timer.Stop()
  $pill.Hide()
  $mini.Hide()
  [System.Windows.Forms.Application]::Exit()
}

# --------------------------------------------------------------------- paint

$pill.add_Paint({
  param($sender, $eventArgs)
  $g = $eventArgs.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  Draw-Card $g $script:pillPath $script:pillWidth $script:pillHeight

  $values = Get-StateValues
  Note-PhaseChange $values
  $progress = Update-Smoothing $values.remaining $values.total
  $isBreak = ($values.phase -eq 'short' -or $values.phase -eq 'long')
  $accent = $colAccent
  if ($isBreak) { $accent = $colBreak }

  $cx = $script:ringX + $script:ringSize / 2.0
  $cy = $script:ringY + $script:ringSize / 2.0
  $glyph = if ($values.running) { 'pause' } else { 'play' }
  Draw-Ring $g $cx $cy $script:ringSize $progress $accent $glyph

  if ($script:hover -eq 'play' -or $script:pressed -eq 'play') {
    $alpha = 22
    if ($script:pressed -eq 'play') { $alpha = 54 }
    $hoverBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($alpha, 255, 255, 255))
    $g.FillEllipse($hoverBrush, $script:hitPlay)
    $hoverBrush.Dispose()
  }

  # --- text column --------------------------------------------------------
  # Layout offsets are scaled too: the fonts grew with the display, so fixed
  # pixel positions would pile the clock, the subject and the phase on top of
  # one another.
  $textX = $script:ringX + $script:ringSize + $script:textGap
  $minutes = [Math]::Floor($script:shownSeconds / 60)
  $seconds = [Math]::Floor($script:shownSeconds % 60)
  $clock = ('{0:00}:{1:00}' -f $minutes, $seconds)
  $colonAlpha = 255
  if ($values.running -and $script:colonPhase -eq 1) { $colonAlpha = 95 }
  Draw-Clock $g $clock $textX $script:clockY $colonAlpha | Out-Null

  $line = $values.subject
  if ([string]::IsNullOrWhiteSpace($line)) {
    if (-not [string]::IsNullOrWhiteSpace($values.nextTitle)) {
      $line = '接下来 ' + $values.nextTitle
    } else {
      $line = '点圆环开始专注'
    }
  }
  # Truncate to the space the window controls leave behind. A fixed character
  # count does not work: the subject is Chinese and proportional, so twelve
  # characters can run under the minimise button and hide it.
  $columnRight = $script:hitMin.X - $script:textGap
  $available = $columnRight - $textX
  if ($available -gt 10) {
    while ($line.Length -gt 1 -and $g.MeasureString($line, $script:fontSubject).Width -gt $available) {
      $line = $line.Substring(0, $line.Length - 1)
    }
    if ($line.Length -lt $values.subject.Length -and $line.Length -gt 1) {
      $line = $line.Substring(0, $line.Length - 1) + '…'
    }
  } elseif ($line.Length -gt 8) {
    $line = $line.Substring(0, 8) + '…'
  }
  $dimBrush = New-Object System.Drawing.SolidBrush $colDim
  $lineSize = $g.MeasureString($line, $script:fontSubject)
  $g.DrawString($line, $script:fontSubject, $dimBrush, [float]$textX, [float]$script:subjectY)
  $dimBrush.Dispose()

  $accentBrush = New-Object System.Drawing.SolidBrush $accent
  $phaseText = (Get-PhaseLabel $values.phase) + ' · ' + [string]$values.completed
  $phaseX = $textX + $lineSize.Width + $script:textGap * 0.6
  $phaseSize = $g.MeasureString($phaseText, $script:fontMeta)
  # Only draw the phase when it genuinely fits before the button column.
  if (($phaseX + $phaseSize.Width) -lt $columnRight) {
    $g.DrawString($phaseText, $script:fontMeta, $accentBrush, [float]$phaseX, [float]($script:subjectY + 1))
  }
  $accentBrush.Dispose()

  # --- window controls: minimise, open panel, close ------------------------
  Draw-Control $g $script:hitMin 'min' ($script:hover -eq 'min') ($script:pressed -eq 'min')
  Draw-Control $g $script:hitExpand 'expand' ($script:hover -eq 'expand') ($script:pressed -eq 'expand')
  Draw-Control $g $script:hitClose 'close' ($script:hover -eq 'close') ($script:pressed -eq 'close')

  if ((Get-Date) -lt $script:flashUntil) {
    $flash = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(28, $accent.R, $accent.G, $accent.B))
    $g.FillPath($flash, $script:pillPath)
    $flash.Dispose()
  }
  if ($script:stale) {
    $staleBrush = New-Object System.Drawing.SolidBrush $colWarn
    $g.DrawString('宿主未响应', $script:fontMeta, $staleBrush, [float]$textX, [float]$script:subjectY)
    $staleBrush.Dispose()
  }
})

$mini.add_Paint({
  param($sender, $eventArgs)
  $g = $eventArgs.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  Draw-Card $g $script:miniPath $script:miniSize $script:miniSize

  $values = Get-StateValues
  Note-PhaseChange $values
  $progress = Update-Smoothing $values.remaining $values.total
  $isBreak = ($values.phase -eq 'short' -or $values.phase -eq 'long')
  $accent = $colAccent
  if ($isBreak) { $accent = $colBreak }

  # The ring is the play/pause target and the remaining minutes sit inside it —
  # that is the whole point of the minimal state: one glanceable number.
  $centre = $script:miniSize / 2.0
  Draw-Ring $g $centre $centre $script:miniRingSize $progress $accent 'none'

  $minutes = [Math]::Ceiling($script:shownSeconds / 60)
  if ($minutes -lt 0) { $minutes = 0 }
  $label = [string]$minutes
  $brush = New-Object System.Drawing.SolidBrush $colText
  $size = $g.MeasureString($label, $script:fontMini)
  $g.DrawString($label, $script:fontMini, $brush, [float]($centre - $size.Width / 2), [float]($centre - $size.Height / 2 + 1))
  $brush.Dispose()

  # The play ring, the two controls and the drag strip. The controls are drawn
  # whenever the pointer is anywhere on the widget — including over the drag
  # strip — because they are small and the user has to be able to see what is
  # there before aiming at it.
  $showControls = $script:hover -ne ''
  if ($showControls) {
    Draw-Control $g $script:hitMiniGrow 'grow' ($script:hover -eq 'minigrow') ($script:pressed -eq 'minigrow')
    Draw-Control $g $script:hitMiniClose 'close' ($script:hover -eq 'miniclose') ($script:pressed -eq 'miniclose')
  }

  # Drawn, not typed: three dots in the strip that is the only place a drag
  # starts, so the one thing that moves the window is also the one thing that
  # looks like it will.
  $gripBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, $colDim.R, $colDim.G, $colDim.B))
  $gripY = [float]($script:hitMiniDrag.Y + $script:hitMiniDrag.Height / 2)
  foreach ($offset in @(-5.0, 0.0, 5.0)) {
    $g.FillEllipse($gripBrush, [float](($script:miniSize / 2) + $offset - 1.2), ($gripY - 1.2), 2.4, 2.4)
  }
  $gripBrush.Dispose()

  if ((Get-Date) -lt $script:flashUntil) {
    $flash = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(30, $accent.R, $accent.G, $accent.B))
    $g.FillPath($flash, $script:miniPath)
    $flash.Dispose()
  }
  if ($script:stale) {
    $staleBrush = New-Object System.Drawing.SolidBrush $colWarn
    $g.FillEllipse($staleBrush, [float]($script:miniSize - 14), [float]($script:miniSize - 14), 6, 6)
    $staleBrush.Dispose()
  }
})

# --------------------------------------------------------------- interaction

<#
Which control a point is over, by name.

The handlers call this directly rather than holding a delegate. A script block
stored in a variable and invoked from inside a Windows Forms event handler runs
as a PowerShell pipeline on a thread .NET owns, and the failure it produces
("The property 'Location' cannot be found on this object") points at the event
argument rather than at the invocation. A plain function call has no such gap.
#>
function Resolve-Hit([string]$which, $point) {
  if ($point -eq $null) { return 'drag' }
  if ($which -eq 'mini') { return (Get-MiniHit $point) }
  return (Get-PillHit $point)
}

# What arrived, for the log, when it is not the type the handler expects.
function Get-ValueTypeName($value) {
  if ($value -eq $null) { return '(null)' }
  return $value.GetType().FullName
}

<#
Turn a caught exception into something that names the failing line.

"Handler threw: You cannot call a method on a null-valued expression" is true and
useless: it does not say which call. The invocation info carries the statement,
and the stack carries the call sites, so both go into the log.
#>
function Write-HandlerError([string]$where, $errorRecord) {
  $exception = $errorRecord.Exception
  $position = ''
  if ($errorRecord.InvocationInfo -ne $null -and $errorRecord.InvocationInfo.PositionMessage -ne $null) {
    $position = ($errorRecord.InvocationInfo.PositionMessage -split "`n")[0]
  }
  Write-Log ("{0} handler threw: {1} | at {2}" -f $where, $exception.Message, $position.Trim())
  if ($errorRecord.ScriptStackTrace -ne $null) {
    Write-Log ("{0} handler stack: {1}" -f $where, ($errorRecord.ScriptStackTrace -replace "`r?`n", ' <- '))
  }
}

function Get-PillHit([System.Drawing.Point]$point) {
  if ($script:hitClose.Contains($point)) { return 'close' }
  if ($script:hitMin.Contains($point)) { return 'min' }
  if ($script:hitExpand.Contains($point)) { return 'expand' }
  if ($script:hitPlay.Contains($point)) { return 'play' }
  return 'drag'
}

function Get-MiniHit([System.Drawing.Point]$point) {
  # The controls come first, so a click near an edge never plays or pauses by
  # accident. Note what is *not* here: no catch-all. A point that is not on a
  # control and not on the drag strip belongs to no one, and the cursor says so.
  if ($script:hitMiniClose.Contains($point)) { return 'miniclose' }
  if ($script:hitMiniGrow.Contains($point)) { return 'minigrow' }
  if ($script:hitMiniRing.Contains($point)) { return 'play' }
  if ($script:hitMiniDrag.Contains($point)) { return 'drag' }
  return ''
}

<#
Which control a named aim point resolves to in the current state, and the point.

`-drag` uses this to press a *named control* rather than a coordinate: the claim
"a press on × must not drag the widget" is only testable if the press can be aimed
at × on purpose.
#>
function Get-MiniPoint([string]$name) {
  if ($name -eq 'play') { return (New-Object System.Drawing.Point ([int]($script:miniSize / 2)), ([int]($script:miniSize / 2))) }
  if ($name -eq 'minigrow') { return (New-Object System.Drawing.Point ([int]($script:hitMiniGrow.X + $script:hitMiniGrow.Width / 2)), ([int]($script:hitMiniGrow.Y + $script:hitMiniGrow.Height / 2))) }
  if ($name -eq 'miniclose') { return (New-Object System.Drawing.Point ([int]($script:hitMiniClose.X + $script:hitMiniClose.Width / 2)), ([int]($script:hitMiniClose.Y + $script:hitMiniClose.Height / 2))) }
  return (New-Object System.Drawing.Point ([int]($script:miniSize / 2)), ([int]($script:hitMiniDrag.Y + $script:hitMiniDrag.Height / 2)))
}

# Where to aim at a named control, in the window's own coordinates. Shared by the
# two diagnostics that drive the widget, so both aim at the same place.
function Get-TargetCenter([string]$name) {  switch ($name) {
    'ring' { return (New-Object System.Drawing.Point ([int]($script:ringX + $script:ringSize / 2)), ([int]($script:ringY + $script:ringSize / 2))) }
    'min' { return (New-Object System.Drawing.Point ([int]($script:hitMin.X + $script:hitMin.Width / 2)), ([int]($script:hitMin.Y + $script:hitMin.Height / 2))) }
    'expand' { return (New-Object System.Drawing.Point ([int]($script:hitExpand.X + $script:hitExpand.Width / 2)), ([int]($script:hitExpand.Y + $script:hitExpand.Height / 2))) }
    'close' { return (New-Object System.Drawing.Point ([int]($script:hitClose.X + $script:hitClose.Width / 2)), ([int]($script:hitClose.Y + $script:hitClose.Height / 2))) }
    'miniclose' { return (New-Object System.Drawing.Point ([int]($script:hitMiniClose.X + $script:hitMiniClose.Width / 2)), ([int]($script:hitMiniClose.Y + $script:hitMiniClose.Height / 2))) }
    'minigrow' { return (New-Object System.Drawing.Point ([int]($script:hitMiniGrow.X + $script:hitMiniGrow.Width / 2)), ([int]($script:hitMiniGrow.Y + $script:hitMiniGrow.Height / 2))) }
    default { return (New-Object System.Drawing.Point ([int]($script:miniSize / 2)), ([int]($script:miniSize / 2))) }
  }
}

function Invoke-Target([string]$target) {
  switch ($target) {
    'play' { Send-Action 'toggle' }
    'expand' { Open-Dashboard }
    'min' { Show-Mini }
    'minigrow' { Show-Pill }
    'close' { Close-Hud 'pill ×' }
    'miniclose' { Close-Hud 'mini ×' }
  }
}

# ---------------------------------------------------------- polling input
#
# The pointer path above depends on Windows delivering WM_MOUSEMOVE / WM_LBUTTONDOWN
# to this window. That is the normal case and it is what supplies the hover
# highlight and drag. It is not the only possible source of truth, though, and
# when delivery stops the widget becomes a picture of a timer: painted, topmost,
# and deaf. The report that produced this file was exactly that.
#
# So the same controls are also driven from the cursor's real position and the
# button's real state, read once per animation frame. Clicking does not depend on
# a message arriving, and hover does not depend on a move message either.
#
# The two paths cannot both act on one press: whichever sees it first claims it.
# A message press sets `messagePress`, which parks polling until the release, and
# for at most a second if that release never comes.

function Get-PointerState {
  $point = [System.Windows.Forms.Cursor]::Position
  $target = Get-ActiveWindow
  $client = Get-WindowPoint $target.form $point
  $inside = $false
  $hit = ''
  if ($client -ne $null) {
    # Inside is decided against the window's real size, not against the design
    # size: a click in the last scaled pixel of a 200% display still belongs to
    # the widget.
    $size = $target.form.Size
    if ($client.X -ge 0 -and $client.Y -ge 0 -and $client.X -lt $size.Width -and $client.Y -lt $size.Height) {
      $inside = $true
      if ($target.name -eq 'mini') { $hit = Get-MiniHit $client } else { $hit = Get-PillHit $client }
    }
  }
  return @{
    point = $point
    client = $client
    inside = $inside
    hit = $hit
    down = (([OrbitTimeInput]::LeftButtonDown()) -ne 0)
  }
}

<#
Where a screen point falls inside a window, or $null when it is not over it.

GetWindowRect and Cursor.Position are both physical screen pixels, so the
subtraction needs no transform — which is the point. The widget's own
PointToClient is left out of the pointer path on purpose: with per-monitor DPI it
owns a coordinate space of its own, and a wrong answer there is invisible from
outside. See the note beside Bounds().
#>
function Get-WindowPoint($form, $screenPoint) {
  if ($form -eq $null -or $screenPoint -eq $null) { return $null }
  try {
    $bounds = [OrbitTimeWindows]::Bounds($form.Handle)
    if ($bounds -eq $null) { return $null }
    return (New-Object System.Drawing.Point (($screenPoint.X - $bounds[0]), ($screenPoint.Y - $bounds[1])))
  } catch {
    return $null
  }
}

<#
The drag, as its own state machine, driven from the animation frame.

It used to live entirely inside the MouseMove handler, which meant the one
delivery path that can fail — Windows handing this window its mouse messages —
was also the only way to move the widget. The movement watchdog exists precisely
because that delivery stops on this machine, and when it does, "拖动也拖不动"
follows: the window is painted, topmost, and nailed down.

The decision is therefore taken from the cursor and the button themselves, with
one rule that matters more than the rest:

  **A press that begins on a control belongs to that control, for as long as it
  lasts.** The press point — not the cursor's current position — decides whether
  this press may move the window, and only the drag strip (or the body of the
  pill) may. Without that, the strip is not the only drag surface in practice:
  a press on `×` that slid two physical pixels while the hand settled would be
  read as a drag, the release would stop being a click, and the button would do
  nothing — while the cursor showed the move shape, because the *current* hit
  said "drag" the whole time. That is exactly "点击的时候鼠标显示的却是我想移动
  的那个鼠标按键". Reading the press point instead is not a refinement; it is the
  difference between a widget whose buttons work and one whose buttons do not.

  Once the press is a drag, the window moves by the cursor's own delta each
  frame, and the button must stay over the window for the move to continue — a
  release elsewhere can never leave the widget glued to the pointer.

Only the decision is made here. The window is moved and the position persisted by
Update-PointerVisuals, which runs on the same timer and has the form in scope.
#>
function Update-Drag($pointer) {
  $form = (Get-ActiveWindow).form
  if ($form -eq $null) { return }

  if ($script:dragActive) {
    if (-not $pointer.down) {
      $script:dragActive = $false
      $script:dragTarget = ''
      $script:dragCursor = $null
      $script:dragFrom = $null
      if ($script:dragMoved) {
        $script:dragMoved = $false
        $script:moved = $false
        # The position is written here, at the end of the move, rather than from
        # Update-PointerVisuals: a release produces no movement, so there is no
        # `dragTo` left for that function to notice, and the spot the user chose
        # would be lost on the next launch.
        $window = Get-ActiveWindow
        if ($window.name -eq 'mini') { Save-ModePreference 'mini' $window.form.Location.X $window.form.Location.Y }
        else { Save-ModePreference 'pill' $window.form.Location.X $window.form.Location.Y }
        Write-Log "drag end at $($window.form.Location.X),$($window.form.Location.Y)"
      }
      return
    }
    if (-not ($script:dragFrom -eq 'drag')) {
      # Not a drag after all — the press belongs to a control, and it is on its
      # way to becoming a click. Nothing to do here but stay out of the way.
      return
    }
    if (-not $pointer.inside) {
      # Off the card with the button down: hold the move, keep the press.
      $script:dragCursor = $pointer.point
      return
    }
    $last = $script:dragCursor
    if ($last -eq $null) {
      $script:dragCursor = $pointer.point
      return
    }
    $dx = $pointer.point.X - $last.X
    $dy = $pointer.point.Y - $last.Y
    $slop = [int][Math]::Max(3, [Math]::Round(5 * $script:uiScale))
    if (-not $script:dragMoved -and ([Math]::Abs($dx) -gt $slop -or [Math]::Abs($dy) -gt $slop)) {
      $script:dragMoved = $true
      $script:moved = $true
      # A press that became a move is no longer a button press.
      $script:pressed = ''
      Write-Log "drag start at $($script:dragTarget) from $($form.Location.X),$($form.Location.Y)"
    }
    if ($script:dragMoved -and ($dx -ne 0 -or $dy -ne 0)) {
      $script:dragTo = New-Object System.Drawing.Point (($form.Location.X + $dx), ($form.Location.Y + $dy))
    }
    $script:dragCursor = $pointer.point
    return
  }

  if (-not $pointer.down -or -not $pointer.inside) { return }
  $script:dragActive = $true
  $script:dragTarget = $pointer.hit
  # The press point is what decides, and it is recorded once.
  $script:dragFrom = $pointer.hit
  $script:dragMoved = $false
  $script:dragCursor = $pointer.point
}

function Get-ActiveWindow {
  if ($script:active -eq 'mini') { return @{ name = 'mini'; form = $mini } }
  return @{ name = 'pill'; form = $pill }
}

<#
Apply what the pointer has asked for, and keep the cursor honest.

Everything the message handlers decide lands in `$script:` state; this is where it
becomes visible. It runs on the frame timer, which has the two form objects in
scope, so nothing here depends on a delegate being handed a usable sender.
#>
function Update-PointerVisuals {
  $window = Get-ActiveWindow
  $form = $window.form

  if ($script:dragTo -ne $null) {
    $form.Location = $script:dragTo
    $script:dragTo = $null
    # A move that would leave the card half off the desktop is not a move: a
    # widget parked past the screen edge paints where nobody can click it, and
    # from the outside that is indistinguishable from a frozen one.
    if (Test-OffScreen $form) { Clamp-ToScreen }
    # Written once, when the message-path drag finishes: persisting on every frame
    # would put a file write in the middle of a drag for no benefit. The frame
    # loop's own drag persists itself, in Update-Drag, where the release is seen.
    if (-not $script:dragging) {
      if ($window.name -eq 'mini') { Save-ModePreference 'mini' $form.Location.X $form.Location.Y }
      else { Save-ModePreference 'pill' $form.Location.X $form.Location.Y }
    }
  }

  # --- cursor ---------------------------------------------------------------
  # The shape has to mean something, and the complaint was that it did not:
  # "鼠标一移到那个小的悬浮窗里面我鼠标就变小了". A window that swaps the standard
  # arrow for a smaller glyph the moment the pointer crosses it makes a 56 px
  # widget feel like a trap, and it made the drag surface look like the whole
  # window — because for the whole window the *hit* used to be 'drag'.
  #
  # The rules now:
  #   * the four-way move shape only while a move is actually happening;
  #   * a hand only over a control that does something when clicked;
  #   * the standard arrow everywhere else, including the drag strip (whose dots
  #     are the affordance) and anywhere that is not a target at all.
  #
  # `Update-Pointer` clears the hover as soon as the pointer leaves the window, so
  # a shape set here cannot outlive the pointer's visit.
  $wanted = [System.Windows.Forms.Cursors]::Default
  if ($script:dragging -or $script:dragMoved) { $wanted = [System.Windows.Forms.Cursors]::SizeAll }
  elseif ($pointer.inside -and $script:hover -ne '' -and $script:hover -ne 'drag') { $wanted = [System.Windows.Forms.Cursors]::Hand }
  if ($form.Cursor -ne $wanted) { $form.Cursor = $wanted }

  if ($script:hover -ne '' -or $script:pressed -ne '' -or $script:dragging -or $script:dragActive) { $form.Invalidate() }
}

<#
Turn the pointer's state into hover, press and click.

`$pointer` is handed in when the caller already has it — the frame loop reads it
once per tick and needs the same reading for the drag — and is read from the
cursor otherwise, which is what the `-selfDrive` diagnostic relies on.
#>
function Update-Pointer([string]$simulate = 'real', [string]$at = 'ring', $pointer = $null) {
  if ($pointer -eq $null) { $pointer = Get-PointerState }
  $form = (Get-ActiveWindow).form
  if ($simulate -ne 'real') {
    # `-selfDrive` uses this to run the state machine on demand: a real click
    # cannot be produced inside a process that Windows refuses to inject input
    # into, but the logic that turns a press into an action can still be tested.
    $centre = Get-TargetCenter $at
    $window = Get-ActiveWindow
    $pointer.client = $centre
    $pointer.inside = $true
    if ($window.name -eq 'mini') { $pointer.hit = Get-MiniHit $centre } else { $pointer.hit = Get-PillHit $centre }
    $pointer.down = ($simulate -eq 'press')
  }

  # --- message-path watchdog ------------------------------------------------
  # Counted from the frame loop, which runs on this same thread. If the cursor is
  # over the widget and moving but no mouse message has been seen for four
  # seconds, that path is not coming back: stop relying on it and let polling do
  # the work. Cheap insurance against a wedge that would otherwise make every
  # control inert for the life of the process.
  #
  # It has to be able to come *back*, though: `-probe` and `-selfDrive` post
  # messages from inside the process, and a window that re-enables the path when
  # messages resume is strictly better than one that gives up on it for the rest
  # of the run.
  if ($script:mouseMessages -ne $script:mouseSeen) {
    $script:mouseSeen = $script:mouseMessages
    $script:mouseMessagesAt = [DateTime]::Now
    if ($script:messagePathDead) {
      $script:messagePathDead = $false
      Write-Log 'mouse messages are arriving again; the message path is back in service'
    }
  } elseif (-not $script:messagePathDead -and ((Get-Date) - $script:mouseMessagesAt).TotalSeconds -gt 4 -and $pointer.inside) {
    $script:messagePathDead = $true
    Write-Log 'mouse messages have stopped arriving over the widget; falling back to polling input for good'
  }

  $dirty = $false

  # --- hover, straight from the cursor position -----------------------------
  # Only the state is decided here. The cursor shape and the repaint are applied
  # by Update-PointerVisuals, which has the form objects in scope.
  $hover = $pointer.hit
  if ($hover -ne $script:hover) {
    $script:hover = $hover
    $dirty = $true
  }

  # --- press and release ----------------------------------------------------
  if ($script:messagePress) {
    # A message-driven press owns this click. Give its release up to a second to
    # arrive, then hand the pointer back to polling.
    if (((Get-Date) - $script:pressAt).TotalMilliseconds -gt 1000) { $script:messagePress = $false }
    return
  }

  # The frame loop's drag owns a press that turns into a move, so polling must
  # not turn the same press into a click halfway through it.
  if ($script:dragActive -and $script:dragMoved) {
    $script:pollDown = $false
    $script:pollTarget = ''
    return
  }

  if ($pointer.down -and -not $script:pollDown) {
    $script:pollDown = $true
    $script:pollTarget = $pointer.hit
    $script:pollPoint = $pointer.point
    $script:pressed = $pointer.hit
    Write-Log "poll down at $($pointer.client.X),$($pointer.client.Y) hit=$($pointer.hit)"
  } elseif (-not $pointer.down -and $script:pollDown) {
    $script:pollDown = $false
    $target = $script:pollTarget
    $script:pollTarget = ''
    $script:pressed = ''
    # A press only counts as a click if it came back up over the same control and
    # the pointer did not travel in between — the same rule the message path uses.
    $dx = [Math]::Abs($pointer.point.X - $script:pollPoint.X)
    $dy = [Math]::Abs($pointer.point.Y - $script:pollPoint.Y)
    $slop = [int][Math]::Max(3, [Math]::Round(5 * $script:uiScale))
    Write-Log "poll up at $($pointer.client.X),$($pointer.client.Y) hit=$($pointer.hit) target=$target travel=$dx,$dy"
    if ($pointer.hit -eq $target -and $dx -le $slop -and $dy -le $slop -and $target -ne 'drag' -and $target -ne '') {
      Invoke-Target $target
    }
  }
}

<#
Wire the pointer behaviour for one form.

Press and release must land on the same target with no movement in between, so a
drag can never fire a button — the failure mode that makes a widget feel broken.

The hit test is a real .NET delegate, not a script block.

`& $hitTest $point` from inside a Windows Forms event handler is a PowerShell
*pipeline* invocation running on a delegate that .NET called. When it goes wrong
the message is "The expression after '&' in a pipeline element produced an object
that was not valid", and because it is raised inside an event handler Windows
Forms turns it into a modal dialog — one that reappears on every mouse move and
covers the widget completely. A `Func[Point,string]` has nothing to resolve at
event time, so that whole class of failure is gone rather than merely handled.

Attaching is a separate step from defining: `Connect-Form $pill 'pill'` has to be
called for each window, and for a while it was not. The widget painted perfectly
and answered no clicks at all. Two checks exist so that cannot pass unnoticed
again: `-wiring` reads the handler table back off the live windows, and `-selfDrive`
runs the pointer state machine on demand.
#>
function Connect-Form($form, [string]$which) {
  $form.add_MouseDown({
    param($sender, $eventArgs)
    try {
      # Never trust the shape of what arrives. A handler that throws is answered
      # with a modal dialog, and that dialog makes the window unclickable — a
      # worse outcome than the original mistake.
      if ($eventArgs -eq $null -or -not ($eventArgs -is [System.Windows.Forms.MouseEventArgs])) {
        Write-Log ("mouseDown: unexpected event args of type " + (Get-ValueTypeName $eventArgs))
        return
      }
      if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
        # A press that opens the menu must never also become a drag or a tap.
        $script:dragging = $false
        $script:pressTarget = ''
        $script:pressed = ''
        Show-Menu
        return
      }
      if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        $script:dragging = $true
        $script:moved = $false
        $script:pressTarget = Resolve-Hit $which $eventArgs.Location
        # Holding a button should look held.
        $script:pressed = $script:pressTarget
        # This press belongs to the message path; keep polling out of it.
        $script:messagePress = $true
        $script:pressAt = Get-Date
        Write-Log "down at $($eventArgs.X),$($eventArgs.Y) hit=$($script:pressTarget)"
      }
    } catch {
      Write-HandlerError 'mouseDown' $_
    }
  })

  $form.add_MouseMove({
    param($sender, $eventArgs)
    try {
      $script:mouseMessages++
      # The move itself is *not* handled here any more. The frame loop owns the
      # drag (see Update-Drag) because this handler is the first thing the
      # watchdog takes away when Windows stops delivering messages — and with the
      # drag living here, losing messages meant losing the ability to move the
      # widget at all, which is how it behaved. What this handler still does is
      # count its own deliveries, so the watchdog can tell the path is alive, and
      # supply the hover highlight from the message's own coordinates.
      if ($script:messagePathDead -or $script:dragging) { return }
      if ($eventArgs -eq $null -or -not ($eventArgs -is [System.Windows.Forms.MouseEventArgs])) {
        Write-Log ("mouseMove: unexpected event args of type " + (Get-ValueTypeName $eventArgs))
        return
      }
      $hit = Resolve-Hit $which $eventArgs.Location
      $script:hover = $hit
    } catch {
      Write-HandlerError 'mouseMove' $_
    }
  })

  $form.add_MouseLeave({
    try {
      $script:hover = ''
      $script:pressed = ''
    } catch {
      Write-HandlerError 'mouseLeave' $_
    }
  })

  $form.add_MouseUp({
    param($sender, $eventArgs)
    try {
      if ($eventArgs -eq $null -or -not ($eventArgs -is [System.Windows.Forms.MouseEventArgs])) {
        Write-Log ("mouseUp: unexpected event args of type " + (Get-ValueTypeName $eventArgs))
        return
      }
      if ($eventArgs.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
      $wasDragging = $script:dragging
      $script:dragging = $false
      # The message path served this press, so polling stays parked until the
      # cooldown expires and then resumes watching.
      $script:pressAt = Get-Date
      $target = $script:pressTarget
      $script:pressTarget = ''
      $wasPressed = ($script:pressed -ne '')
      $script:pressed = ''
      if ($script:moved) {
        Write-Log 'drag end'
        return
      }
      if (-not $wasDragging) { return }
      $released = Resolve-Hit $which $eventArgs.Location
      Write-Log "up at $($eventArgs.X),$($eventArgs.Y) released=$released target=$target"
      if ($released -ne $target) { return }
      Invoke-Target $released
    } catch {
      Write-HandlerError 'mouseUp' $_
    }
  })

  $form.add_DoubleClick({
    try { Open-Dashboard } catch { Write-Log ("doubleClick handler threw: " + $_.Exception.Message) }
  })
}

# The wiring itself. Without these two lines every control above is inert: the
# hit-testing is correct, the actions are correct, and no mouse event ever
# reaches either one.
Connect-Form $pill 'pill'
Connect-Form $mini 'mini'

<#
Which mouse events the live window actually has handlers for.

`Control.Events` is an `EventHandlerList`, which exposes no way to enumerate its
keys — but `EventHandlerList.Find` takes one of `Control`'s internal static key
objects and returns the entry for it. So each event can be asked about directly,
and the answer is the handler table itself rather than an inference from it.

This is the check that would have caught the widget shipping with correct
hit-testing, correct actions, and no connection to the mouse at all.
#>
function Get-WiredEvents($control) {
  $static = [System.Reflection.BindingFlags]'Static,NonPublic'
  $instance = [System.Reflection.BindingFlags]'Instance,NonPublic'
  $events = [System.Windows.Forms.Control].GetProperty('Events', $instance).GetValue($control)
  if ($events -eq $null) { return '(no handler table)' }
  $find = [System.ComponentModel.EventHandlerList].GetMethod('Find', $instance)
  $wired = New-Object System.Collections.ArrayList
  $absent = New-Object System.Collections.ArrayList
  foreach ($name in @('MouseDown', 'MouseMove', 'MouseUp', 'MouseLeave', 'DoubleClick')) {
    $field = [System.Windows.Forms.Control].GetField('Event' + $name, $static)
    if ($field -eq $null) { [void]$absent.Add($name + '?'); continue }
    $entry = $find.Invoke($events, @($field.GetValue($null)))
    $handler = $null
    if ($entry -ne $null) { $handler = $entry.GetType().GetField('handler', $instance).GetValue($entry) }
    if ($handler -ne $null) { [void]$wired.Add($name) } else { [void]$absent.Add($name) }
  }
  return ('wired=' + (($wired | Sort-Object) -join ',') + ' missing=' + (($absent | Sort-Object) -join ','))
}

# --- context menu ---------------------------------------------------------

$script:menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:menu.ShowImageMargin = $false
foreach ($definition in @(
    @{ text = '开始 / 暂停'; action = 'toggle' },
    @{ text = '完成当前番茄'; action = 'skip' },
    @{ text = '重置计时器'; action = 'reset' },
    @{ text = '重新读取 Excel'; action = 'reimport' },
    @{ text = '最小化为小圆点'; action = 'min' },
    @{ text = '展开完整胶囊'; action = 'max' },
    @{ text = '打开主面板'; action = 'open' },
    @{ text = '隐藏悬浮窗'; action = 'hide' }
  )) {
  $entry = $script:menu.Items.Add($definition.text)
  $entry.Tag = $definition.action
  $entry.add_Click({
    param($sender, $eventArgs)
    $tag = [string]$sender.Tag
    Write-Log "menu $tag"
    switch ($tag) {
      'open' { Open-Dashboard }
      'min' { Show-Mini }
      'max' { Show-Pill }
      'hide' { Close-Hud 'menu hide' }
      default { Send-Action $tag }
    }
  })
}

function Show-Menu {
  Write-Log 'menu opened'
  $script:menu.Show([System.Windows.Forms.Cursor]::Position)
}

# --- animation loop -------------------------------------------------------

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 40
$timer.add_Tick({
  $script:frame++
  # Poll the host a few times a second; repaint only while something is moving —
  # a running countdown, a hover change, or an active flash. An idle widget costs
  # nothing.
  #
  # The heartbeat rides along with the poll rather than the frame: it is the
  # host's answer to "is this widget on screen?", and twice a second is already
  # far more often than that question is asked.
  if ($script:frame % 12 -eq 0) {
    Read-State
    $script:colonPhase = [int](($script:frame / 12) % 2)
    Write-AliveFile
  }
  # The pointer is read from the cursor and the button themselves, so the widget
  # stays clickable whether or not Windows is delivering mouse messages to it.
  # The drag is decided the same way and for the same reason: hover, press and
  # move all come from the cursor's real position and the button's real state.
  # Both steps are guarded: an exception here would otherwise reach Windows Forms
  # as an unhandled one and put a modal dialog over the widget.
  $pointer = $null
  try {
    $pointer = Get-PointerState
    Update-Pointer $pointer
  } catch { Write-HandlerError 'tick:pointer' $_ }
  try {
    if ($pointer -ne $null) { Update-Drag $pointer }
  } catch { Write-HandlerError 'tick:drag' $_ }
  try { Update-PointerVisuals } catch { Write-HandlerError 'tick:visuals' $_ }
  $values = Get-StateValues
  $moving = $script:hover -ne '' -or $script:dragActive -or ((Get-Date) -lt $script:flashUntil) -or $script:stale -or $values.running
  if ($moving) {
    if ($script:active -eq 'mini') { $mini.Invalidate() } else { $pill.Invalidate() }
  }
})
$timer.Start()

$pill.add_FormClosing({
  if (-not $script:closing) { Save-ModePreference 'closed' $pill.Location.X $pill.Location.Y }
  $timer.Stop()
  Write-Log 'pill closing'
})
$mini.add_FormClosing({
  if (-not $script:closing) { Save-ModePreference 'closed' $mini.Location.X $mini.Location.Y }
  $timer.Stop()
  Write-Log 'mini closing'
})

# ------------------------------------------------------------------- startup

Read-State
$preference = Read-ModePreference
$startMode = 'pill'
# An explicit request beats the stored preference; the preference only fills in
# what the caller did not say.
if ($preference -ne $null -and $preference.state -ne $null) { $startMode = [string]$preference.state }
if (-not [string]::IsNullOrWhiteSpace($mode)) { $startMode = $mode }

# Record which process is the widget, and own it for as long as this run lasts.
# Both files are written before anything is shown, so a host that asks about the
# widget in the very next moment gets a true answer; and this run deletes its own
# pid file on the way out only if it is still the pid it wrote (a newer widget
# may have replaced it already).
try {
  [System.IO.File]::WriteAllText($script:pidPath, [string]$PID, (New-Object System.Text.UTF8Encoding($false)))
} catch {
  Write-Log "could not record the widget pid: $($_.Exception.Message)"
}

if ($keepClosed) {
  # The host asks this before spawning, so a widget the user closed does not come
  # back on the next launch. One line of JSON on stdout is the whole contract.
  $reported = $startMode
  if ($reported -ne 'mini' -and $reported -ne 'closed') { $reported = 'pill' }
  [Console]::Out.WriteLine((@{ state = $reported; x = $preference.x; y = $preference.y } | ConvertTo-Json -Compress))
  Remove-OwnAliveFile
  exit 0
}

if ($startMode -eq 'closed') {
  Write-Log 'started in the closed state; nothing to show'
  Remove-OwnAliveFile
  exit 0
}

if ($preference -ne $null -and $preference.x -ne $null -and $preference.y -ne $null) {
  $x = [int]$preference.x
  $y = [int]$preference.y
  $pill.Location = New-Object System.Drawing.Point $x, $y
  $mini.Location = New-Object System.Drawing.Point $x, $y
  # Restore it, then pull it back onto a desktop that still exists. Whether the
  # saved spot is usable is a question about the whole virtual screen, not about
  # the primary monitor — see Clamp-ToScreen.
  Clamp-ToScreen
  Write-Log "restored position $x,$y -> $($pill.Location.X),$($pill.Location.Y)"
}

Write-Log "started pid=$PID mode=$startMode state=$statePath url=$dashboardUrl"

if (-not [string]::IsNullOrWhiteSpace($capturePath)) {
  $target = $pill
  $script:active = 'pill'
  if ($startMode -eq 'mini') {
    $target = $mini
    $script:active = 'mini'
  }
  $target.Show()
  # The capture is taken at the window's real size, so the size has to be the
  # designed one first — otherwise the preview documents the bug instead of the
  # widget. See Refresh-WindowSize.
  Refresh-WindowSize
  $target.Refresh()
  [System.Windows.Forms.Application]::DoEvents()
  $settleMs = 700
  if (-not [string]::IsNullOrWhiteSpace($env:ORBIT_HUD_CAPTURE_DELAY_MS)) {
    $settleMs = [int]$env:ORBIT_HUD_CAPTURE_DELAY_MS
  }
  Start-Sleep -Milliseconds $settleMs
  [System.Windows.Forms.Application]::DoEvents()
  try {
    $rect = $target.Bounds
    $bitmap = [OrbitTimeCapture]::Grab($target.Handle, $rect.Width, $rect.Height)
    $sample = $bitmap.GetPixel([int]($rect.Width / 2), [int]($rect.Height / 2))
    if ($sample.R -lt 8 -and $sample.G -lt 8 -and $sample.B -lt 8) {
      Write-Log 'printwindow returned a blank frame; falling back to a screen grab'
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size)
      $graphics.Dispose()
    }
    $bitmap.Save($capturePath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    Write-Log "captured $capturePath ($($rect.Width)x$($rect.Height))"
  } catch {
    Write-Log "capture FAILED: $($_.Exception.Message)"
  }
  $script:closing = $true
  $timer.Stop()
  $target.Hide()
  exit 0
}

if ($selfTest) {
  # Exercise the input path without a human: hit-test every region and route the
  # same actions a real click would. This is what proves the widget is
  # interactive rather than merely visible.
  $pillCentre = New-Object System.Drawing.Point ([int]($script:ringX + $script:ringSize / 2)), ([int]($script:ringY + $script:ringSize / 2))
  $minPoint = New-Object System.Drawing.Point ($script:hitMin.X + 5), ($script:hitMin.Y + 5)
  $expandPoint = New-Object System.Drawing.Point ($script:hitExpand.X + 5), ($script:hitExpand.Y + 5)
  $closePoint = New-Object System.Drawing.Point ($script:hitClose.X + 5), ($script:hitClose.Y + 5)
  $blank = New-Object System.Drawing.Point 120, 58
  Write-Log ("selftest hits play={0} min={1} expand={2} close={3} blank={4}" -f `
      (Get-PillHit $pillCentre), (Get-PillHit $minPoint), (Get-PillHit $expandPoint), (Get-PillHit $closePoint), (Get-PillHit $blank))

  $miniCentre = New-Object System.Drawing.Point ([int]($script:miniSize / 2)), ([int]($script:miniSize / 2))
  $miniClosePoint = New-Object System.Drawing.Point ($script:hitMiniClose.X + 3), ($script:hitMiniClose.Y + 3)
  $miniGrowPoint = New-Object System.Drawing.Point ($script:hitMiniGrow.X + 3), ($script:hitMiniGrow.Y + 3)
  Write-Log ("selftest mini hits ring={0} close={1} grow={2}" -f `
      (Get-MiniHit $miniCentre), (Get-MiniHit $miniClosePoint), (Get-MiniHit $miniGrowPoint))

  # Paint both states once so a rendering exception surfaces here, not on screen.
  foreach ($pair in @(@($script:pillWidth, $script:pillHeight), @($script:miniSize, $script:miniSize))) {
    # Not `$probe`: that is the -probe parameter, and a local of the same name
    # would shadow it inside this block.
    $probeBitmap = New-Object System.Drawing.Bitmap $pair[0], $pair[1]
    $probeGraphics = [System.Drawing.Graphics]::FromImage($probeBitmap)
    try {
      $probeGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $values = Get-StateValues
      $progress = Update-Smoothing $values.remaining $values.total
      Draw-Ring $probeGraphics ($pair[0] / 2.0) ($pair[1] / 2.0) 30 $progress $colAccent 'pause'
      $probeGraphics.DrawString('18:24', $script:fontTime, (New-Object System.Drawing.SolidBrush $colText), 4, 4)
      Write-Log "selftest paint ok ($($pair[0])x$($pair[1]))"
    } catch {
      Write-Log "selftest paint FAILED: $($_.Exception.Message)"
    }
    $probeGraphics.Dispose()
    $probeBitmap.Dispose()
  }

  # Route one synthetic click through the real action path, and record the
  # transition the minimise button would take.
  if ((Get-PillHit $pillCentre) -eq 'play') { Send-Action 'toggle' }
  Write-Log "selftest transitions min=$(Get-PillHit $minPoint) grow=$(Get-MiniHit $miniGrowPoint) exit=$(Get-MiniHit $miniClosePoint)"
  Write-Log 'selftest done'
  exit 0
}

<#
Drive the widget with real mouse input.

`-selfTest` above answers "is the hit-testing arithmetic right?". It cannot
answer "is the window wired up?" — it calls Get-PillHit directly, which returns
the correct answer whether or not a single handler is attached. That gap is how
this widget once shipped painting perfectly and answering no clicks at all.

So `-probe=<target,target,…>` moves the cursor onto each control, synthesises a
real left click through SendInput, and lets the ordinary MouseDown / MouseUp
handlers do the rest. Everything it does is visible in `-logPath`:

    probe start
    probe min click at 2471,881
    down at 214,32 hit=min

A target whose click never arrives leaves no `down at` line, which is precisely
the failure being tested for.
#>
if (-not [string]::IsNullOrWhiteSpace($probe)) {
  $spawnPoint = @{ x = $pill.Location.X; y = $pill.Location.Y }
  if ($startMode -eq 'mini') { $script:active = 'mini'; $mini.Show() } else { $script:active = 'pill'; $pill.Show() }
  [System.Windows.Forms.Application]::DoEvents()

  $origin = [OrbitTimeInput]::Cursor()
  Write-Log ("probe start targets=$probe origin=$($origin[0]),$($origin[1])")
  $timer.Start()
  foreach ($name in ($probe -split ',')) {
    $clean = $name.Trim()
    if ($clean -eq '') { continue }
    # State transitions are part of the schedule: clicking — collapses the pill,
    # so the mini targets are only reachable after it.
    if ($clean -eq 'min') { Show-Mini }
    if ($clean -eq 'minigrow') { Show-Pill }
    [System.Windows.Forms.Application]::DoEvents()
    if ($script:closing) {
      Write-Log "probe stop after $clean (the widget closed)"
      break
    }
    $active = Get-ActiveWindow
    $point = Get-TargetCenter $clean
    $screen = $active.form.PointToScreen($point)
    $sentMove = [OrbitTimeInput]::Move($screen.X, $screen.Y)
    Start-Sleep -Milliseconds 180
    [System.Windows.Forms.Application]::DoEvents()
    $now = [OrbitTimeInput]::Cursor()
    $sentClick = [OrbitTimeInput]::Click()
    # The window that owned this click is named *before* the click, because a
    # click on — or × changes which window is active.
    Write-Log "probe $clean click at $($screen.X),$($screen.Y) window=$($active.name) cursor=$($now[0]),$($now[1]) sent=$sentMove/$sentClick"
    Start-Sleep -Milliseconds 180
    [System.Windows.Forms.Application]::DoEvents()
  }
  [OrbitTimeInput]::Move($origin[0], $origin[1])
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.Application]::DoEvents()
  $recorded = Read-ModePreference
  $recordedState = ''
  if ($recorded -ne $null -and $recorded.state -ne $null) { $recordedState = [string]$recorded.state }
  Write-Log "probe done recorded=$recordedState"
  $timer.Stop()
  $script:closing = $true
  $pill.Hide()
  $mini.Hide()
  exit 0
}

if (-not [string]::IsNullOrWhiteSpace($drag)) {
  # Drive one real drag and report where the window ended up.
  #
  # "拖不动" is not answerable from the outside: the widget can look up, wired and
  # painted while the window never moves, and there is no log line that says so.
  # This synthesises a genuine press, a genuine move and a genuine release
  # through the OS input queue, then reports the before and after rectangles as
  # machine-readable JSON — which is also the only way to see this from a test,
  # because a confined Node run cannot open the pipe that reading stdout needs.
  #
  # `-drag <dx>,<dy>` — pixels to move by. The widget is parked first, so the
  # starting point is known and a clamp at the screen edge cannot be mistaken for
  # a working drag. `-aimAt <play|minigrow|miniclose|strip>` aims the press at a
  # named control instead of the drag strip, which is how "pressing × must not
  # move the window" is tested. `-hold <ms>` keeps the widget up afterwards so the
  # shutdown path can be driven against it.
  if ($startMode -eq 'mini') {
    $script:active = 'mini'
    $mini.Location = New-Object System.Drawing.Point 220, 220
    $mini.Show()
  } else {
    $script:active = 'pill'
    $pill.Location = New-Object System.Drawing.Point 220, 220
    $pill.Show()
  }
  Refresh-WindowSize
  $form = (Get-ActiveWindow).form
  $form.Activate()
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.Application]::DoEvents()

  $parts = $drag -split ','
  $dx = 60
  $dy = 40
  if ($parts.Length -ge 2) {
    [void][int]::TryParse($parts[0].Trim(), [ref]$dx)
    [void][int]::TryParse($parts[1].Trim(), [ref]$dy)
  }

  $before = $form.Location
  $origin = [OrbitTimeInput]::Cursor()
  # Aim at a real drag surface, not at the ring: the ring is the play/pause
  # control, and a press on a control must never move the window — so a probe
  # that pressed the ring and expected movement would be testing the bug back in.
  $centre = New-Object System.Drawing.Point ([int]($script:ringX + $script:ringSize + $script:textGap)), ([int]($script:pillHeight / 2))
  if ($script:active -eq 'mini') { $centre = Get-MiniPoint 'strip' }
  $pressName = $aimAt.Trim()
  if ($pressName -ne '') {
    # A named control, in the state the widget is actually in.
    if ($script:active -eq 'mini') { $centre = Get-MiniPoint $pressName } else { $centre = Get-TargetCenter $pressName }
  }
  $pressHit = Resolve-Hit $script:active $centre
  Write-Log "drag probe: state=$($script:active) aimAt='$($aimAt.Trim())' point=$($centre.X),$($centre.Y) hit=$pressHit"
  $start = $form.PointToScreen($centre)
  $timer.Start()
  [void][OrbitTimeInput]::Move($start.X, $start.Y)
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.Application]::DoEvents()
  $arrived = [OrbitTimeInput]::Cursor()
  $injected = ([Math]::Abs($arrived[0] - $start.X) -le 3 -and [Math]::Abs($arrived[1] - $start.Y) -le 3)
  $realMode = 'injected'
  if (-not $injected) {
    # A restricted or sessionless desktop refuses SendInput and leaves the cursor
    # where it was, so a real drag cannot even be attempted. The state machine is
    # then driven directly instead: same functions, same order as the frame loop,
    # with the pointer read supplied rather than synthesised. That is the half a
    # test can always check — "does a held button plus a moving cursor move the
    # window?" — and it is the half that was broken.
    $realMode = 'simulated'
    Write-Log 'drag: synthesised input was refused by this desktop; driving the state machine directly'
  }

  if ($realMode -eq 'injected') {
    [void][OrbitTimeInput]::Press()
    Start-Sleep -Milliseconds 160
    [System.Windows.Forms.Application]::DoEvents()
    # Several small steps rather than one jump: the state machine moves the window
    # by the cursor's delta each frame, so a single leap measures the frame timing
    # as much as the drag.
    for ($step = 1; $step -le 6; $step++) {
      [void][OrbitTimeInput]::Move(($start.X + [int]($dx * $step / 6)), ($start.Y + [int]($dy * $step / 6)))
      Start-Sleep -Milliseconds 70
      [System.Windows.Forms.Application]::DoEvents()
    }
    [void][OrbitTimeInput]::Release()
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.Application]::DoEvents()
  } else {
    # The frame loop owns the real pointer; stand it down so the simulation is the
    # only thing moving the window, then run the two functions it runs.
    $timer.Stop()
    $dragPoint = $centre
    $held = @{
      point = New-Object System.Drawing.Point $start.X, $start.Y
      client = $dragPoint
      inside = $true
      hit = $pressHit
      down = $true
    }
    # Update-Pointer is told the pointer read it would have made itself. Its
    # `-at` argument is what `-selfDrive` uses to aim, and it only applies when
    # the pointer is synthesised — here the real hit travels in the table, so the
    # value is inert.
    Update-Pointer 'real' 'ring' $held
    Update-Drag $held
    $steps = 6
    for ($step = 1; $step -le $steps; $step++) {
      $held.point = New-Object System.Drawing.Point (($start.X + [int]($dx * $step / $steps))), (($start.Y + [int]($dy * $step / $steps)))
      # The window has to be re-read each step, exactly as the frame loop does:
      # the move is relative to where the card is now.
      $held.client = New-Object System.Drawing.Point (($dragPoint.X + $held.point.X - $start.X)), (($dragPoint.Y + $held.point.Y - $start.Y))
      Update-Drag $held
      Update-PointerVisuals
    }
    $held.down = $false
    Update-Drag $held
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.Application]::DoEvents()
  }

  $moved = $form.Location
  $preference = Read-ModePreference
  $recordedX = $null
  $recordedY = $null
  $recordedState = ''
  if ($preference -ne $null) {
    if ($preference.x -ne $null) { $recordedX = [int]$preference.x }
    if ($preference.y -ne $null) { $recordedY = [int]$preference.y }
    if ($preference.state -ne $null) { $recordedState = [string]$preference.state }
  }
  $movedByX = $moved.X - $before.X
  $movedByY = $moved.Y - $before.Y
  $report = [ordered]@{
    requested = "$dx,$dy"
    mode = $realMode
    state = $script:active
    expectedSize = "$($form.ClientSize.Width)x$($form.ClientSize.Height)"
    pressHit = $pressHit
    before = "$($before.X),$($before.Y)"
    after = "$($moved.X),$($moved.Y)"
    movedBy = "$movedByX,$movedByY"
    dragStarted = ($movedByX -ne 0 -or $movedByY -ne 0)
    withinSlop = ([Math]::Abs($movedByX - $dx) -le 12 -and [Math]::Abs($movedByY - $dy) -le 12)
    recorded = "$recordedX,$recordedY"
    recordedState = $recordedState
    screen = ([OrbitTimeWindows]::VirtualScreen() -join ',')
  }
  if ($realMode -eq 'injected') { [void][OrbitTimeInput]::Move($origin[0], $origin[1]) }
  Write-Log ("drag report " + ($report | ConvertTo-Json -Compress))
  if (-not [string]::IsNullOrWhiteSpace($reportPath)) {
    [System.IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
  }
  if (-not [string]::IsNullOrWhiteSpace($hold)) {
    # Stay up so the caller can close this widget the way the panel does — with a
    # second `hud.ps1 -shutdown`, over the pid file this run wrote. That is the
    # whole "关闭都管不了" path, and it needs a live process at the other end.
    Write-Log "drag: holding for $hold ms so the shutdown path can be driven"
    $deadline = (Get-Date).AddMilliseconds([int]$hold)
    while ((Get-Date) -lt $deadline -and -not $script:closing) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 100
    }
    Write-Log 'drag: hold over'
  }
  Start-Sleep -Milliseconds 120
  $timer.Stop()
  $script:closing = $true
  $pill.Hide()
  $mini.Hide()
  exit 0
}

if ($wiring) {
  # The direct answer to "is the window connected to the mouse?". Read before
  # either form is shown, because showing is not what does the wiring.
  foreach ($pair in @(@('pill', $pill), @('mini', $mini))) {
    Write-Log ("wiring {0}: {1}" -f $pair[0], (Get-WiredEvents $pair[1]))
  }
  exit 0
}

if ($selfDrive) {
  # Show the pill, run a real message loop, hand it one mouse message, and see
  # whether the handler sees it.
  #
  # `-selfTest` calls the hit-test functions; `-wiring` reads the handler table.
  # Neither proves the queue is being pumped and read. This does: the message is
  # posted from inside the process, after the loop is running, and the verdict is
  # the handler's own log line.
  $script:active = 'pill'
  $pill.Show()
  $pill.Activate()
  [System.Windows.Forms.Application]::DoEvents()
  $handle = $pill.Handle
  $point = Get-TargetCenter 'ring'
  Write-Log ("selfdrive window shown handle=$($handle.ToInt64()) ring=$($point.X),$($point.Y)")

  # 1. The polling input path, driven on demand: press and release over each
  #    named control. This is the path that does not need a message, so it is the
  #    one that has to work here.
  foreach ($target in ($drive -split ',')) {
    $name = $target.Trim()
    if ($name -eq '') { continue }
    Write-Log "selfdrive: polling press over $name"
    Update-Pointer 'press' $name
    Write-Log "selfdrive: $name after press pressed='$($script:pressed)' hover='$($script:hover)'"
    Write-Log "selfdrive: polling release over $name"
    Update-Pointer 'release' $name
    Write-Log "selfdrive: $name after release pressed='$($script:pressed)' target='$($script:pollTarget)'"
    if ($script:closing) {
      Write-Log "selfdrive: the widget closed after $name"
      break
    }
    [System.Windows.Forms.Application]::DoEvents()
  }

  # 2. Then the message path, with a watchdog so a stall is reported rather than
  #    hanging the diagnostic.
  $driver = New-Object System.Windows.Forms.Timer
  $driver.Interval = 500
  $driver.add_Tick({
    $driver.Stop()
    Write-Log 'selfdrive A: about to post WM_LBUTTONDOWN'
    Write-Log ("selfdrive B: posted=" + [OrbitTimeInput]::PostLeftDown($pill.Handle, $point.X, $point.Y))
    Write-Log 'selfdrive C: about to pump'
    [System.Windows.Forms.Application]::DoEvents()
    Write-Log "selfdrive D: pumped, pressed='$($script:pressed)'"
    Write-Log 'selfdrive done'
    $script:closing = $true
    $pill.Hide()
    [System.Windows.Forms.Application]::Exit()
  })
  $driver.Start()
  [System.Windows.Forms.Application]::Run()
  exit 0
}

if ($startMode -eq 'mini') {
  $script:active = 'mini'
  $mini.Show()
  # The heartbeat is written once the state is the one that will be displayed, so
  # it never reports the pre-show default.
  Write-AliveFile
  Write-Log ("mode -> mini (restored) client=$($mini.ClientSize.Width)x$($mini.ClientSize.Height) " +
      "size=$($mini.Size.Width)x$($mini.Size.Height) state=$($mini.WindowState) " +
      "expected=$($script:miniSize) scale=$($script:uiScale)")
  # Showing the window re-applies a size the form did not ask for: a borderless
  # 112x112 form comes back 262x112 on this machine, and `SetWindowPos` is refused
  # while `ClientSize` is honoured — so the size is set once more, after the window
  # exists. See Refresh-WindowSize.
  Refresh-WindowSize
  $mini.Invalidate()
  Write-Log ("size after show: client=$($mini.ClientSize.Width)x$($mini.ClientSize.Height)")
} else {
  $script:active = 'pill'
  $pill.Show()
  Write-AliveFile
  Write-Log ("mode -> pill (restored) client=$($pill.ClientSize.Width)x$($pill.ClientSize.Height) " +
      "size=$($pill.Size.Width)x$($pill.Size.Height) expected=$($script:pillWidth)x$($script:pillHeight) scale=$($script:uiScale)")
  Refresh-WindowSize
  $pill.Invalidate()
}

# An explicit message loop rather than ShowDialog.
#
# ShowDialog is modal per form and cannot be entered again once a sibling form on
# the same thread has been shown and hidden — switching states would end the loop
# and trying to resume it throws "Exception calling ShowDialog". Application.Run
# keeps pumping until Application.Exit is called, which is what the state
# switching needs.
#
# The line before it is deliberate. `Control.add_MouseDown` fills a handler table;
# it does not pump a queue. A window can be visible, wired, painted and still
# answer nothing, because the thread never reached a message loop — and from
# outside, that is indistinguishable from a widget whose handlers are missing.
# This records that the loop was entered.
Write-Log 'message loop starting'
try {
  [System.Windows.Forms.Application]::Run()
} catch {
  Write-Log "message loop ended: $($_.Exception.Message)"
}
Remove-OwnAliveFile
Write-Log 'exited'
