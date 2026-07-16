"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useTranslations } from "next-intl";

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
