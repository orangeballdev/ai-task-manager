import { useRef, useState, useSyncExternalStore } from "react";

interface SpeechRecognitionInstance {
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: { [i: number]: { [i: number]: { transcript: string } } } }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Speech recognition support never changes while the page is open.
const subscribeToNothing = () => () => {};

export function useSpeechDictation(onTranscript: (text: string) => void) {
  const [isRecording, setIsRecording] = useState(false);
  // false during SSR/hydration, then whatever the browser actually offers.
  const isSupported = useSyncExternalStore(subscribeToNothing, () => !!getSpeechRecognition(), () => false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);

  const toggleRecording = () => {
    const SR = getSpeechRecognition();
    if (!SR) return;

    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }

    const recognition = new SR();
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      if (transcript) onTranscript(transcript);
    };

    recognition.onend = () => setIsRecording(false);
    recognition.onerror = () => setIsRecording(false);

    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
  };

  return { isRecording, isSupported, toggleRecording };
}
