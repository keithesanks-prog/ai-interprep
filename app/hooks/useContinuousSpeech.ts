"use client";

import { useCallback, useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
    assistantBridge?: {
      submitTranscript: (value: string) => void;
      onToggle?: (cb: (shouldStart: boolean) => void) => void;
      requestStart?: () => void;
      requestStop?: () => void;
    };
  }
}

type ContinuousSpeechOptions = {
  language?: string;
  autoRestart?: boolean;
  startOnToggle?: boolean;
};

export function useContinuousSpeech(
  onFinalTranscript: (transcript: string) => Promise<void> | void,
  options: ContinuousSpeechOptions = {}
) {
  const { language = "en-US", autoRestart = true, startOnToggle = true } = options;
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const recognitionRef = useRef<any>(null);
  const callbackRef = useRef(onFinalTranscript);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isRetryingRef = useRef(false);
  const isListeningRef = useRef(false);

  callbackRef.current = onFinalTranscript;

  const createRecognition = useCallback(() => {
    if (typeof window === "undefined") return null;
    const RecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!RecognitionCtor) return null;

    const recognition = new RecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language;
    return recognition;
  }, [language]);

  useEffect(() => {
    const recognition = createRecognition();
    if (!recognition) {
      setIsSupported(false);
      return;
    }

    setIsSupported(true);
    recognitionRef.current = recognition;

    let finalTranscript = "";

    recognition.onresult = async (event: any) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          transcript += text;
        }
      }

      finalTranscript = transcript.trim();
      if (finalTranscript) {
        try {
          await callbackRef.current(finalTranscript);
          window.assistantBridge?.submitTranscript?.(finalTranscript);
        } catch (err) {
          console.error("Continuous speech callback failed", err);
        }
      }
    };

    recognition.onerror = (event: any) => {
      const errorType = event.error || "unknown";
      
      // Handle permission errors - stop listening
      if (errorType === "not-allowed" || errorType === "service-not-allowed") {
        setIsListening(false);
        retryCountRef.current = 0;
        isRetryingRef.current = false;
        return;
      }
      
      // Handle network errors with exponential backoff retry
      if (errorType === "network") {
        // Clear any pending retry
        if (retryTimeoutRef.current) {
          clearTimeout(retryTimeoutRef.current);
          retryTimeoutRef.current = null;
        }
        
        // Only log first few errors, then suppress to avoid spam
        if (retryCountRef.current < 3) {
          console.warn(`Speech recognition network error (attempt ${retryCountRef.current + 1}), retrying...`);
        }
        
        // Stop current recognition
        try {
          recognition.stop();
        } catch (err) {
          // ignore stop errors
        }
        
        if (autoRestart && isListeningRef.current) {
          isRetryingRef.current = true;
          retryCountRef.current += 1;
          
          // Exponential backoff: 1s, 2s, 4s, 8s, then cap at 8s
          const delay = Math.min(1000 * Math.pow(2, retryCountRef.current - 1), 8000);
          
          retryTimeoutRef.current = setTimeout(() => {
            retryTimeoutRef.current = null;
            
            // Only retry if still supposed to be listening (check ref to avoid stale closure)
            if (isListeningRef.current && recognitionRef.current) {
              try {
                recognitionRef.current.start();
                // Reset retry count on successful restart
                retryCountRef.current = 0;
                isRetryingRef.current = false;
              } catch (err) {
                console.error("Failed to restart recognition after network error", err);
                // Will retry again on next network error
              }
            } else {
              isRetryingRef.current = false;
            }
          }, delay);
        } else {
          isRetryingRef.current = false;
        }
        return;
      }
      
      // For other errors, log but don't auto-retry
      if (errorType !== "no-speech" && errorType !== "aborted") {
        console.error("Speech recognition error", errorType);
      }
    };

    recognition.onend = () => {
      // Reset retry count on successful end (normal operation)
      if (!isRetryingRef.current) {
        retryCountRef.current = 0;
      }
      
      if (autoRestart && isListeningRef.current && !isRetryingRef.current) {
        try {
          recognition.start();
        } catch (err) {
          // ignore start errors
        }
      }
    };

    if (isListening) {
      isListeningRef.current = true;
      recognition.start();
    } else {
      isListeningRef.current = false;
    }

    return () => {
      // Clear any pending retry
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch (err) {
        // ignore stop errors
      }
      
      // Reset retry state
      retryCountRef.current = 0;
      isRetryingRef.current = false;
    };
  }, [autoRestart, createRecognition, isListening]);

  useEffect(() => {
    if (!startOnToggle) return;
    const bridge = window?.assistantBridge;
    if (!bridge?.onToggle) return;
    bridge.onToggle((shouldStart) => {
      const shouldListen = Boolean(shouldStart);
      setIsListening(shouldListen);
      isListeningRef.current = shouldListen;
    });
  }, [startOnToggle]);

  const start = useCallback(() => {
    setIsListening(true);
    isListeningRef.current = true;
    window.assistantBridge?.requestStart?.();
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.start();
      } catch (err) {
        // swallow start errors (often because it's already running)
      }
    }
  }, []);

  const stop = useCallback(() => {
    setIsListening(false);
    isListeningRef.current = false;
    // Clear any pending retries
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    retryCountRef.current = 0;
    isRetryingRef.current = false;
    window.assistantBridge?.requestStop?.();
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch (err) {
        // ignore
      }
    }
  }, []);

  return { isListening, isSupported, start, stop } as const;
}
