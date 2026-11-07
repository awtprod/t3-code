import type { EnvironmentId } from "@t3tools/contracts";
import { MonitorIcon } from "lucide-react";
import { useState } from "react";

import type { ChatWindowsFileAttachment } from "~/types";
import { randomUUID } from "~/lib/utils";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WindowsFileChip } from "./WindowsFileChip";
import { WindowsMediaPickerDialog } from "./WindowsMediaPickerDialog";
import { windowsFileAttachmentFromEntry } from "./windowsMediaPicker.logic";

export function ComposerWindowsMediaButton({
  environmentId,
  onPick,
}: {
  readonly environmentId: EnvironmentId;
  readonly onPick: (file: ChatWindowsFileAttachment) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => setOpen(true)}
              aria-label="Browse Windows"
            />
          }
        >
          <MonitorIcon />
        </TooltipTrigger>
        <TooltipPopup>Browse Windows</TooltipPopup>
      </Tooltip>
      <WindowsMediaPickerDialog
        open={open}
        onOpenChange={setOpen}
        environmentId={environmentId}
        onPick={(entry, host) => {
          onPick(windowsFileAttachmentFromEntry({ id: randomUUID(), host, entry }));
        }}
      />
    </>
  );
}

export function ComposerWindowsFileList({
  files,
  onRemove,
}: {
  readonly files: ReadonlyArray<Pick<ChatWindowsFileAttachment, "id" | "name" | "host" | "path">>;
  readonly onRemove: (fileId: string) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {files.map((file) => (
        <WindowsFileChip key={file.id} file={file} onRemove={() => onRemove(file.id)} />
      ))}
    </div>
  );
}
