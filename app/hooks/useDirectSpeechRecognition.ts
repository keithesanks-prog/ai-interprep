"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Direct Speech Recognition using MediaRecorder API
 * This captures audio and sends it to our API for transcription
 * More reliable than Web Speech API in Electron
 */
export function useDirectSpeechRecognition(
  onTranscript: (transcript: string) => void,
  options: { language?: string } = {}
) {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const { language = "en-US" } = options;

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Stop all tracks
        stream.getTracks().forEach((track) => track.stop());

        // Create audio blob
        const audioBlob = new Blob(audioChunksRef.current, {
          type: "audio/webm;codecs=opus",
        });

        // Send to API for transcription
        try {
          const formData = new FormData();
          formData.append("audio", audioBlob, "recording.webm");
          formData.append("language", language);

          const response = await fetch("/api/speech-to-text", {
            method: "POST",
            body: formData,
          });

          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || "Transcription failed");
          }

          const data = await response.json();
          if (data.transcript) {
            onTranscript(data.transcript);
          }
        } catch (err: any) {
          console.error("Transcription error:", err);
          setError(err.message || "Failed to transcribe audio");
        }
      };

      // Start recording
      mediaRecorder.start();
      setIsRecording(true);
    } catch (err: any) {
      console.error("Failed to start recording:", err);
      setError(err.message || "Failed to access microphone");
      setIsRecording(false);
    }
  }, [language, onTranscript]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    
    // Stop stream if still active
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, [isRecording]);

  return {
    isRecording,
    error,
    startRecording,
    stopRecording,
  };
}

