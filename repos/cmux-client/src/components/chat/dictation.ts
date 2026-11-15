/**
 * Voice dictation through the browser's Web Speech API. Orca dictates with a downloaded on-device speech
 * model (ref/orca/mobile/src/dictation); a web app can only use what the browser offers, so the button is
 * hidden where `SpeechRecognition` / `webkitSpeechRecognition` does not exist. Audio handling and
 * privacy are the browser vendor's (Chrome sends audio to Google; Safari uses Apple's service).
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  const g = globalThis as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

export function canDictate(): boolean {
  return recognitionCtor() !== null;
}

/** Joins the existing draft and a spoken fragment with exactly one space. */
export function appendDictation(base: string, spoken: string): string {
  const s = spoken.trim();
  if (!s) return base;
  if (!base.trim()) return s;
  return `${base.replace(/\s+$/, "")} ${s}`;
}

/**
 * `onText(finalFragment)` fires once per finalized phrase; the caller appends it to the draft.
 * `error` is a short human message for permission/network failures.
 */
export function useDictation(onText: (fragment: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<RecognitionLike | null>(null);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor || recRef.current) return;
    setError(null);
    const rec = new Ctor();
    rec.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const r = e.results[i];
        if (r.isFinal) onTextRef.current(r[0].transcript);
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError("Microphone access was denied.");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        setError(`Dictation failed (${e.error}).`);
      }
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      recRef.current = null;
      setError("Could not start dictation.");
    }
  }, []);

  useEffect(
    () => () => {
      recRef.current?.stop();
    },
    [],
  );

  return { listening, error, start, stop };
}
