"use client";

import { Download } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

/** Fetch the media (blob URLs resolve locally, proxy URLs re-fetch
 *  with the session cookie) and trigger a browser download. */
async function downloadMedia(src: string, kind: "image" | "video") {
  try {
    const res = await fetch(src);
    const blob = await res.blob();
    const ext =
      blob.type.split("/")[1]?.split(";")[0] || (kind === "image" ? "jpg" : "mp4");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${kind === "image" ? "imagem" : "video"}-${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch {
    // Non-essential — a failed download shouldn't throw UI errors.
  }
}

interface MediaLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "image" | "video";
  src: string;
  alt?: string;
}

/**
 * Fullscreen viewer for a chat photo/video. Reuses the shadcn Dialog
 * primitive (Esc/backdrop-click close for free) instead of a bespoke
 * modal — this is the only lightbox in the app, no need for a new lib.
 */
export function MediaLightbox({ open, onOpenChange, kind, src, alt }: MediaLightboxProps) {
  const t = useTranslations("Inbox.messageThread");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex max-h-[90vh] w-auto max-w-[90vw] items-center justify-center border-none bg-transparent p-0 shadow-none"
      >
        {/* Visually hidden — DialogContent requires a title for a11y,
            but a lightbox has no natural heading to show. */}
        <DialogTitle className="sr-only">{t("mediaLightboxTitle")}</DialogTitle>
        <Button
          variant="secondary"
          size="icon-sm"
          className="absolute top-2 left-2 z-10"
          title={t("downloadMedia")}
          onClick={() => void downloadMedia(src, kind)}
        >
          <Download className="h-4 w-4" />
          <span className="sr-only">{t("downloadMedia")}</span>
        </Button>
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- already-fetched blob/remote URL, no next/image benefit here
          <img
            src={src}
            alt={alt || ""}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
          />
        ) : (
          <video
            src={src}
            controls
            autoPlay
            className="max-h-[90vh] max-w-[90vw] rounded-lg"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
