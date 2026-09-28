import {
  isToolLifecycleItemType,
  type AssetResource,
  type ThreadId,
  type ToolLifecycleItemType,
} from "@t3tools/contracts";
import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import {
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
  workspaceVideoPreviewMimeType,
} from "@t3tools/shared/filePreview";

export function isWorktreeSetupActivity(kind: string): boolean {
  return kind === "setup-script.requested" || kind === "setup-script.started";
}

export interface WorkLogPresentationEntry {
  readonly label: string;
  readonly toolTitle?: string;
  readonly tone: "thinking" | "tool" | "info" | "error";
  readonly command?: string;
  readonly detail?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly itemType?: ToolLifecycleItemType;
  readonly requestKind?: string;
  readonly turnId?: string | null;
  readonly toolCallId?: string;
  readonly toolLifecycleStatus?: string;
  readonly sourceActivityKind?: string;
  readonly taskId?: string;
}

export type ToolGroupAction =
  | "read"
  | "edit"
  | "command"
  | "code-search"
  | "search"
  | "other"
  | "update";

export type ToolGroupSummaryKind =
  | ToolGroupAction
  | "dynamic-tool"
  | "agent-tool"
  | "tone-tool"
  | "mixed";

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function workLogEntryIsToolLike(entry: WorkLogPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (entry.command !== undefined && entry.command.trim().length > 0) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

export function workLogEntryIsLocalCodeSearch(entry: WorkLogPresentationEntry): boolean {
  return (
    entry.itemType === "web_search" &&
    /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label))
  );
}

export function toolGroupAction(entry: WorkLogPresentationEntry): ToolGroupAction {
  if (
    entry.requestKind === "file-read" ||
    entry.itemType === "image_view" ||
    (entry.itemType === "dynamic_tool_call" &&
      entry.toolTitle?.trim().toLowerCase() === "read file")
  ) {
    return "read";
  }
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (entry.changedFiles?.length ?? 0) > 0
  ) {
    return "edit";
  }
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (workLogEntryIsLocalCodeSearch(entry)) return "code-search";
  if (entry.itemType === "web_search") return "search";
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

export function workEntryViewedImagePath(entry: WorkLogPresentationEntry): string | null {
  const detail = entry.detail?.trim();
  return toolGroupAction(entry) === "read" &&
    detail !== undefined &&
    !/[\r\n]/.test(detail) &&
    isWorkspaceImagePreviewPath(detail)
    ? detail
    : null;
}

export interface ViewedImageAsset {
  readonly resource: Extract<AssetResource, { readonly _tag: "attachment" | "workspace-file" }>;
  readonly alt: string;
  readonly srcFragment: string;
}

const ABSOLUTE_IMAGE_SOURCE_PATTERN = /^(?:file:|[\\/]|[a-z]:[\\/])/i;
const T3_ATTACHMENT_IMAGE_PATH_PATTERN =
  /(?:^|[\\/])(?:dev|userdata)[\\/]attachments[\\/]([a-z0-9_]+(?:-[a-z0-9_]+)*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[a-z0-9]{1,10})?)\.[a-z0-9]{1,10}$/i;

export function resolveViewedImageAsset(
  source: string,
  input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot?: string | null | undefined;
  },
): ViewedImageAsset | null {
  const imageSource = classifyMarkdownImageSource(source, input.workspaceRoot ?? ".");
  if (imageSource._tag !== "WorkspaceFile") return null;

  const path =
    input.workspaceRoot == null && imageSource.path.startsWith("./")
      ? imageSource.path.slice(2)
      : imageSource.path;
  const attachmentId = ABSOLUTE_IMAGE_SOURCE_PATTERN.test(source)
    ? (T3_ATTACHMENT_IMAGE_PATH_PATTERN.exec(path)?.[1] ?? null)
    : null;

  return {
    resource: attachmentId
      ? { _tag: "attachment", attachmentId }
      : { _tag: "workspace-file", threadId: input.threadId, path },
    alt: path.split(/[\\/]/).at(-1) ?? "image",
    srcFragment: markdownImageSourceFragment(source),
  };
}

const FFMPEG_PROGRAM_PATTERN = /^(?:.*[\\/])?ffmpeg(?:\.exe)?$/i;
const HANDBRAKE_PROGRAM_PATTERN = /^(?:.*[\\/])?HandBrakeCLI(?:\.exe)?$/i;
/** `rtmp://…`, `avformat:out.mp4` etc. are not workspace files (drive letters are). */
const URI_LIKE_PATH_PATTERN = /^[a-z][a-z0-9+.-]+:/i;
/** Shell words that the shell would still expand; never a literal emitted path. */
const UNEXPANDED_SHELL_WORD_PATTERN = /[$`*?{}]/;
/** Fragment/query characters the markdown asset classifier would strip. */
const PATH_QUERY_OR_FRAGMENT_PATTERN = /[?#]/;
const ABSOLUTE_PATH_PATTERN = /^(?:[\\/]|[a-z]:[\\/])/i;
const SHELL_TOKEN_PATTERN =
  /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\d*[<>]{1,2}&?\d*|\|\||&&|[|;&()])|([^\s"'|;&()<>]+)/g;
const SHELL_CONTROL_OPERATORS = new Set(["|", "||", "&&", ";", "&", "(", ")"]);

interface ShellWord {
  readonly value: string;
}

/**
 * Splits a command line into simple-command segments of words, dropping
 * redirections and their targets. Deliberately naive: anything it cannot
 * model (adjacent quoted pieces, expansions) yields words that later fail
 * the literal-path checks, so the caller shows no tile rather than a wrong one.
 */
function shellSegments(command: string): ShellWord[][] {
  const segments: ShellWord[][] = [[]];
  let skipRedirectTarget = false;
  for (const match of command.matchAll(SHELL_TOKEN_PATTERN)) {
    const operator = match[3];
    if (operator !== undefined) {
      skipRedirectTarget = false;
      if (SHELL_CONTROL_OPERATORS.has(operator)) {
        segments.push([]);
      } else if (!/&\d*$/.test(operator)) {
        // `> file` / `2> file`: the next word is the redirect target, not an argument.
        skipRedirectTarget = true;
      }
      continue;
    }
    if (skipRedirectTarget) {
      skipRedirectTarget = false;
      continue;
    }
    segments.at(-1)?.push({ value: match[1] ?? match[2] ?? match[4] ?? "" });
  }
  return segments.filter((segment) => segment.length > 0);
}

function isLiteralVideoOutputPath(path: string): boolean {
  return (
    isWorkspaceVideoPreviewPath(path) &&
    !UNEXPANDED_SHELL_WORD_PATTERN.test(path) &&
    !PATH_QUERY_OR_FRAGMENT_PATTERN.test(path) &&
    !URI_LIKE_PATH_PATTERN.test(path)
  );
}

/**
 * The file a render invocation writes: HandBrakeCLI's `-o`/`--output`
 * argument, or ffmpeg's final positional argument. Arguments to `-i` are
 * inputs and never count as the output. melt is not handled: its
 * positionals are inputs and its output hides inside `-consumer`.
 */
function renderSegmentOutput(
  program: "ffmpeg" | "handbrake",
  args: ReadonlyArray<string>,
): string | null {
  const inputs = new Set<string>();
  let output: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const next = args[index + 1];
    if (arg === "-i" && next !== undefined) {
      inputs.add(next);
      index += 1;
    } else if (
      program === "handbrake" &&
      (arg === "-o" || arg === "--output") &&
      next !== undefined
    ) {
      output = next;
      index += 1;
    } else if (program === "handbrake" && arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
    }
  }
  if (output === null) {
    if (program !== "ffmpeg") return null;
    const last = args.at(-1);
    const beforeLast = args.at(-2);
    if (last === undefined || beforeLast === "-i" || last.startsWith("-")) return null;
    output = last;
  }
  return inputs.has(output) || !isLiteralVideoOutputPath(output) ? null : output;
}

/**
 * The clip a completed render command wrote, or null when it cannot be
 * identified with confidence. A relative output after a `cd`/`pushd` is
 * dropped: it would resolve against the workspace root, not the new cwd.
 */
function renderCommandOutputPath(command: string): string | null {
  let changedDirectory = false;
  let output: string | null = null;
  for (const segment of shellSegments(command)) {
    const words = segment.map((word) => word.value);
    const first = words[0];
    if (first === "cd" || first === "pushd" || first === "popd") {
      changedDirectory = true;
      continue;
    }
    const programIndex = words.findIndex(
      (word) => FFMPEG_PROGRAM_PATTERN.test(word) || HANDBRAKE_PROGRAM_PATTERN.test(word),
    );
    if (programIndex < 0) continue;
    const program = FFMPEG_PROGRAM_PATTERN.test(words[programIndex] ?? "") ? "ffmpeg" : "handbrake";
    const candidate = renderSegmentOutput(program, words.slice(programIndex + 1));
    if (candidate === null) continue;
    if (changedDirectory && !ABSOLUTE_PATH_PATTERN.test(candidate)) continue;
    output = candidate;
  }
  return output;
}

/**
 * The finished video clip a work-log entry points at, if any: a video the
 * agent read, a video file it changed, or the output of a completed
 * ffmpeg-like render command. Conservative by design: no tile beats a
 * broken one, so inputs, unexpanded shell words and ambiguous relative
 * outputs are ignored. Running tools return null because the file may
 * still be partial.
 */
export function workEntryVideoPath(entry: WorkLogPresentationEntry): string | null {
  if (entry.toolLifecycleStatus === "inProgress") return null;
  const action = toolGroupAction(entry);
  const detail = entry.detail?.trim();
  if (
    action === "read" &&
    detail !== undefined &&
    !/[\r\n]/.test(detail) &&
    isWorkspaceVideoPreviewPath(detail) &&
    !PATH_QUERY_OR_FRAGMENT_PATTERN.test(detail)
  ) {
    return detail;
  }
  const changedVideo = entry.changedFiles?.findLast(
    (path) => isWorkspaceVideoPreviewPath(path) && !PATH_QUERY_OR_FRAGMENT_PATTERN.test(path),
  );
  if (changedVideo !== undefined) return changedVideo;
  const command = entry.command?.trim();
  if (action === "command" && entry.toolLifecycleStatus === "completed" && command !== undefined) {
    return renderCommandOutputPath(command);
  }
  return null;
}

export interface VideoClipAsset {
  readonly resource: Extract<AssetResource, { readonly _tag: "attachment" | "workspace-file" }>;
  readonly name: string;
}

/**
 * Maps a video path from a work entry or markdown to the signed-asset
 * resource the existing video player streams. T3 attachment videos carry
 * their inline mime so the server serves them for playback, not download.
 */
export function resolveVideoClipAsset(
  source: string,
  input: {
    readonly threadId: ThreadId;
    readonly workspaceRoot?: string | null | undefined;
  },
): VideoClipAsset | null {
  const asset = resolveViewedImageAsset(source, input);
  // Classify the file name the server will actually resolve (the markdown
  // classifier strips `?query`/`#fragment`), so client and server agree.
  const mimeType = asset === null ? null : workspaceVideoPreviewMimeType(asset.alt);
  if (mimeType === null || asset === null) return null;
  return {
    resource:
      asset.resource._tag === "attachment"
        ? { ...asset.resource, fileName: asset.alt, mimeType }
        : asset.resource,
    name: asset.alt,
  };
}

function toolGroupActionCount(
  action: ToolGroupAction,
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): number {
  if (action !== "edit") return entries.length;

  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
      continue;
    }
    for (const file of entry.changedFiles) changedFiles.add(file);
  }
  return changedFiles.size + editsWithoutFileDetails;
}

function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "search":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
    case "update":
      return `Received ${count} ${count === 1 ? "update" : "updates"}`;
  }
}

export function summarizeToolGroup(entries: ReadonlyArray<WorkLogPresentationEntry>): string {
  const summaryEntries = omitSupersededLifecycleMarkers(entries, (entry) => entry);
  const groupedEntries = new Map<ToolGroupAction, WorkLogPresentationEntry[]>();
  for (const entry of summaryEntries) {
    const action = toolGroupAction(entry);
    const group = groupedEntries.get(action);
    if (group) group.push(entry);
    else groupedEntries.set(action, [entry]);
  }
  const labels = [...groupedEntries].map(([action, actionEntries]) =>
    toolGroupActionLabel(action, toolGroupActionCount(action, actionEntries)),
  );
  const sentenceLabels = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  if (sentenceLabels.length < 2) return sentenceLabels[0] ?? "";
  if (sentenceLabels.length === 2) return sentenceLabels.join(" and ");
  return `${sentenceLabels.slice(0, -1).join(", ")}, and ${sentenceLabels.at(-1)}`;
}

export function omitSupersededLifecycleMarkers<T>(
  entries: readonly T[],
  workEntryFor: (entry: T) => WorkLogPresentationEntry,
): T[] {
  const laterTerminalIdentities = new Set<string>();
  const reversedEntries: T[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const workEntry = workEntryFor(entry);
    const normalizedLabel = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label);
    const identity = [
      workEntry.turnId ?? "no-turn",
      workEntry.itemType ?? "",
      normalizedLabel,
    ].join("\u001f");
    const activityKind = workEntry.sourceActivityKind;
    const isStatuslessIdlessMarker =
      workEntry.toolCallId === undefined &&
      workEntry.toolLifecycleStatus === undefined &&
      (activityKind === "tool.started" || activityKind === "tool.updated");
    if (isStatuslessIdlessMarker && laterTerminalIdentities.has(identity)) continue;

    reversedEntries.push(entry);
    if (
      activityKind === "tool.completed" ||
      (workEntry.toolLifecycleStatus !== undefined &&
        workEntry.toolLifecycleStatus !== "inProgress")
    ) {
      laterTerminalIdentities.add(identity);
    }
  }

  return reversedEntries.toReversed();
}

export function toolGroupSummaryKind(
  entries: ReadonlyArray<WorkLogPresentationEntry>,
): ToolGroupSummaryKind {
  const actions = new Set(entries.map(toolGroupAction));
  if (actions.size !== 1) return "mixed";

  const action = actions.values().next().value!;
  if (action !== "other") return action;

  const fallbackKinds = new Set(
    entries.map((entry): ToolGroupSummaryKind => {
      if (entry.itemType === "mcp_tool_call") return "other";
      if (entry.itemType === "dynamic_tool_call") return "dynamic-tool";
      if (entry.itemType === "collab_agent_tool_call" || entry.taskId) return "agent-tool";
      if (entry.tone === "thinking") return "agent-tool";
      if (entry.tone === "tool") return "tone-tool";
      return "other";
    }),
  );
  return fallbackKinds.size === 1 ? fallbackKinds.values().next().value! : "mixed";
}
