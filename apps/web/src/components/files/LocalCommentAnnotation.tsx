import { MessageCircle, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

interface LocalCommentAnnotationProps {
  kind: "draft" | "comment";
  rangeLabel: string;
  text: string;
  onTextChange?: (text: string) => void;
  onCancel: () => void;
  onComment: (text: string) => void;
  onDelete: () => void;
}

export function LocalCommentAnnotation({
  kind,
  rangeLabel,
  text,
  onTextChange,
  onCancel,
  onComment,
  onDelete,
}: LocalCommentAnnotationProps) {
  const [localDraftText, setLocalDraftText] = useState("");
  const displayedText = kind === "draft" && !onTextChange ? localDraftText : text;

  if (kind === "comment") {
    return (
      <div
        data-file-comment-annotation
        className="group/comment flex min-w-0 items-start gap-2.5 border-s-2 border-primary/55 bg-primary/[0.045] px-3 py-2.5 font-sans text-foreground"
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <MessageCircle className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden="true" />
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-5">{displayedText}</p>
        <span className="-my-1 -mr-1 flex shrink-0 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Delete comment"
            onClick={onDelete}
          >
            <Trash2 className="size-3" />
          </Button>
        </span>
      </div>
    );
  }

  return (
    <div
      data-file-comment-annotation
      className="px-3 py-2 font-sans text-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* The draft composer keeps its own quiet look: an unstyled Textarea inside a plain frame. */}
      <div className="relative flex w-full flex-col rounded-md border border-border/50 bg-background/20 font-sans text-foreground transition-colors focus-within:border-border/70 [&_[data-slot=textarea]]:min-h-12 [&_[data-slot=textarea]]:cursor-text [&_[data-slot=textarea]]:px-2.5 [&_[data-slot=textarea]]:py-1.5 [&_[data-slot=textarea]]:font-sans [&_[data-slot=textarea]]:text-xs [&_[data-slot=textarea]]:leading-5 max-sm:[&_[data-slot=textarea]]:min-h-12">
        <Textarea
          autoFocus
          unstyled
          size="sm"
          value={displayedText}
          placeholder="Add a comment…"
          aria-label={`Comment on lines ${rangeLabel}`}
          onChange={(event) => (onTextChange ?? setLocalDraftText)(event.target.value)}
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && displayedText.trim()) {
              event.preventDefault();
              onComment(displayedText.trim());
            }
          }}
        />
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <span className="mr-auto text-3xs text-muted-foreground/70">⌘/Ctrl Enter to send</span>
        <Button variant="ghost-muted" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={!displayedText.trim()}
          onClick={() => onComment(displayedText.trim())}
        >
          Comment
        </Button>
      </div>
    </div>
  );
}
