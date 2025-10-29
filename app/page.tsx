"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";

type Status = string;

// --- Text Generation (calls /api/generate) ---
async function generateText(prompt: string): Promise<string> {
  const response = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("API route error:", error);
    throw new Error(`Server error: ${error}`);
  }

  const result = await response.json();
  const text =
    result.candidates?.[0]?.content?.parts?.[0]?.text ||
    "Sorry, I couldn't generate a response.";
  return text.trim();
}

// --- Scrolling Text Display ---
interface ScrollingTextDisplayProps {
  fullText: string;
  readingSpeed?: number; // Base characters per second
}


const ScrollingTextDisplay: React.FC<ScrollingTextDisplayProps> = ({
  fullText,
  readingSpeed = 12, // Base: ~12 characters per second (adjustable)
}) => {
  const textRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (!fullText || !textRef.current || !containerRef.current) {
      setIsAnimating(false);
      return;
    }

    setIsAnimating(true);

    // Measure text and container
    const textWidth = textRef.current.scrollWidth;
    const containerWidth = containerRef.current.clientWidth;
    const startPosition = containerWidth;
    const endPosition = -textWidth;
    const totalDistance = textWidth + containerWidth;

    // Calculate total duration based on reading speed
    // readingSpeed is characters per second, convert to pixels per second
    // Approximate: 1 character ≈ 18-20 pixels at text-3xl size
    const pixelsPerCharacter = 18;
    const totalCharacters = fullText.length;
    const basePixelsPerSecond = readingSpeed * pixelsPerCharacter;
    
    // Adjust for content - analyze text for complexity
    let speedMultiplier = 1.0;
    const hasLongWords = /\w{8,}/.test(fullText);
    const punctuationCount = (fullText.match(/[.,!?;:]/g) || []).length;
    if (hasLongWords) speedMultiplier *= 0.9;
    if (punctuationCount > totalCharacters * 0.05) speedMultiplier *= 0.95;
    
    const adjustedPixelsPerSecond = basePixelsPerSecond * speedMultiplier;
    const totalDuration = totalDistance / adjustedPixelsPerSecond;

    // Simple linear animation from right to left
    const startTime = performance.now();
    
    const animate = (timestamp: number) => {
      const elapsed = (timestamp - startTime) / 1000;
      
      if (elapsed >= totalDuration) {
        // Animation complete
        if (textRef.current) {
          textRef.current.style.transform = `translateX(${endPosition}px)`;
        }
        setIsAnimating(false);
        return;
      }
      
      // Calculate current position (linear interpolation)
      const progress = Math.min(elapsed / totalDuration, 1);
      const currentX = startPosition + (endPosition - startPosition) * progress;
      
      if (textRef.current) {
        textRef.current.style.transform = `translateX(${currentX}px)`;
      }
      
      animationRef.current = requestAnimationFrame(animate);
    };

    // Reset position to start
    if (textRef.current) {
      textRef.current.style.transform = `translateX(${startPosition}px)`;
    }

    // Start animation
    const initialTimestamp = performance.now();
    animate(initialTimestamp);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      setIsAnimating(false);
    };
  }, [fullText, readingSpeed]);

  return (
    <div 
      ref={containerRef}
      className="h-48 w-full bg-gray-900 border-4 border-emerald-500 p-6 shadow-2xl rounded-xl overflow-hidden relative"
    >
      <div className="h-full overflow-hidden whitespace-nowrap relative">
        {fullText ? (
          <div
            ref={textRef}
            className="text-3xl font-bold text-emerald-300 inline-block"
            style={{
              transform: `translateX(100%)`,
              willChange: 'transform',
            }}
          >
            {fullText}
          </div>
        ) : (
          <p className="text-3xl font-bold text-emerald-300">
            Ask a question to begin...
          </p>
        )}
      </div>
    </div>
  );
};

// --- Main Component ---
const App: React.FC = () => {
  const [status, setStatus] = useState<Status>(
    "Ready: Press the mic button to start speaking."
  );
  const [question, setQuestion] = useState("");
  const [fullResponse, setFullResponse] = useState("");
  const [hasMounted, setHasMounted] = useState(false);
  const [readingSpeed, setReadingSpeed] = useState(12); // Characters per second

  const SpeechRecognition =
    typeof window !== "undefined"
      ? (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition
      : null;
  const isSpeechSupported = !!SpeechRecognition;

  useEffect(() => setHasMounted(true), []);

  const handleQuery = useCallback(async (query: string) => {
    if (!query) {
      setStatus("Query is empty. Cannot proceed.");
      return;
    }

    setStatus("Generating response...");
    setFullResponse("");

    try {
      const generatedText = await generateText(query);

      if (
        !generatedText ||
        generatedText.trim().length === 0 ||
        generatedText.includes("could not generate a response")
      ) {
        setStatus(
          "Failed: Assistant returned an empty or blocked response. Try asking a different question."
        );
        setFullResponse(
          "The assistant could not generate a response for that query, possibly due to a safety policy violation. Please try a different question."
        );
        return;
      }

      setFullResponse(generatedText);
      setStatus("Response ready. Scrolling text...");
    } catch (error: any) {
      console.error("Query process failed:", error);
      setFullResponse("A network or API error occurred. Check the console.");
      setStatus("Failed: API communication failed. See console.");
    }
  }, []);

  const startListening = useCallback(() => {
    if (!isSpeechSupported) {
      setStatus("Error: Speech Recognition not supported.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    setQuestion("");
    setFullResponse("");

    recognition.onstart = () => setStatus("Listening... Speak clearly now.");
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setQuestion(transcript);
      setStatus("Heard: " + transcript);
      recognition.stop();
      handleQuery(transcript);
    };
    recognition.onerror = (event: any) =>
      setStatus("Speech Error: " + event.error);
    recognition.onend = () => {
      if (status.startsWith("Listening..."))
        setStatus("No speech detected. Try again.");
    };

    recognition.start();
  }, [isSpeechSupported, status, handleQuery]);

  return (
    <div className="min-h-screen bg-gray-800 text-white p-4 sm:p-8 flex items-center justify-center font-sans">
      <div className="w-full max-w-2xl bg-gray-700 p-6 sm:p-8 rounded-2xl shadow-xl space-y-8">
        <h1 className="text-3xl sm:text-4xl font-bold text-center text-emerald-400">
          AI Interview Assistant
        </h1>

        <div className="flex flex-col items-center">
          <div className="w-full flex items-center justify-between mb-2">
            <h2 className="text-xl font-semibold text-gray-300">
              Scrolling Output
            </h2>
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-400">
                Speed: {readingSpeed}
              </label>
              <input
                type="range"
                min="5"
                max="30"
                step="1"
                value={readingSpeed}
                onChange={(e) => setReadingSpeed(Number(e.target.value))}
                className="w-32 accent-emerald-500 cursor-pointer"
                aria-label="Reading speed control"
              />
              <span className="text-xs text-gray-500">
                {readingSpeed < 10 ? "Slow" : readingSpeed < 20 ? "Medium" : "Fast"}
              </span>
            </div>
          </div>
          <ScrollingTextDisplay fullText={fullResponse} readingSpeed={readingSpeed} />
        </div>

        <div className="space-y-4">
          <div className="bg-gray-600 p-3 rounded-lg shadow-inner">
            <p className="text-sm font-medium text-gray-300">Current Status:</p>
            <p
              className={`font-mono text-base ${
                status.startsWith("Error") || status.includes("Failed")
                  ? "text-red-400"
                  : status.startsWith("Ready") || status.startsWith("Heard")
                  ? "text-green-400"
                  : "text-yellow-400"
              }`}
            >
              {status}
            </p>
          </div>

          <div className="bg-gray-600 p-3 rounded-lg shadow-inner h-20 overflow-y-auto">
            <p className="text-sm font-medium text-gray-300">Your Question:</p>
            <p className="text-lg text-white italic">
              {question ||
                (hasMounted
                  ? isSpeechSupported
                    ? "Start by pressing the microphone button..."
                    : "Speech Recognition not available."
                  : "")}
            </p>
          </div>
        </div>

        <div className="flex justify-center pt-4">
          <button
            onClick={startListening}
            disabled={
              !hasMounted ||
              !isSpeechSupported ||
              status.includes("Listening") ||
              status.includes("Generating")
            }
            className={`p-5 rounded-full shadow-lg transition duration-200 ease-in-out flex items-center space-x-2 text-xl font-bold ${
              !hasMounted ||
              !isSpeechSupported ||
              status.includes("Listening") ||
              status.includes("Generating")
                ? "bg-gray-500 cursor-not-allowed"
                : "bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 transform hover:scale-105"
            }`}
            aria-label="Start listening for question"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-8 w-8"
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4z"
                clipRule="evenodd"
              />
              <path
                fillRule="evenodd"
                d="M4 10a4 4 0 004 4v2a2 2 0 004 0v-2a4 4 0 004-4 1 1 0 11-2 0 2 2 0 01-2 2v1a.5.5 0 01-1 0v-1a2 2 0 01-2-2 1 1 0 11-2 0zM10 18a2 2 0 002-2v-1a2 2 0 00-2 2z"
                clipRule="evenodd"
              />
            </svg>
            <span>
              {status.includes("Listening")
                ? "Listening..."
                : status.includes("Generating")
                ? "Thinking..."
                : "Ask Question"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;
