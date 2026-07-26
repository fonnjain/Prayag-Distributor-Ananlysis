import { useState, useRef, useCallback } from "react";

// Minimal typed surface for the Web Speech API (not in standard lib.dom.d.ts).
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionResultList {
  [index: number]: SpeechRecognitionResult;
  length: number;
}
interface SpeechRecognitionResult {
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}
interface SpeechRecognitionAlternative {
  transcript: string;
}
interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: Event) => void) | null;
  onend: (() => void) | null;
}
declare const SpeechRecognition: { new (): SpeechRecognitionInstance } | undefined;
declare const webkitSpeechRecognition: { new (): SpeechRecognitionInstance } | undefined;

function getSpeechRecognition(): (new () => SpeechRecognitionInstance) | null {
  if (typeof window === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const W = window as any;
  return W.SpeechRecognition ?? W.webkitSpeechRecognition ?? null;
}

export type VoiceInputState = "idle" | "listening" | "unsupported";

export function useVoiceInput(onTranscript: (text: string) => void) {
  const [state, setState] = useState<VoiceInputState>(
    getSpeechRecognition() ? "idle" : "unsupported",
  );
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;

    // If already listening, stop.
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
      setState("idle");
      return;
    }

    const rec = new Ctor();
    rec.lang = "en-IN";
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript ?? "";
      if (transcript) onTranscript(transcript);
    };

    rec.onerror = () => {
      setState("idle");
      recognitionRef.current = null;
    };

    rec.onend = () => {
      setState("idle");
      recognitionRef.current = null;
    };

    recognitionRef.current = rec;
    rec.start();
    setState("listening");
  }, [onTranscript]);

  return { state, start };
}
