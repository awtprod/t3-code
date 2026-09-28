import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { PlayIcon, TriangleAlertIcon } from "lucide-react";
import { memo, useState } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

const TILE_CLASS_NAME =
  "relative inline-flex aspect-video w-72 max-w-full overflow-hidden rounded-lg border border-border/70 bg-black align-top";

/**
 * A finished video clip in the transcript. It streams through a signed asset
 * URL (byte ranges, so only metadata and the poster frame load up front) and
 * opens the shared media dialog player on click. Without an expand handler,
 * such as inside a link, it falls back to inline controls.
 */
export const ChatVideoClipTile = memo(function ChatVideoClipTile(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<AssetResource, { readonly _tag: "attachment" | "workspace-file" }>;
  readonly name: string;
  readonly copyMarkdown?: string | undefined;
  readonly onImageExpand?: ((preview: ExpandedImagePreview) => void) | undefined;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, props.resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (assetUrl._tag === "Failure" || (assetUrl._tag === "Success" && failedUrl === assetUrl.url)) {
    return (
      <span
        data-markdown-copy={props.copyMarkdown}
        className="inline-flex items-center gap-1.5 rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
      >
        <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
        Video unavailable · {props.name}
      </span>
    );
  }
  if (assetUrl._tag !== "Success") {
    return (
      <span
        data-markdown-copy={props.copyMarkdown}
        role="status"
        aria-label={`Loading ${props.name}`}
        className={cn(TILE_CLASS_NAME, "bg-muted/60")}
      />
    );
  }

  const { onImageExpand } = props;
  const src = assetUrl.url;
  if (!onImageExpand) {
    return (
      <video
        src={src}
        aria-label={props.name}
        data-markdown-copy={props.copyMarkdown}
        controls
        playsInline
        preload="metadata"
        onError={() => setFailedUrl(src)}
        className={cn(TILE_CLASS_NAME, "object-contain")}
      />
    );
  }
  return (
    <button
      type="button"
      data-markdown-copy={props.copyMarkdown}
      aria-label={`Play ${props.name}`}
      className={cn(
        TILE_CLASS_NAME,
        "group cursor-zoom-in text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
      )}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onImageExpand({ images: [{ src, name: props.name, type: "video" }], index: 0 });
      }}
    >
      {/* The first frame doubles as the poster; #t nudges past black leaders. */}
      <video
        src={`${src}#t=0.1`}
        aria-hidden
        tabIndex={-1}
        muted
        playsInline
        preload="metadata"
        onError={() => setFailedUrl(src)}
        className="pointer-events-none absolute inset-0 size-full object-contain"
      />
      <span className="absolute inset-0 flex items-center justify-center bg-black/25 transition-colors group-hover:bg-black/40">
        <span className="flex size-11 items-center justify-center rounded-full bg-black/60">
          <PlayIcon aria-hidden className="ms-0.5 size-5 fill-current" />
        </span>
      </span>
      <span className="absolute inset-x-0 bottom-0 truncate bg-linear-to-t from-black/70 to-transparent px-2 pt-4 pb-1 text-start text-[11px]">
        {props.name}
      </span>
    </button>
  );
});
