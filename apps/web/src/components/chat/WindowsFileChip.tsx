import { MonitorIcon, XIcon } from "lucide-react";

import type { ChatWindowsFileAttachment } from "~/types";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * A reference to a file on the Windows host. Shown in the composer (with a
 * remove button) and in the transcript. The chip does not imply the file
 * still exists: it is only a path.
 */
export function WindowsFileChip(props: {
  readonly file: Pick<ChatWindowsFileAttachment, "id" | "name" | "host" | "path">;
  readonly onRemove?: () => void;
}) {
  const { file, onRemove } = props;
  return (
    <div
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-muted/40 py-0.5 ps-2 pe-1 text-sm"
      data-windows-file-chip={file.id}
    >
      <MonitorIcon className="size-3.5 shrink-0 text-secondary-label" />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate" tabIndex={0} aria-label={file.path} />}
        >
          {file.name}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-96 break-all">
          {file.path}
        </TooltipPopup>
      </Tooltip>
      <span className="shrink-0 text-xs text-secondary-label">on {file.host}</span>
      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onRemove}
          aria-label={`Remove ${file.name}`}
        >
          <XIcon />
        </Button>
      ) : (
        <span className="w-1" />
      )}
    </div>
  );
}
