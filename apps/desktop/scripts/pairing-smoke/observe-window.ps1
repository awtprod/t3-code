param([int]$ApplicationPid, [int]$TimeoutMilliseconds = 45000)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PairingWindowObserver {
  private delegate bool Callback(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  public static long[] VisibleWindows(uint expectedPid) {
    var found = new List<long>();
    EnumWindows((hwnd, parameter) => { uint pid; GetWindowThreadProcessId(hwnd, out pid); if (pid == expectedPid && IsWindowVisible(hwnd)) found.Add(hwnd.ToInt64()); return true; }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@
$record = @{ applicationPid=$ApplicationPid; observerSessionId=[System.Diagnostics.Process]::GetCurrentProcess().SessionId; userInteractive=[Environment]::UserInteractive; visibleWindows=@() }
$timer = [Diagnostics.Stopwatch]::StartNew()
while ($timer.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
  $application = Get-Process -Id $ApplicationPid -ErrorAction SilentlyContinue
  if (!$application) { $record.processExited=$true; break }
  $record.applicationSessionId=$application.SessionId
  $windows = @([PairingWindowObserver]::VisibleWindows([uint32]$ApplicationPid))
  if ($windows.Count) { $record.visibleWindows=$windows; $record.observedAt=[DateTime]::UtcNow.ToString('o'); break }
  Start-Sleep -Milliseconds 100
}
$record.elapsedMilliseconds=$timer.ElapsedMilliseconds
ConvertTo-Json -InputObject $record -Compress
