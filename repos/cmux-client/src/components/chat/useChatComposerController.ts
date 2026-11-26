import { useEffect, useMemo, useRef, useState } from "react";
import type { ComposerImageAttachment } from "../../domain/chat/composerStore";
import type { QueuedMessage } from "../../domain/chat/types";
import type { AgentLifecycleState } from "../../protocol/event";
import { useComposerState } from "../../state/useComposerState";
import { DRAIN_SETTLE_MS, canDrain, enqueue, removeQueued } from "./chatQueue";
import {
  MAX_IMAGES_PER_MESSAGE,
  PartialSendError,
  prepareImageForUpload,
  type PreparedImage,
} from "./imageAttach";
import { suggestSlashCommands } from "./slashCommands";

interface BuiltImage extends ComposerImageAttachment {
  dataUrl?: string;
}

function safeRevokeUrl(url: string | undefined): void {
  if (!url || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Ignore synthetic test URLs
  }
}

export function useChatComposerController({
  agentKind,
  surfaceId,
  isWorking,
  lifecycleState,
  needsAnswer,
  onSetSendError,
  onSend,
  onUploadImage,
  onScrollToTail,
  onSubmittingChange,
}: {
  agentKind: string;
  surfaceId?: string;
  isWorking: boolean;
  lifecycleState: AgentLifecycleState;
  needsAnswer: boolean;
  onSetSendError: (msg: string | null) => void;
  onSend: (text: string, imagePaths?: string[], imagePreviews?: string[]) => Promise<void>;
  onUploadImage?: (base64: string) => Promise<string>;
  onScrollToTail: () => void;
  onSubmittingChange: (submitting: boolean) => void;
}) {
  const [persisted, updatePersisted] = useComposerState(surfaceId);
  const { draftText: inputText, images, queue, queuePaused } = persisted;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [activeSlashIdx, setActiveSlashIdx] = useState(0);

  const queueRef = useRef(queue);
  const drainingRef = useRef(false);
  const deliveredRef = useRef(0);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const setInputText = (next: string | ((prev: string) => string)) => {
    updatePersisted((prev) => ({
      ...prev,
      draftText: typeof next === "function" ? next(prev.draftText) : next,
    }));
  };

  const updateSubmitting = (next: boolean) => {
    setIsSubmitting(next);
    onSubmittingChange(next);
  };

  const sendNow = async (
    text: string,
    imagePaths: string[] = [],
    imagePreviews?: string[],
  ): Promise<boolean> => {
    deliveredRef.current = 0;
    onSetSendError(null);
    updateSubmitting(true);
    try {
      await onSend(text, imagePaths, imagePreviews);
      onScrollToTail();
      return true;
    } catch (err) {
      console.warn("Send failed:", err);
      if (err instanceof PartialSendError) deliveredRef.current = err.delivered;
      onSetSendError(err instanceof Error ? err.message : "Could not send the message.");
      return false;
    } finally {
      updateSubmitting(false);
    }
  };

  const handlePickImages = async (files: FileList | File[] | null, resetFileInput?: () => void) => {
    if (!files || !onUploadImage) return;
    const room = MAX_IMAGES_PER_MESSAGE - images.length - uploading;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > picked.length) {
      onSetSendError(`You can attach up to ${MAX_IMAGES_PER_MESSAGE} images.`);
    }
    for (const file of picked) {
      setUploading((n) => n + 1);
      let prepared: PreparedImage | null = null;
      try {
        prepared = await prepareImageForUpload(file);
        const path = await onUploadImage(prepared.base64);
        const attached: BuiltImage = {
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          path,
          previewUrl: prepared.previewUrl,
          dataUrl: prepared.dataUrl,
        };
        updatePersisted((prev) => ({
          ...prev,
          images: [...prev.images, attached],
        }));
      } catch (err) {
        if (prepared) safeRevokeUrl(prepared.previewUrl);
        onSetSendError(err instanceof Error ? err.message : "Could not upload the image.");
      } finally {
        setUploading((n) => n - 1);
      }
    }
    resetFileInput?.();
  };

  const removeImage = (id: string) => {
    updatePersisted((prev) => {
      const gone = prev.images.find((i) => i.id === id);
      if (gone) safeRevokeUrl(gone.previewUrl);
      return { ...prev, images: prev.images.filter((i) => i.id !== id) };
    });
  };

  const handleSendPrompt = async () => {
    const hasContent = inputText.trim().length > 0 || images.length > 0;
    if (!hasContent || isSubmitting || uploading > 0) return;
    const text = inputText.trim();
    const sent = images as BuiltImage[];
    const paths = sent.map((i) => i.path);
    const previews = sent.map((i) => i.dataUrl ?? i.previewUrl);

    updatePersisted((prev) => ({ ...prev, draftText: "", images: [] }));

    if (isWorking || lifecycleState === "waiting" || needsAnswer) {
      updatePersisted((prev) => ({
        ...prev,
        queue: enqueue(
          prev.queue,
          text,
          `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          paths,
        ),
      }));
      sent.forEach((i) => safeRevokeUrl(i.previewUrl));
      return;
    }

    if (await sendNow(text, paths, previews.length > 0 ? previews : undefined)) {
      sent.forEach((i) => safeRevokeUrl(i.previewUrl));
      return;
    }

    sent.slice(0, deliveredRef.current).forEach((i) => safeRevokeUrl(i.previewUrl));
    const remaining = sent.slice(deliveredRef.current);
    updatePersisted((prev) => {
      const mergedImages = [...remaining, ...prev.images];
      for (let idx = MAX_IMAGES_PER_MESSAGE; idx < mergedImages.length; idx += 1) {
        safeRevokeUrl(mergedImages[idx].previewUrl);
      }
      return {
        ...prev,
        draftText: prev.draftText && prev.draftText !== text ? `${text}\n${prev.draftText}` : text,
        images: mergedImages.slice(0, MAX_IMAGES_PER_MESSAGE),
      };
    });
  };

  const handleSendQueuedNow = async (item: QueuedMessage) => {
    if (drainingRef.current || isSubmitting) return;
    drainingRef.current = true;
    updatePersisted((prev) => ({ ...prev, queue: removeQueued(prev.queue, item.id) }));
    try {
      const ok = await sendNow(item.text, item.images);
      if (ok) {
        updatePersisted((prev) => (prev.queuePaused ? { ...prev, queuePaused: false } : prev));
      } else {
        updatePersisted((prev) => ({
          ...prev,
          queue: [{ ...item, images: item.images.slice(deliveredRef.current) }, ...prev.queue],
          queuePaused: true,
        }));
      }
    } finally {
      drainingRef.current = false;
    }
  };

  useEffect(() => {
    if (queuePaused) return;
    if (
      !canDrain({
        queueLength: queue.length,
        isWorking,
        isSubmitting,
        lifecycle: lifecycleState,
        needsAnswer,
      })
    ) {
      return;
    }
    const timer = setTimeout(async () => {
      const head = queueRef.current[0];
      if (!head || drainingRef.current) return;
      drainingRef.current = true;
      updatePersisted((prev) => ({ ...prev, queue: removeQueued(prev.queue, head.id) }));
      const ok = await sendNow(head.text, head.images);
      if (!ok) {
        updatePersisted((prev) => ({
          ...prev,
          queue: [{ ...head, images: head.images.slice(deliveredRef.current) }, ...prev.queue],
          queuePaused: true,
        }));
      }
      drainingRef.current = false;
    }, DRAIN_SETTLE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, queuePaused, isWorking, isSubmitting, lifecycleState, needsAnswer]);

  const slashSuggestions = useMemo(
    () => suggestSlashCommands(agentKind, inputText),
    [agentKind, inputText],
  );

  useEffect(() => {
    setSlashDismissed(false);
    setActiveSlashIdx(0);
  }, [inputText, agentKind]);

  return {
    inputText,
    images,
    queue,
    queuePaused,
    isSubmitting,
    uploading,
    visibleSlashSuggestions: slashDismissed ? [] : slashSuggestions,
    activeSlashIdx,
    setActiveSlashIdx,
    setSlashDismissed,
    setInputText,
    handlePickImages,
    removeImage,
    handleSendPrompt,
    handleSendQueuedNow,
    resumeQueue: () => updatePersisted((prev) => ({ ...prev, queuePaused: false })),
    removeQueuedItem: (id: string) =>
      updatePersisted((prev) => ({ ...prev, queue: removeQueued(prev.queue, id) })),
  };
}
