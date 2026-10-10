# Resource telemetry

Process counters come from a [standalone Rust monitor](../../native/resource-monitor/src/main.rs)
using `sysinfo`. Electron main supplies host power and Electron process metrics.
Keeping native collection outside Node isolates collector crashes and avoids a
Node/Electron addon ABI matrix. Desktop and CLI servers use the same child-process
protocol. A missing or failed collector leaves the server running.

## Collection cost

The native child owns sampling and bounded in-memory history. The server requests
continuous snapshots only while diagnostics has live subscribers and fetches
history on demand. Consuming host power for background scheduling must not retain
live diagnostics. There is no telemetry database or recurring shell-probe fallback.

History has independent bounds for age, snapshot count, process rows, and retained
bytes. A count limit alone cannot bound memory when command lines vary in size.
Large process trees therefore shorten the available history window. Linux task
enumeration is disabled because walking every `/proc/<pid>/task/<tid>` directory
makes sampling itself expensive.

Electron power updates travel over private inherited pipes, independent of the
renderer connection. Power events and slow heartbeats continue with diagnostics
closed; `app.getAppMetrics()` runs only on live demand. The receiver's stale deadline
must exceed the slowest configured heartbeat plus scheduling grace, or intentional
idle polling makes background policy oscillate between constrained and
unconstrained states. Headless servers leave unavailable power data unknown.

## Measurement traps

- Process identity includes start time because operating systems reuse PIDs.
  Electron and native start times have different precision, so merging allows a
  small tolerance. Process signaling rechecks the native identity with a fresh
  sample.
- Snapshot sequence numbers belong to a monitor generation. Comparing them across
  restarts would discard the new monitor's samples until its sequence caught up.
- Sampling can miss a process that starts and exits between samples. Cumulative
  counters still yield deltas for processes observed across samples.
- Windows process I/O includes more than disk traffic. Unix counters report storage
  I/O, which can differ from logical application reads and writes because of OS
  caching. Keep instrumented logical I/O separate from these counters.
- Group totals accumulate observed deltas since telemetry started. Per-process
  cumulative counters cover the operating system's lifetime for that process.
- Historical replay uses native samples without current Electron CPU or memory
  metrics. Merging the latest Electron values would overwrite the past.

A WSL backend needs a Linux monitor even though Electron runs on Windows. Windows
desktop packages currently supply only the Windows executable, so native process
telemetry for the WSL backend is unavailable. The inherited Electron power feed
still works.

## Host usage

The Resources pane reads [`HostUsage`](../../apps/server/src/resourceTelemetry/HostUsage.ts),
which covers the whole host rather than the server's process tree. It answers what
is filling the disks and which processes hold an outsized share of the machine.

- Disks: one `statfs` per filesystem the server writes to (state, runtime,
  worktrees, project workspaces, temp), grouped by device so bind mounts collapse
  into the disk they live on. A one-minute sampler keeps an hour of free-space
  readings for the fill rate and time-until-full estimate.
- Processes: read from `/proc` only when a client asks, with a five-second cache
  shared by every socket. CPU and write rates need two readings, so a cold read
  waits one second for the second sample. Another user's I/O counters and working
  directory are hidden from the server, so those columns can be empty.
  Command lines are redacted before they leave the server because agent CLIs
  receive credentials as arguments.
- Disk scan: on demand only. One `nice -n 19 du -x -d 2` per scan root, run one at
  a time. Roots are each repository directory under the worktrees directory, the
  parent of each project workspace (never `/`, a home directory, or a directory
  that holds home directories), and the runtime base directory.
- Reclaim deletes only git-ignored build output, found with the same checks the
  worktree cleanup sweep uses. It refuses anything outside a scan root, anything
  that is not a checkout, home directories, and checkouts with a live process inside
  or a busy thread. Live processes are only visible on Linux, so reclaim is disabled
  on other platforms.
  The daily sweep remains the automatic path; reclaim is the manual one for
  checkouts the sweep never sees, such as builds outside thread worktrees.
