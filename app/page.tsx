"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";

type Status = string;

// Conversation recording types
type ConversationRole = "user" | "assistant" | "system" | "clarifying" | "meta";
interface ConversationEvent {
  id: string;
  role: ConversationRole;
  content: string;
  timestamp: number; // epoch ms
  metadata?: Record<string, any>;
}

// Profile types
interface TechnicalQA {
  id: string;
  question: string;
  answer: string;
}

interface CompanyProfile {
  id: string;
  name: string;
  aboutCompany: string;
  jobDescription: string;
  technicalInfo: string;
  technicalQAs: TechnicalQA[];
  updatedAt: number;
}
const PROFILES_STORAGE_KEY = 'aiInterviewProfiles';

// --- Text Generation (calls /api/generate) ---
async function generateText(prompt: string, technicalQAs?: Array<{ question: string; answer: string }>, interviewMode?: "qa" | "procedural", interviewRound?: number, profileId?: string): Promise<string> {
  const response = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, technicalQAs: technicalQAs || [], interviewMode: interviewMode || "qa", interviewRound: interviewRound || 1, profileId: profileId || "" }),
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

// --- Parse procedural steps from text ---
function parseProceduralSteps(text: string): string[] {
  const steps: string[] = [];
  
  // Try to match numbered steps (Step 1:, Step 2:, etc. or 1., 2., etc.)
  const stepPatterns = [
    /Step\s+(\d+)[:\.]\s*([\s\S]+?)(?=Step\s+\d+[:\.]|$)/gi,
    /^(\d+)[:\.]\s*([\s\S]+?)(?=^\d+[:\.]|$)/gim,
  ];
  
  for (const pattern of stepPatterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) {
      matches.forEach(match => {
        const stepText = match[2]?.trim() || match[0]?.trim();
        if (stepText && stepText.length > 10) {
          steps.push(stepText);
        }
      });
      if (steps.length > 0) break;
    }
  }
  
  // If no numbered steps found, try to split by newlines and find logical breaks
  if (steps.length === 0) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let currentStep = "";
    for (const line of lines) {
      if (line.match(/^(first|second|third|fourth|fifth|next|then|finally|step|goal|objective)/i)) {
        if (currentStep) steps.push(currentStep);
        currentStep = line;
      } else if (currentStep && line.length > 20) {
        currentStep += " " + line;
      } else if (line.length > 50) {
        if (currentStep) steps.push(currentStep);
        currentStep = line;
      }
    }
    if (currentStep) steps.push(currentStep);
  }
  
  return steps.length > 0 ? steps : [text]; // Fallback to full text if no steps found
}

// --- Extract code blocks from text ---
function extractCodeBlocks(text: string): { cleanText: string; codeBlocks: string[] } {
  // Patterns for phrases that introduce commands/queries
  const introPhrases = [
    'For a command to do that, I would use',
    'Here\'s a query that would work',
    'The command I\'d use is',
    'The query I would use',
    'The command I would use',
    'The query I created was',
    'The command I used was',
    'Here is the query',
    'Here is the command',
    'The command was',
    'The SPL query was'
  ];
  
  // Pattern to match code blocks with optional preamble before them
  // Captures up to 200 chars before a code block that might contain intro phrases or (pause)
  const blockPattern = /([\s\S]{0,200}?)(```[\s\S]*?```)/gi;
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks: string[] = [];
  let cleanText = text;

  // Find blocks with optional preambles
  cleanText = cleanText.replace(blockPattern, (match, preamble, codeBlock) => {
    // Extract the code (removing triple backticks etc)
    const cleanBlock = codeBlock
      .replace(/^```[a-zA-Z]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    codeBlocks.push(cleanBlock);
    
    // Check if preamble contains intro phrase or (pause)
    const hasIntro = preamble && introPhrases.some(phrase => 
      preamble.toLowerCase().includes(phrase.toLowerCase())
    );
    const hasPause = preamble && /\(pause\)/i.test(preamble);
    
    // If there was a preamble, preserve it with (pause) if not already present
    if (preamble && (hasIntro || preamble.trim().length > 0)) {
      const trimmedPreamble = preamble.trim();
      if (hasPause) {
        return trimmedPreamble;
      } else {
        return `${trimmedPreamble} (pause)`;
      }
    }
    // If no preamble but code block exists, add (pause) marker
    return "(pause)";
  });

  // Remove any leftover code blocks standing alone (without preambles)
  cleanText = cleanText.replace(codeBlockRegex, "").trim();

  // Clean up extra whitespace/newlines
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, codeBlocks };
}

// --- Scrolling Text Display ---
interface ScrollingTextDisplayProps {
  fullText: string;
  readingSpeed?: number; // Base characters per second
  onScrollingStart?: () => void; // Callback when scrolling animation starts
}

const PAUSE_REGEX = /(\(pause\))/gi;

const ScrollingTextDisplay: React.FC<ScrollingTextDisplayProps> = ({
  fullText,
  readingSpeed = 12, // Base: ~12 characters per second (adjustable)
  onScrollingStart,
}) => {
  const textRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedElapsedRef = useRef<number>(0); // Track elapsed time when paused
  const isPausedRef = useRef<boolean>(false); // Use ref to check pause state in animation loop
  const [isPaused, setIsPaused] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const lastNotifiedTextRef = useRef<string>(""); // Track which text we've already notified for

  // Helper: render text with a highlighted (pause) marker
  const renderWithPauseMarker = (text: string) => {
    const parts = text.split(PAUSE_REGEX);
    return parts.map((part, idx) => {
      if (part.toLowerCase() === '(pause)') {
        return (
          <span
            key={idx}
            className="inline-flex items-center gap-2 px-2 py-1 rounded-xl font-bold bg-yellow-400 text-gray-900 mx-2 animate-pulse shadow border-2 border-yellow-600"
            style={{ fontSize: '1.25em', verticalAlign: 'middle' }}
          >
            <span aria-label="Pause" title="Pause here">⏸️ Pause and review the command</span>
          </span>
        );
      } else {
        return part;
      }
    });
  };

  useEffect(() => {
    // Clean up on unmount or when text changes
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    if (!fullText || !textRef.current || !containerRef.current) {
      setIsAnimating(false);
      setIsPaused(false);
      pausedElapsedRef.current = 0;
      return;
    }

    // Reset pause state when new text arrives
    setIsPaused(false);
    isPausedRef.current = false;
    pausedElapsedRef.current = 0;
    setIsAnimating(true);
    
    // Notify parent that scrolling has started (only once per unique text)
    if (onScrollingStart && fullText && fullText !== lastNotifiedTextRef.current) {
      lastNotifiedTextRef.current = fullText;
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        onScrollingStart();
      });
    }

    // Measure text and container
    const textWidth = textRef.current.scrollWidth;
    const containerWidth = containerRef.current.clientWidth;
    const startPosition = containerWidth;
    const endPosition = -textWidth;
    const totalDistance = textWidth + containerWidth;

    // Calculate context-aware speed curve based on punctuation and natural pauses
    const pixelsPerCharacter = 18;
    const totalCharacters = fullText.length;
    const basePixelsPerSecond = readingSpeed * pixelsPerCharacter;
    
    // Build a speed map: analyze text to find natural pause points
    const speedMap: number[] = [];
    const pausePoints: number[] = [];
    
    // Identify punctuation and natural breaks
    for (let i = 0; i < fullText.length; i++) {
      const char = fullText[i];
      const charPos = i / fullText.length; // Position as 0-1
      
      // Long pauses at sentence endings
      if (/[.!?]/.test(char)) {
        pausePoints.push(charPos);
        speedMap.push(0.3); // Very slow at sentence end
      }
      // Medium pauses at commas, semicolons
      else if (/[,;]/.test(char)) {
        pausePoints.push(charPos);
        speedMap.push(0.6); // Medium slow at clause breaks
      }
      // Short pauses at colons
      else if (/[:]/.test(char)) {
        pausePoints.push(charPos);
        speedMap.push(0.75); // Slight slow at colons
      }
      // Normal speed for regular text
      else {
        speedMap.push(1.0);
      }
    }
    
    // Smooth speed transitions around punctuation
    const smoothedSpeedMap = speedMap.map((speed, i) => {
      if (speed < 1.0) {
        // At punctuation, slow down
        return speed;
      } else {
        // Near punctuation, slightly slow down (smooth transition)
        const nearbyPause = pausePoints.find(p => {
          const pos = i / fullText.length;
          return Math.abs(p - pos) < 0.05; // Within 5% of text
        });
        if (nearbyPause) {
          const pos = i / fullText.length;
          const distance = Math.abs(nearbyPause - pos);
          return 0.85 + (distance / 0.05) * 0.15; // Smooth transition
        }
        return 1.0;
      }
    });
    
    // Calculate total duration accounting for variable speeds
    const avgSpeedMultiplier = smoothedSpeedMap.reduce((a, b) => a + b, 0) / smoothedSpeedMap.length;
    const adjustedPixelsPerSecond = basePixelsPerSecond * avgSpeedMultiplier;
    const baseDuration = totalDistance / adjustedPixelsPerSecond;
    
    // Adjust for content complexity
    let speedMultiplier = 1.0;
    const hasLongWords = /\w{8,}/.test(fullText);
    const punctuationCount = (fullText.match(/[.,!?;:]/g) || []).length;
    if (hasLongWords) speedMultiplier *= 0.9;
    if (punctuationCount > totalCharacters * 0.05) speedMultiplier *= 0.95;
    
    const totalDuration = baseDuration / speedMultiplier;

    // Pre-calculate position map for efficient lookup
    // This maps normalized time progress (0-1) to actual text position (0-1) accounting for variable speeds
    const positionMap: number[] = [];
    const mapResolution = 200; // Number of points in the map
    
    // Calculate total "weighted time" - time it takes to scroll through text with variable speeds
    let totalWeightedTime = 0;
    for (let i = 0; i < smoothedSpeedMap.length - 1; i++) {
      const segmentLength = 1 / smoothedSpeedMap.length;
      const speed = smoothedSpeedMap[i];
      totalWeightedTime += segmentLength / speed;
    }
    
    // Build position map: for each time point, find corresponding text position
    for (let i = 0; i <= mapResolution; i++) {
      const timeProgress = i / mapResolution;
      let textProgress = 0;
      let accumulatedTime = 0;
      
      // Traverse through text segments
      for (let j = 0; j < smoothedSpeedMap.length; j++) {
        const segmentStart = j / smoothedSpeedMap.length;
        const segmentEnd = (j + 1) / smoothedSpeedMap.length;
        const speed = smoothedSpeedMap[j];
        const segmentTime = (segmentEnd - segmentStart) / speed;
        const normalizedSegmentTime = segmentTime / totalWeightedTime;
        
        if (accumulatedTime + normalizedSegmentTime >= timeProgress) {
          // We're in this segment
          const progressInSegment = (timeProgress - accumulatedTime) / normalizedSegmentTime;
          textProgress = segmentStart + (segmentEnd - segmentStart) * progressInSegment;
          break;
        }
        
        accumulatedTime += normalizedSegmentTime;
        textProgress = segmentEnd;
      }
      
      positionMap.push(Math.min(textProgress, 1));
    }

    // Reset position to start
    if (textRef.current) {
      textRef.current.style.transform = `translateX(${startPosition}px)`;
    }

    // Context-aware animation with variable speed
    const animate = (timestamp: number) => {
      if (!textRef.current) return;

      // Check pause state from ref (avoids closure issues)
      if (isPausedRef.current) {
        // While paused, maintain position but don't advance
        animationRef.current = requestAnimationFrame(animate);
        return;
      }

      const elapsed = (timestamp - startTimeRef.current) / 1000;
      
      if (elapsed >= totalDuration) {
        // Animation complete
        textRef.current.style.transform = `translateX(${endPosition}px)`;
        setIsAnimating(false);
        animationRef.current = null;
        return;
      }
      
      // Calculate normalized progress (0-1)
      const normalizedProgress = Math.min(elapsed / totalDuration, 1);
      
      // Look up actual text position from pre-calculated map
      const mapIndex = Math.floor(normalizedProgress * mapResolution);
      const mapIndexNext = Math.min(mapIndex + 1, mapResolution);
      const mapProgress = (normalizedProgress * mapResolution) - mapIndex;
      
      const textProgress = positionMap[mapIndex] + 
        (positionMap[mapIndexNext] - positionMap[mapIndex]) * mapProgress;
      
      const currentX = startPosition + (endPosition - startPosition) * textProgress;
      
      textRef.current.style.transform = `translateX(${currentX}px)`;
      animationRef.current = requestAnimationFrame(animate);
    };

    startTimeRef.current = performance.now() - pausedElapsedRef.current * 1000;
    const initialTimestamp = performance.now();
    animate(initialTimestamp);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [fullText, readingSpeed]); // Remove isPaused from dependencies

  // Handle pause state changes - update ref immediately for animation loop
  useEffect(() => {
    isPausedRef.current = isPaused;
    
    if (!textRef.current || !isAnimating) return;

    if (isPaused) {
      // When pausing: save current elapsed time based on position
      const currentTransform = textRef.current.style.transform;
      const match = currentTransform.match(/translateX\(([-\d.]+)px\)/);
      if (match) {
        const currentX = parseFloat(match[1]);
        const containerWidth = containerRef.current?.clientWidth || 0;
        const textWidth = textRef.current.scrollWidth;
        const startPosition = containerWidth;
        const endPosition = -textWidth;
        const totalDistance = textWidth + containerWidth;
        const progress = Math.max(0, Math.min(1, (startPosition - currentX) / totalDistance));
        
        const pixelsPerCharacter = 18;
        const totalCharacters = fullText.length;
        const basePixelsPerSecond = readingSpeed * pixelsPerCharacter;
        let speedMultiplier = 1.0;
        const hasLongWords = /\w{8,}/.test(fullText);
        const punctuationCount = (fullText.match(/[.,!?;:]/g) || []).length;
        if (hasLongWords) speedMultiplier *= 0.9;
        if (punctuationCount > totalCharacters * 0.05) speedMultiplier *= 0.95;
        const adjustedPixelsPerSecond = basePixelsPerSecond * speedMultiplier;
        const totalDuration = totalDistance / adjustedPixelsPerSecond;
        
        pausedElapsedRef.current = progress * totalDuration;
      }
    } else {
      // When resuming: adjust start time to account for paused duration
      startTimeRef.current = performance.now() - pausedElapsedRef.current * 1000;
    }
  }, [isPaused, fullText, readingSpeed, isAnimating]);

  const togglePause = () => {
    setIsPaused(prev => {
      const newPaused = !prev;
      isPausedRef.current = newPaused; // Update ref immediately
      return newPaused;
    });
  };

  return (
    <div className="relative">
      <div 
        ref={containerRef}
        className="h-64 w-full bg-gray-900 border-4 border-emerald-500 p-6 shadow-2xl rounded-xl overflow-hidden relative"
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
              {renderWithPauseMarker(fullText)}
            </div>
          ) : (
            <p className="text-3xl font-bold text-emerald-300">
              Ask a question to begin...
            </p>
          )}
        </div>
        {/* Pause/Resume Button - only for scrolling control */}
        {fullText && isAnimating && (
          <button
            onClick={togglePause}
            className="absolute bottom-4 right-4 bg-emerald-600 hover:bg-emerald-500 text-white px-8 py-4 rounded-2xl shadow-2xl text-2xl font-extrabold transition z-20 border-4 border-emerald-300 focus:outline-none focus:ring-4 focus:ring-emerald-700"
            aria-label={isPaused ? "Resume scrolling" : "Pause scrolling"}
          >
            {isPaused ? "▶ Resume" : "⏸ Pause"}
          </button>
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
  const [codeBlocks, setCodeBlocks] = useState<string[]>([]);
  const [clarifyingQuestions, setClarifyingQuestions] = useState<string[]>([]);
  const [isGeneratingClarifying, setIsGeneratingClarifying] = useState(false);
  const [pendingClarification, setPendingClarification] = useState<{ question: string; originalAnswer: string } | null>(null);
  const [isGeneratingDeeper, setIsGeneratingDeeper] = useState(false);
  const [scrollingPrompt, setScrollingPrompt] = useState<string>("");
  const [typedQuestion, setTypedQuestion] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [aboutCompany, setAboutCompany] = useState("");
  const [technicalInfo, setTechnicalInfo] = useState("");
  const [hasMounted, setHasMounted] = useState(false);
  const [readingSpeed, setReadingSpeed] = useState(12); // Characters per second
  
  // Generation state flags (separate from status for button control)
  const [isGeneratingResponse, setIsGeneratingResponse] = useState(false);
  const [isListening, setIsListening] = useState(false);

  // Response timer state
  const [responseTimerStart, setResponseTimerStart] = useState<number | null>(null);
  const [responseTime, setResponseTime] = useState<number | null>(null);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const timerStartRef = useRef<number | null>(null); // Track start time via ref for reliable access
  const isTimerRunningRef = useRef<boolean>(false); // Track running state via ref to avoid stale closures

  // Recording session state
  const [isSessionRecording, setIsSessionRecording] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);

  // Profiles state
  const [profiles, setProfiles] = useState<CompanyProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [profileNameInput, setProfileNameInput] = useState<string>("");
  const [technicalQAs, setTechnicalQAs] = useState<TechnicalQA[]>([]);

  // Interview mode state
  type InterviewMode = "qa" | "procedural";
  const [interviewMode, setInterviewMode] = useState<InterviewMode>("qa");
  const [proceduralSteps, setProceduralSteps] = useState<string[]>([]);
  
  // Interview round state
  const [interviewRound, setInterviewRound] = useState<number>(1);

  // Active Interview mode state
  const [isActiveInterviewMode, setIsActiveInterviewMode] = useState<boolean>(false);
  const backgroundRecognitionRef = useRef<any>(null);
  const rollingBufferRef = useRef<Array<{ text: string; timestamp: number }>>([]);
  const bufferCleanupIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isActiveInterviewModeRef = useRef<boolean>(false);

  // Conversation state
  const [conversation, setConversation] = useState<ConversationEvent[]>([]);
  const addEvent = useCallback((e: Omit<ConversationEvent, 'id' | 'timestamp'> & { timestamp?: number }) => {
    const event: ConversationEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: e.timestamp ?? Date.now(),
      role: e.role,
      content: e.content,
      metadata: e.metadata,
    };
    setConversation(prev => [...prev, event]);
  }, []);

  const clearStoredResponses = useCallback(async () => {
    if (!selectedProfileId) {
      setStatus("Please select a profile first before clearing stored responses.");
      return;
    }
    
    if (!confirm(`Are you sure you want to clear stored responses for the current profile (Round ${interviewRound})? This will remove all previously generated responses for this profile and round, and cannot be undone.`)) {
      return;
    }
    
    try {
      const response = await fetch("/api/clear-responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId: selectedProfileId,
          interviewRound: interviewRound,
        }),
      });
      
      const data = await response.json();
      
      if (data.success) {
        setStatus(`Cleared ${data.count} stored response(s) for current profile (Round ${interviewRound}).`);
      } else {
        setStatus(`Error clearing responses: ${data.error}`);
      }
    } catch (error: any) {
      console.error("Error clearing stored responses:", error);
      setStatus("Failed to clear stored responses. See console.");
    }
  }, [selectedProfileId, interviewRound]);

  const downloadTranscript = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      aboutCompany,
      jobDescription,
      technicalInfo,
      conversation,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interview-transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [conversation, aboutCompany, jobDescription, technicalInfo]);

  const clearTranscript = useCallback(() => {
    setConversation([]);
  }, []);

  // Build plain-text transcript
  const formatTime = (ts: number) => new Date(ts).toLocaleString();
  const buildPlainTranscript = useCallback(() => {
    const lines: string[] = [];
    lines.push(`# Interview Transcript`);
    lines.push(`Exported: ${new Date().toLocaleString()}`);
    if (aboutCompany.trim()) lines.push(`About Company: ${aboutCompany.trim()}`);
    if (jobDescription.trim()) lines.push(`Job Description: ${jobDescription.trim()}`);
    if (technicalInfo.trim()) lines.push(`Technical Information: ${technicalInfo.trim()}`);
    lines.push("");
    for (const evt of conversation) {
      const role = evt.role.toUpperCase();
      lines.push(`[${formatTime(evt.timestamp)}] ${role}:`);
      lines.push(evt.content);
      lines.push("");
    }
    return lines.join("\n");
  }, [conversation, aboutCompany, jobDescription, technicalInfo]);

  const downloadPlainTranscript = useCallback(() => {
    const text = buildPlainTranscript();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interview-transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [buildPlainTranscript]);

  const startRecordingSession = useCallback(() => {
    setIsSessionRecording(true);
    setRecordingStartedAt(Date.now());
    addEvent({ role: 'meta', content: 'Recording session started' });
    setStatus('Recording session started.');
  }, [addEvent]);

  const stopRecordingSession = useCallback(() => {
    setIsSessionRecording(false);
    addEvent({ role: 'meta', content: 'Recording session stopped' });
    setStatus('Recording session stopped. Downloading transcript...');
    // Auto-download plain transcript on stop
    setTimeout(() => {
      try { downloadPlainTranscript(); } catch {}
    }, 100);
  }, [downloadPlainTranscript, addEvent]);

  const SpeechRecognition =
    typeof window !== "undefined"
      ? (window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition
      : null;
  const isSpeechSupported = !!SpeechRecognition;

  // Timer effect to update display while running
  useEffect(() => {
    // Clear any existing interval first
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    // If timer is not running, ensure everything is cleared
    if (!isTimerRunning || !responseTimerStart) {
      timerStartRef.current = null;
      isTimerRunningRef.current = false;
      return;
    }

    // Store start time in ref for reliable access
    timerStartRef.current = responseTimerStart;
    isTimerRunningRef.current = true;

    // Create interval only if timer is running
    const interval = setInterval(() => {
      // Check ref instead of state to avoid stale closures
      if (timerStartRef.current && isTimerRunningRef.current) {
        const elapsed = Date.now() - timerStartRef.current;
        setResponseTime(elapsed);
      } else {
        // Timer was stopped, clear interval
        if (timerIntervalRef.current) {
          clearInterval(timerIntervalRef.current);
          timerIntervalRef.current = null;
        }
      }
    }, 10); // Update every 10ms for smooth display

    timerIntervalRef.current = interval;

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    };
  }, [isTimerRunning, responseTimerStart]);

  // Function to stop timer explicitly
  const stopTimer = useCallback(() => {
    // Clear interval immediately - this MUST happen first
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    
    // Mark timer as stopped in ref immediately
    isTimerRunningRef.current = false;
    
    // Calculate elapsed time using ref (most reliable source)
    let elapsed: number | null = null;
    if (timerStartRef.current) {
      elapsed = Date.now() - timerStartRef.current;
    } else if (responseTimerStart) {
      elapsed = Date.now() - responseTimerStart;
    }
    
    // Stop timer state - use batch updates to ensure consistency
    if (timerStartRef.current || responseTimerStart) {
      setIsTimerRunning(false);
      setResponseTimerStart(null);
      timerStartRef.current = null;
      
      if (elapsed !== null) {
        setResponseTime(elapsed);
      }
    }
    
    return elapsed;
  }, [responseTimerStart]);

  // Format time for display
  const formatResponseTime = useCallback((ms: number | null): string => {
    if (ms === null) return "0.00s";
    return (ms / 1000).toFixed(2) + "s";
  }, []);

  // Callback to stop timer when scrolling starts
  const handleScrollingStart = useCallback(() => {
    // Stop timer when scrolling actually starts
    if (isTimerRunning && responseTimerStart) {
      const elapsed = Date.now() - responseTimerStart;
      setResponseTime(elapsed);
      setIsTimerRunning(false);
      
      // Update the last assistant event with response time if it exists
      setConversation(prev => {
        const updated = [...prev];
        // Find the last assistant event
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].role === 'assistant' && !updated[i].metadata?.responseTimeMs) {
            updated[i] = {
              ...updated[i],
              metadata: {
                ...updated[i].metadata,
                responseTimeMs: elapsed,
                responseTimeFormatted: formatResponseTime(elapsed)
              }
            };
            break;
          }
        }
        return updated;
      });
    }
  }, [isTimerRunning, responseTimerStart, formatResponseTime]);

  // Set hasMounted to true after component mounts (prevents hydration issues)
  useEffect(() => {
    setHasMounted(true);
  }, []);

  // Load profiles from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CompanyProfile[];
        // Migrate old profiles that don't have technicalInfo or technicalQAs fields
        const migrated = parsed.map((p: any) => ({
          ...p,
          technicalInfo: p.technicalInfo || "",
          technicalQAs: p.technicalQAs || [],
        }));
        setProfiles(Array.isArray(migrated) ? migrated : []);
      }
    } catch {}
  }, []);

  // Persist profiles on change
  useEffect(() => {
    try {
      localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(profiles));
    } catch {}
  }, [profiles]);

  const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const selectProfile = useCallback((id: string) => {
    setSelectedProfileId(id);
    const p = profiles.find(pr => pr.id === id);
    if (p) {
      setProfileNameInput(p.name);
      setAboutCompany(p.aboutCompany || "");
      setJobDescription(p.jobDescription || "");
      setTechnicalInfo(p.technicalInfo || "");
      setTechnicalQAs(p.technicalQAs || []);
      setStatus(`Loaded profile: ${p.name}`);
    }
  }, [profiles]);

  const saveCurrentAsProfile = useCallback(() => {
    const name = profileNameInput.trim();
    if (!name) {
      setStatus("Enter a profile name before saving.");
      return;
    }
    if (selectedProfileId) {
      // Update existing
      setProfiles(prev => prev.map(p => p.id === selectedProfileId ? {
        ...p,
        name,
        aboutCompany,
        jobDescription,
        technicalInfo,
        technicalQAs,
        updatedAt: Date.now(),
      } : p));
      setStatus(`Updated profile: ${name}`);
    } else {
      // Create new
      const newProfile: CompanyProfile = {
        id: generateId(),
        name,
        aboutCompany,
        jobDescription,
        technicalInfo,
        technicalQAs,
        updatedAt: Date.now(),
      };
      setProfiles(prev => [newProfile, ...prev]);
      setSelectedProfileId(newProfile.id);
      setStatus(`Saved new profile: ${name}`);
    }
  }, [profileNameInput, aboutCompany, jobDescription, technicalInfo, technicalQAs, selectedProfileId]);

  const newProfile = useCallback(() => {
    setSelectedProfileId("");
    setProfileNameInput("");
    setTechnicalQAs([]);
    // Do not clear fields automatically so user can start from current content if desired
    setStatus("New profile: set a name and save.");
  }, []);

  const deleteProfile = useCallback(() => {
    if (!selectedProfileId) {
      setStatus("No profile selected to delete.");
      return;
    }
    const p = profiles.find(pr => pr.id === selectedProfileId);
    setProfiles(prev => prev.filter(pr => pr.id !== selectedProfileId));
    setSelectedProfileId("");
    setProfileNameInput("");
    setTechnicalQAs([]);
    setStatus(`Deleted profile${p ? `: ${p.name}` : ''}.`);
  }, [selectedProfileId, profiles]);

  // Technical Q&A management functions
  const addTechnicalQA = useCallback(() => {
    const newQA: TechnicalQA = {
      id: generateId(),
      question: "",
      answer: "",
    };
    setTechnicalQAs(prev => [...prev, newQA]);
  }, []);

  const updateTechnicalQA = useCallback((id: string, field: 'question' | 'answer', value: string) => {
    setTechnicalQAs(prev => prev.map(qa => 
      qa.id === id ? { ...qa, [field]: value } : qa
    ));
  }, []);

  const removeTechnicalQA = useCallback((id: string) => {
    setTechnicalQAs(prev => prev.filter(qa => qa.id !== id));
  }, []);

  // Prompt mic permission explicitly; helps some browsers prompt reliably
  const requestMicPermission = useCallback(async (): Promise<boolean> => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return true; // SR may still work
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Immediately stop tracks; we only needed the permission
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch (err: any) {
      console.error("Microphone permission error:", err);
      setStatus("Error: Microphone access was denied. Please allow mic access.");
      return false;
    }
  }, []);

  // Removed mic warmup; recognition starts immediately

  const generateClarifyingQuestions = useCallback(async (originalQuestion: string) => {
    if (!originalQuestion.trim()) {
      setStatus("No question to clarify. Ask a question first.");
      return;
    }

    setIsGeneratingClarifying(true);
    setStatus("Generating clarifying questions...");
    addEvent({ role: 'meta', content: 'Generating clarifying questions', metadata: { originalQuestion } });

    try {
      const clarifyingPrompt = `Based on this interview question, generate 3-4 concise clarifying questions that would help understand what specific direction or angle the interviewer wants the answer to take. The clarifying questions should be short (one sentence each) and focused on different aspects (technical depth, specific examples, industry context, etc.).\n\nOriginal question: "${originalQuestion}"\n${aboutCompany.trim() ? `Company context (about company):\n${aboutCompany.trim()}\n` : ""}${technicalInfo.trim() ? `Technical information:\n${technicalInfo.trim()}\n` : ""}\n\nGenerate clarifying questions as a simple list, one per line, without numbering or bullets.`;

      const clarifyingText = await generateText(clarifyingPrompt, technicalQAs.filter(qa => qa.question.trim() && qa.answer.trim()));
      
      if (clarifyingText) {
        const questions = clarifyingText
          .split('\n')
          .map(q => q.trim())
          .filter(q => q.length > 0 && !q.match(/^(clarity|clarify|question|1\.|2\.|3\.|4\.|-|•)/i))
          .slice(0, 4);
        
        setClarifyingQuestions(questions);
        addEvent({ role: 'assistant', content: questions.join('\n'), metadata: { type: 'clarifying_suggestions' } });
        if (questions.length > 0) {
          setScrollingPrompt(questions[0]);
        }
        setStatus(`Generated ${questions.length} clarifying questions.`);
      } else {
        setClarifyingQuestions([]);
        setStatus("Could not generate clarifying questions.");
      }
    } catch (error: any) {
      console.error("Clarifying questions failed:", error);
      setStatus("Failed to generate clarifying questions.");
      setClarifyingQuestions([]);
    } finally {
      setIsGeneratingClarifying(false);
    }
  }, [aboutCompany, technicalInfo, technicalQAs, addEvent]);

  const handleQuery = useCallback(async (query: string, isClarification: boolean = false, round?: number) => {
    if (!query || query.trim().length < 5) {
      setStatus("Query is too short or empty. Cannot proceed.");
      return;
    }

    console.log("📝 Full question being processed:", query);
    console.log("📏 Question length:", query.length, "characters");

    if (!isClarification) {
      addEvent({ role: 'user', content: query });
      
      // Start response timer for typed questions (voice questions already started timer)
      if (!isTimerRunning) {
        const startTime = Date.now();
        setResponseTimerStart(startTime);
        timerStartRef.current = startTime;
        isTimerRunningRef.current = true;
        setIsTimerRunning(true);
        setResponseTime(null);
      }
    }
    // Note: For clarifications, we don't log the combined prompt here because
    // the actual user clarification answer is already logged separately
    // in startListeningForClarification (line 747)

    setIsGeneratingResponse(true);
    setStatus("Generating response...");
    if (!isClarification) {
      setFullResponse("");
      setClarifyingQuestions([]);
    }

    try {
      const fullQuery = query.trim();
      const companyContext = aboutCompany.trim() ? `Company context (about company):\n${aboutCompany.trim()}\n` : "";
      const roleContext = jobDescription.trim() ? `Role context (job description):\n${jobDescription.trim()}\n` : "";
      const techContext = technicalInfo.trim() ? `Technical information:\n${technicalInfo.trim()}\n` : "";
      
      let rolePreamble: string;
      if (interviewMode === "procedural") {
        // Procedural interview mode - format as step-by-step process with SPECIFIC commands and locations
        rolePreamble =
          (companyContext || roleContext || techContext
            ? `${companyContext}${roleContext}${techContext}\nThis is a PROCEDURAL INTERVIEW question. The interviewer wants SPECIFIC, ACTIONABLE steps with exact commands, tools, and locations.\n\nFormat your response as a clear, numbered list of steps.\n\nFor each step, structure it as:\nStep X: [Goal/Objective] - [Specific actions including:\n  - Exact commands (CLI, API calls, scripts) with actual syntax\n  - Specific locations in cloud platforms (e.g., "AWS GuardDuty → Findings → Filter by severity 'HIGH'")\n  - Exact paths, URLs, or navigation steps\n  - Specific tools and their exact locations/features]\n\nCRITICAL: Include SPECIFIC details:\n- Actual commands (e.g., \`aws guardduty list-findings --finding-criteria file://criteria.json\`)\n- Exact cloud service locations (e.g., "Navigate to Azure Security Center → Security alerts → Filter by severity 'High'")\n- Specific navigation paths (e.g., "GCP Security Command Center → Findings → Filter by severity 'CRITICAL'")\n- Exact tools and features used\n\nBe concrete and actionable - avoid vague descriptions.\n\nProcedural question: ${fullQuery}`
            : `This is a PROCEDURAL INTERVIEW question. Format your response as a clear, numbered list of steps with SPECIFIC commands and locations.\n\nFor each step, structure it as:\nStep X: [Goal/Objective] - [Specific actions including exact commands, cloud service locations, and tools]\n\nCRITICAL: Include SPECIFIC details like actual commands, exact cloud service navigation paths, and specific tool locations.\n\nProcedural question: ${fullQuery}`);
      } else {
        // Q&A interview mode (default)
        rolePreamble =
          (companyContext || roleContext || techContext
            ? `${companyContext}${roleContext}${techContext}\nAnswer the interview question tailored to this context. Keep it spoken-style and aim for ~30 seconds (~70–90 words).\n\nInterview question: ${fullQuery}`
            : `Answer in ~30 seconds (~70–90 words), spoken-style.\n\nInterview question: ${fullQuery}`);
      }
      
      const generatedText = await generateText(rolePreamble, technicalQAs.filter(qa => qa.question.trim() && qa.answer.trim()), interviewMode, round || interviewRound, selectedProfileId);

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
        setCodeBlocks([]);
        setIsGeneratingResponse(false);
        
        // Stop timer on no response
        stopTimer();
        
        addEvent({ role: 'assistant', content: '[No response generated]' });
        return;
      }

      let { cleanText, codeBlocks: extractedBlocks } = extractCodeBlocks(generatedText);
      
      // Parse procedural steps if in procedural mode
      if (interviewMode === "procedural") {
        const steps = parseProceduralSteps(cleanText);
        setProceduralSteps(steps);
        setFullResponse(cleanText); // Store full response for reference
        setCodeBlocks(extractedBlocks);
        setStatus("Procedural steps ready.");
        setIsGeneratingResponse(false);
        
        // Stop timer immediately when procedural steps are ready (no scrolling in procedural mode)
        // Call stopTimer unconditionally - it will check if timer is actually running
        const elapsed = stopTimer();
        
        if (elapsed !== null) {
          // Update event metadata with response time
          setConversation(prev => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === 'assistant' && !updated[i].metadata?.responseTimeMs) {
                updated[i] = {
                  ...updated[i],
                  metadata: {
                    ...updated[i].metadata,
                    responseTimeMs: elapsed,
                    responseTimeFormatted: formatResponseTime(elapsed),
                    type: 'procedural',
                    steps: steps.length
                  }
                };
                break;
              }
            }
            return updated;
          });
        }
        
        addEvent({ 
          role: 'assistant', 
          content: cleanText, 
          metadata: { 
            codeBlocks: extractedBlocks,
            type: 'procedural',
            steps: steps.length
          }
        });
        
        return; // Early return for procedural mode
      } else {
        setProceduralSteps([]);
      }
      
      const isTechnicalQuestion = /(?:technical|technology|system|process|tool|method|how does|how do|implementation|architecture|infrastructure|code|script|query|database|network|security|cloud|API|algorithm|configuration)/i.test(query);
      
      if (isTechnicalQuestion) {
        if (!cleanText.toLowerCase().includes("would you like me to go deeper")) {
          cleanText = cleanText.trim() + " Would you like me to go deeper into that?";
        }
        if (!cleanText.toLowerCase().includes("example query")) {
          cleanText = cleanText.trim() + " I can provide an example query if you'd like.";
        }
      }
      
      setFullResponse(cleanText);
      setCodeBlocks(extractedBlocks);
      setStatus("Response ready. Scrolling text...");
      setIsGeneratingResponse(false);

      // Don't stop timer here - wait for scrolling to start via callback
      addEvent({ role: 'assistant', content: cleanText, metadata: { codeBlocks: extractedBlocks } });
    } catch (error: any) {
      console.error("Query process failed:", error);
      setFullResponse("A network or API error occurred. Check the console.");
      setStatus("Failed: API communication failed. See console.");
      setIsGeneratingResponse(false);
      
      // Stop timer on error
      stopTimer();
      
      addEvent({ role: 'assistant', content: '[API error]' });
    }
  }, [jobDescription, aboutCompany, technicalInfo, technicalQAs, addEvent, interviewMode, formatResponseTime, stopTimer]);

  // Go deeper using the existing question and current response
  const generateDeeperAnswer = useCallback(async () => {
    if (!question.trim() || !fullResponse.trim()) {
      setStatus("Nothing to deepen yet. Ask a question first.");
      return;
    }
    try {
      setIsGeneratingDeeper(true);
      setStatus("Generating deeper, more specific answer...");
      addEvent({ role: 'meta', content: 'Generating deeper answer' });
      
      // Start timer for deeper answer generation
      const startTime = Date.now();
      setResponseTimerStart(startTime);
      timerStartRef.current = startTime;
      isTimerRunningRef.current = true;
      setIsTimerRunning(true);
      setResponseTime(null);

      const deeperPrompt = `The interviewer asked the following question and the candidate answered. Please produce a deeper, more specific answer that builds directly on the existing answer. Add technical specifics, trade-offs, concrete examples, concise metrics, and relevant tools or methods where appropriate. Keep it conversational, spoken-style, and target ~30 seconds (~70–90 words).\n\nOriginal question: "${question}"\n\n${aboutCompany.trim() ? `Company context (about company):\n${aboutCompany.trim()}\n` : ""}${jobDescription.trim() ? `Role context (job description):\n${jobDescription.trim()}\n` : ""}${technicalInfo.trim() ? `Technical information:\n${technicalInfo.trim()}\n` : ""}\n\nExisting answer: "${fullResponse}"\n\nNow provide a refined, deeper answer that assumes the listener heard the existing answer and expands on the most important specifics (without repeating filler).`;

      const generatedText = await generateText(deeperPrompt, technicalQAs.filter(qa => qa.question.trim() && qa.answer.trim()), interviewMode, interviewRound, selectedProfileId);
      if (!generatedText || generatedText.trim().length === 0) {
        setStatus("Deeper answer generation returned empty. Try again.");
        return;
      }
      let { cleanText, codeBlocks: extractedBlocks } = extractCodeBlocks(generatedText);

      const isTechnical = /(?:technical|technology|system|process|tool|method|how does|how do|implementation|architecture|infrastructure|code|script|query|database|network|security|cloud|API|algorithm|configuration)/i.test(question + " " + cleanText);
      if (isTechnical && !cleanText.toLowerCase().includes("would you like me to go deeper")) {
        cleanText = cleanText.trim() + " Would you like me to go deeper into that?";
      }

      setFullResponse(cleanText);
      setCodeBlocks(extractedBlocks);
      setStatus("Deeper response ready. Scrolling text...");
      setIsGeneratingDeeper(false);
      
      // Don't stop timer here - wait for scrolling to start
      addEvent({ role: 'assistant', content: cleanText, metadata: { codeBlocks: extractedBlocks, type: 'deeper' } });
    } catch (e) {
      console.error("Deeper generation failed:", e);
      setStatus("Failed to generate deeper answer.");
      setIsGeneratingDeeper(false);
      
      // Stop timer on error
      stopTimer();
      
      addEvent({ role: 'assistant', content: '[Deeper generation failed]' });
    } finally {
      setIsGeneratingDeeper(false);
    }
  }, [question, fullResponse, jobDescription, aboutCompany, technicalInfo, technicalQAs, addEvent, stopTimer]);

  const useClarifyingQuestion = useCallback(async (clarifyingQ: string, originalQ: string) => {
    setPendingClarification({
      question: clarifyingQ,
      originalAnswer: fullResponse
    });
    setStatus(`Clarifying question: "${clarifyingQ}" - Please answer this question...`);
    setScrollingPrompt(clarifyingQ);
    addEvent({ role: 'system', content: `Clarifying question selected: ${clarifyingQ}`, metadata: { originalQ } });
    
    if (isSpeechSupported) {
      setTimeout(() => {
        startListeningForClarification(clarifyingQ, originalQ, fullResponse);
      }, 500);
    }
  }, [fullResponse, isSpeechSupported, addEvent]);

  const startListeningForClarification = useCallback(async (
    clarifyingQuestion: string, 
    originalQuestion: string, 
    originalAnswer: string
  ) => {
    if (!isSpeechSupported) {
      setStatus("Error: Speech Recognition not supported.");
      return;
    }

    const ok = await requestMicPermission();
    if (!ok) return;

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    setStatus(`Listening for your answer to: "${clarifyingQuestion}"`);

    let finalTranscript = "";
    let isProcessing = false;

    recognition.onstart = () => setStatus(`Listening for clarification...`);
    recognition.onspeechstart = () => setStatus("Speaking detected. Keep going...");
    recognition.onspeechend = () => {
      setStatus("Speech ended. Processing clarification...");
    };
    
    recognition.onresult = (event: any) => {
      let interimTranscript = "";
      
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript + " ";
        } else {
          interimTranscript += transcript;
        }
      }
      
      if (interimTranscript) {
        setStatus("Listening: " + interimTranscript);
      }
      
      if (finalTranscript && !isProcessing) {
        isProcessing = true;
        const clarificationAnswer = finalTranscript.trim();
        setStatus("Integrating clarification...");
        try { recognition.stop(); } catch {}
        addEvent({ role: 'user', content: clarificationAnswer, metadata: { type: 'clarification_answer', clarifyingQuestion } });
        
        // Start response timer for clarification answer
        const startTime = Date.now();
        setResponseTimerStart(startTime);
        timerStartRef.current = startTime;
        isTimerRunningRef.current = true;
        setIsTimerRunning(true);
        setResponseTime(null);
        
        const combinedPrompt = `Based on this original interview answer, the interviewer asked a clarifying question, and the candidate provided additional information. Please provide a refined, comprehensive answer that incorporates both the original response and the new clarification.\n\nOriginal question: "${originalQuestion}"\n\nOriginal answer: "${originalAnswer}"\n\nClarifying question asked: "${clarifyingQuestion}"\n\nClarification provided: "${clarificationAnswer}"\n\nPlease provide a refined answer that:\n1. Maintains the key points from the original answer\n2. Integrates the new information from the clarification\n3. Provides a more complete and targeted response\n 4. Stays conversational and natural\n${jobDescription.trim() ? `\nRole context (job description):\n${jobDescription.trim()}\n` : ""}${aboutCompany.trim() ? `Company context (about company):\n${aboutCompany.trim()}\n` : ""}${technicalInfo.trim() ? `Technical information:\n${technicalInfo.trim()}\n` : ""}`;

        setScrollingPrompt("");
        handleQuery(combinedPrompt, true, interviewRound);
        setPendingClarification(null);
      }
    };
    
    recognition.onerror = (event: any) => {
      const err = event?.error || "unknown";
      setStatus("Speech Error: " + err);
      setPendingClarification(null);
      addEvent({ role: 'meta', content: `Clarification error: ${err}` });
    };
    
    recognition.onend = () => {
      if (!isProcessing && status.includes("Listening")) {
        setStatus("No clarification detected. Try again.");
        setPendingClarification(null);
      }
    };

    setTimeout(() => {
      try { recognition.start(); } catch (e) {
        console.error("recognition.start failed", e);
        setStatus("Error: Could not start microphone.");
        setPendingClarification(null);
      }
    }, 150);
  }, [isSpeechSupported, requestMicPermission, handleQuery, jobDescription, aboutCompany, technicalInfo, status, addEvent]);

  // Clean up old entries from rolling buffer (older than 30 seconds)
  const cleanupRollingBuffer = useCallback(() => {
    const now = Date.now();
    const thirtySecondsAgo = now - 30000;
    rollingBufferRef.current = rollingBufferRef.current.filter(
      entry => entry.timestamp >= thirtySecondsAgo
    );
  }, []);

  // Start background recognition for Active Interview mode
  const startBackgroundRecognition = useCallback(async () => {
    if (!isSpeechSupported) {
      return;
    }

    const ok = await requestMicPermission();
    if (!ok) return;

    // Stop any existing background recognition
    if (backgroundRecognitionRef.current) {
      try {
        backgroundRecognitionRef.current.stop();
      } catch {}
      backgroundRecognitionRef.current = null;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = true;

    recognition.onresult = (event: any) => {
      // Process results and add to rolling buffer
      let latestText = "";
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          const trimmed = transcript.trim();
          if (trimmed) {
            rollingBufferRef.current.push({
              text: trimmed,
              timestamp: Date.now()
            });
            // Clean up old entries
            cleanupRollingBuffer();
          }
        } else {
          latestText = transcript;
        }
      }
    };

    recognition.onerror = (event: any) => {
      // Silently handle errors in background mode
      if (event.error === "no-speech") {
        // Try to restart if it stops
        setTimeout(() => {
          if (isActiveInterviewModeRef.current && backgroundRecognitionRef.current) {
            try {
              backgroundRecognitionRef.current.start();
            } catch {}
          }
        }, 1000);
      }
    };

    recognition.onend = () => {
      // Auto-restart if Active Interview mode is still enabled
      if (isActiveInterviewModeRef.current) {
        setTimeout(() => {
          if (isActiveInterviewModeRef.current) {
            try {
              recognition.start();
            } catch {}
          }
        }, 500);
      }
    };

    try {
      recognition.start();
      backgroundRecognitionRef.current = recognition;
    } catch (e) {
      console.error("Background recognition start failed:", e);
    }
  }, [isSpeechSupported, cleanupRollingBuffer]);

  // Stop background recognition
  const stopBackgroundRecognition = useCallback(() => {
    if (backgroundRecognitionRef.current) {
      try {
        backgroundRecognitionRef.current.stop();
      } catch {}
      backgroundRecognitionRef.current = null;
    }
    // Clear buffer cleanup interval
    if (bufferCleanupIntervalRef.current) {
      clearInterval(bufferCleanupIntervalRef.current);
      bufferCleanupIntervalRef.current = null;
    }
    // Clear the buffer
    rollingBufferRef.current = [];
  }, []);

  // Get buffered text from last 30 seconds
  const getBufferedText = useCallback((): string => {
    cleanupRollingBuffer();
    const bufferedTexts = rollingBufferRef.current.map(entry => entry.text);
    return bufferedTexts.join(" ").trim();
  }, [cleanupRollingBuffer]);

  // Effect to manage background recognition based on Active Interview mode
  useEffect(() => {
    isActiveInterviewModeRef.current = isActiveInterviewMode;
    
    if (isActiveInterviewMode) {
      startBackgroundRecognition();
      // Set up periodic cleanup of old buffer entries
      bufferCleanupIntervalRef.current = setInterval(() => {
        cleanupRollingBuffer();
      }, 5000); // Clean up every 5 seconds
    } else {
      stopBackgroundRecognition();
    }

    return () => {
      if (bufferCleanupIntervalRef.current) {
        clearInterval(bufferCleanupIntervalRef.current);
        bufferCleanupIntervalRef.current = null;
      }
    };
  }, [isActiveInterviewMode, startBackgroundRecognition, stopBackgroundRecognition, cleanupRollingBuffer]);

  const startListening = useCallback(async () => {
    if (!isSpeechSupported) {
      setStatus("Error: Speech Recognition not supported.");
      return;
    }

    const ok = await requestMicPermission();
    if (!ok) return;

    // Pause background recognition while main listening is active
    let wasBackgroundActive = false;
    if (isActiveInterviewMode && backgroundRecognitionRef.current) {
      wasBackgroundActive = true;
      try {
        backgroundRecognitionRef.current.stop();
      } catch {}
    }

    // Get buffered text if Active Interview mode is enabled
    const bufferedText = isActiveInterviewMode ? getBufferedText() : "";
    const hasBuffer = bufferedText.length > 0;

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = true;

    setQuestion("");
    setFullResponse("");
    setCodeBlocks([]);

    let allFinalTranscripts: string[] = [];
    let interimTranscript = "";
    let isProcessing = false;
    let speechEndTimeout: NodeJS.Timeout | null = null;
    let lastResultTime = Date.now();

    const clearSpeechTimeout = () => {
      if (speechEndTimeout) {
        clearTimeout(speechEndTimeout);
        speechEndTimeout = null;
      }
    };

    const processCompleteQuestion = () => {
      if (isProcessing) return;
      
      // Combine buffered text with new transcription
      const newText = [...allFinalTranscripts, interimTranscript].filter(t => t.trim()).join(" ").trim();
      let completeQuestion = newText;
      
      if (hasBuffer && newText.length > 0) {
        // Prepend buffered text if we have both
        completeQuestion = `${bufferedText} ${newText}`.trim();
      } else if (hasBuffer && newText.length === 0) {
        // Only buffered text available
        completeQuestion = bufferedText;
      }
      
      if (completeQuestion.length > 10) {
        isProcessing = true;
        clearSpeechTimeout();
        setIsListening(false);
        setQuestion(completeQuestion);
        const statusMsg = hasBuffer 
          ? `Question (with ${bufferedText.length > 0 ? '30s buffer + ' : ''}new): ${completeQuestion.substring(0, 60)}${completeQuestion.length > 60 ? "..." : ""}`
          : `Complete question: ${completeQuestion.substring(0, 60)}${completeQuestion.length > 60 ? "..." : ""}`;
        setStatus(statusMsg);
        try { recognition.stop(); } catch {}
        addEvent({ role: 'user', content: completeQuestion, metadata: { source: 'microphone', hasBuffer: hasBuffer } });
        
        // Clear the buffer after using it
        if (hasBuffer) {
          rollingBufferRef.current = [];
        }
        
        // Start response timer when question is finalized (voice)
        const startTime = Date.now();
        setResponseTimerStart(startTime);
        timerStartRef.current = startTime;
        isTimerRunningRef.current = true;
        setIsTimerRunning(true);
        setResponseTime(null);
        
        handleQuery(completeQuestion);
      }
    };

    let retriedNoSpeech = false;

    recognition.onstart = () => {
      setStatus("Listening continuously... Speak your full question clearly.");
      setIsListening(true);
      allFinalTranscripts = [];
      interimTranscript = "";
      isProcessing = false;
      lastResultTime = Date.now();
    };
    
    recognition.onaudiostart = () => {
      setStatus("Mic active: detecting speech...");
      lastResultTime = Date.now();
    };
    
    recognition.onsoundstart = () => {
      setStatus("Sound detected. Listening...");
      clearSpeechTimeout();
    };
    
    recognition.onspeechstart = () => {
      clearSpeechTimeout();
      setStatus("Speech detected. Keep speaking...");
      lastResultTime = Date.now();
    };
    
    recognition.onspeechend = () => {
      setStatus("Pause detected. Still listening...");
      lastResultTime = Date.now();
      // Wait longer - user might be continuing
      clearSpeechTimeout();
      speechEndTimeout = setTimeout(() => {
        const timeSinceLastResult = Date.now() - lastResultTime;
        // Only process if it's been quiet for 2+ seconds
        if (timeSinceLastResult >= 2000 && !isProcessing) {
          processCompleteQuestion();
        }
      }, 2000);
    };
    
    recognition.onnomatch = () => {
      setStatus("Listening... (speaking detected but unclear)");
      clearSpeechTimeout();
    };
    
    recognition.onresult = (event: any) => {
      lastResultTime = Date.now();
      clearSpeechTimeout();
      let currentInterim = "";
      
      // Process ALL results from the beginning to capture complete transcript
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          const trimmed = transcript.trim();
          // Only add if we haven't seen this final result before
          if (trimmed && !allFinalTranscripts.includes(trimmed)) {
            allFinalTranscripts.push(trimmed);
          }
        } else {
          currentInterim = transcript;
        }
      }
      
      interimTranscript = currentInterim;
      
      // Build complete transcript for display
      const displayText = [...allFinalTranscripts, interimTranscript].filter(t => t.trim()).join(" ");
      
      // Show what we've captured so far
      if (displayText) {
        setQuestion(displayText + (currentInterim ? "..." : ""));
        const statusText = displayText.length > 0 ? `Captured: ${displayText.substring(0, 40)}...` : "Listening...";
        setStatus(statusText);
      }
      
      // Reset timeout - wait longer (2.5 seconds) after last result to ensure speech is truly complete
      clearSpeechTimeout();
      speechEndTimeout = setTimeout(() => {
        const timeSinceLastResult = Date.now() - lastResultTime;
        // Only process if it's been quiet for 2.5+ seconds
        if (timeSinceLastResult >= 2500 && !isProcessing && allFinalTranscripts.length > 0) {
          processCompleteQuestion();
        }
      }, 2500);
    };
    recognition.onerror = async (event: any) => {
      clearSpeechTimeout();
      const err = event?.error || "unknown";
      if (err === "no-speech" && !retriedNoSpeech) {
        retriedNoSpeech = true;
        setStatus("No speech detected. Trying again... Speak right after the beep.");
        // brief warmup beep simulation via status delay
        await new Promise(r => setTimeout(r, 300));
        try { recognition.start(); } catch {}
        return;
      }
      setStatus("Speech Error: " + err);
      setIsListening(false);
    };
    recognition.onend = () => {
      clearSpeechTimeout();
      setIsListening(false);
      // If we have final transcripts but haven't processed yet, do it now
      if (!isProcessing && allFinalTranscripts.length > 0) {
        processCompleteQuestion();
      } else if (!isProcessing && !allFinalTranscripts.length && (status.includes("Listening") || status.includes("Mic active"))) {
        setStatus("No speech detected. Try again.");
      }
      
      // Resume background recognition if it was active
      if (wasBackgroundActive && isActiveInterviewMode) {
        setTimeout(() => {
          startBackgroundRecognition();
        }, 500);
      }
    };

    try { recognition.start(); } catch (e) {
      console.error("recognition.start failed", e);
      setStatus("Error: Could not start microphone.");
    }
  }, [isSpeechSupported, status, handleQuery, requestMicPermission, addEvent, isActiveInterviewMode, getBufferedText, startBackgroundRecognition]);

  return (
    <div className="min-h-screen bg-gray-800 text-white p-4 sm:p-8 flex items-start justify-center font-sans">
      <div className="w-full max-w-6xl flex gap-4">
        {/* Left column: Ask button fixed on the left */}
        <div className="flex-shrink-0 sticky top-6 self-start">
          {/* Interview Round Selector */}
          <div className="mb-4 w-72 bg-gray-700 p-3 rounded-lg shadow-inner">
            <p className="text-sm font-medium text-gray-300 mb-2">Interview Round</p>
            <div className="grid grid-cols-7 gap-1">
              {[1, 2, 3, 4, 5, 6, 7].map((round) => (
                <button
                  key={round}
                  onClick={() => {
                    setInterviewRound(round);
                    setStatus(`Selected Round ${round}`);
                  }}
                  className={`px-2 py-2 rounded-md text-xs font-semibold transition ${
                    interviewRound === round
                      ? "bg-emerald-600 text-white shadow-lg"
                      : "bg-gray-600 text-gray-300 hover:bg-gray-500"
                  }`}
                  title={`Round ${round}`}
                >
                  {round}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-gray-400">
              Questions and responses stored separately per round
            </p>
          </div>

          {/* Interview Mode Selector */}
          <div className="mb-4 w-72 bg-gray-700 p-3 rounded-lg shadow-inner">
            <p className="text-sm font-medium text-gray-300 mb-2">Interview Mode</p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setInterviewMode("qa");
                  setProceduralSteps([]);
                  setStatus("Switched to Question & Answer mode");
                }}
                className={`flex-1 px-3 py-2 rounded-md text-xs font-semibold transition ${
                  interviewMode === "qa"
                    ? "bg-emerald-600 text-white shadow-lg"
                    : "bg-gray-600 text-gray-300 hover:bg-gray-500"
                }`}
              >
                Q&A Interview
              </button>
              <button
                onClick={() => {
                  setInterviewMode("procedural");
                  setProceduralSteps([]);
                  setStatus("Switched to Procedural Interview mode");
                }}
                className={`flex-1 px-3 py-2 rounded-md text-xs font-semibold transition ${
                  interviewMode === "procedural"
                    ? "bg-emerald-600 text-white shadow-lg"
                    : "bg-gray-600 text-gray-300 hover:bg-gray-500"
                }`}
              >
                Procedural Interview
              </button>
            </div>
            <p className="mt-2 text-[10px] text-gray-400">
              {interviewMode === "qa" 
                ? "Standard Q&A format for conversational responses"
                : "Step-by-step process format for practical interviews"}
            </p>
          </div>

          {/* Active Interview Mode Toggle */}
          <div className="mb-4 w-72 bg-gray-700 p-3 rounded-lg shadow-inner">
            <p className="text-sm font-medium text-gray-300 mb-2">Active Interview</p>
            <button
              onClick={() => {
                const newMode = !isActiveInterviewMode;
                setIsActiveInterviewMode(newMode);
                setStatus(newMode 
                  ? "Active Interview mode enabled: Mic passively collecting last 30 seconds"
                  : "Active Interview mode disabled");
              }}
              className={`w-full px-4 py-3 rounded-md text-sm font-semibold transition flex items-center justify-center gap-2 ${
                isActiveInterviewMode
                  ? "bg-blue-600 text-white shadow-lg hover:bg-blue-500"
                  : "bg-gray-600 text-gray-300 hover:bg-gray-500"
              }`}
              title={isActiveInterviewMode 
                ? "Active Interview mode is ON - Mic passively collecting last 30 seconds"
                : "Click to enable Active Interview mode - Mic will passively collect last 30 seconds"}
            >
              {isActiveInterviewMode ? (
                <>
                  <span className="animate-pulse">🔴</span>
                  <span>Active Interview ON</span>
                </>
              ) : (
                <>
                  <span>⚪</span>
                  <span>Active Interview OFF</span>
                </>
              )}
            </button>
            <p className="mt-2 text-[10px] text-gray-400">
              {isActiveInterviewMode 
                ? "Mic passively collecting last 30 seconds. Click mic button to include buffer in question."
                : "Enable to passively collect last 30 seconds from mic"}
            </p>
          </div>

          <button
            onClick={startListening}
            disabled={
              !hasMounted ||
              !isSpeechSupported ||
              isListening ||
              isGeneratingResponse ||
              isGeneratingDeeper ||
              isGeneratingClarifying
            }
            className={`p-5 rounded-full shadow-lg transition duration-200 ease-in-out flex items-center space-x-2 text-xl font-bold ${
              !hasMounted ||
              !isSpeechSupported ||
              isListening ||
              isGeneratingResponse ||
              isGeneratingDeeper ||
              isGeneratingClarifying
                ? "bg-gray-500 cursor-not-allowed"
                : "bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 transform hover:scale-105"
            }`}
            aria-label="Start listening for question"
            title={
              !hasMounted ? "Initializing..." :
              !isSpeechSupported ? "Speech Recognition not supported" :
              isListening ? "Currently listening" :
              isGeneratingResponse ? "Generating response" :
              isGeneratingDeeper ? "Generating deeper answer" :
              isGeneratingClarifying ? "Generating clarifying questions" :
              "Click to start listening"
            }
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

          {/* Profiles management */}
          <div className="mt-4 w-72 bg-gray-700 p-3 rounded-lg shadow-inner">
            <p className="text-sm font-medium text-gray-300 mb-2">Company Profiles</p>
            <select
              value={selectedProfileId}
              onChange={(e) => selectProfile(e.target.value)}
              className="w-full bg-gray-800 text-white p-2 rounded-md border border-gray-600 focus:border-emerald-500"
            >
              <option value="">— Select a profile —</option>
              {profiles
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <input
              type="text"
              value={profileNameInput}
              onChange={(e) => setProfileNameInput(e.target.value)}
              placeholder="Profile name (e.g., Acme - SecOps)"
              className="mt-2 w-full bg-gray-800 text-white p-2 rounded-md border border-gray-600 focus:border-emerald-500"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={saveCurrentAsProfile}
                className="px-3 py-2 rounded-md text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow"
              >
                Save Profile
              </button>
              <button
                onClick={newProfile}
                className="px-3 py-2 rounded-md text-xs font-semibold bg-gray-600 hover:bg-gray-500 text-white shadow"
              >
                New
              </button>
              <button
                onClick={deleteProfile}
                className="px-3 py-2 rounded-md text-xs font-semibold bg-red-600 hover:bg-red-500 text-white shadow disabled:opacity-50"
                disabled={!selectedProfileId}
              >
                Delete
              </button>
            </div>
            <p className="mt-1 text-[10px] text-gray-400">Select a profile to auto-fill the Company and Job fields. Save to create/update.</p>
          </div>

          {/* Clarifying button under Ask Question */}
          <div className="mt-4">
            <button
              onClick={() => question && generateClarifyingQuestions(question)}
              disabled={isGeneratingClarifying || !question}
              className={`px-6 py-3 text-base font-semibold rounded-lg transition shadow-lg ${
                isGeneratingClarifying || !question
                  ? "bg-gray-500 cursor-not-allowed text-gray-300"
                  : "bg-purple-600 hover:bg-purple-500 active:bg-purple-700 text-white"
              }`}
            >
              {isGeneratingClarifying ? (
                <span className="flex items-center gap-2">
                  <span className="animate-spin">⏳</span> Generating Clarifying Questions...
                </span>
              ) : (
                "Generate Clarifying Questions"
              )}
            </button>
          </div>

          {/* Clarifying Questions list under the button */}
          {clarifyingQuestions.length > 0 && (
            <div className="mt-4 bg-gray-700 p-3 rounded-lg shadow-inner w-72">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-purple-300">Clarifying Questions:</p>
                <button
                  onClick={() => setClarifyingQuestions([])}
                  className="text-xs text-gray-400 hover:text-gray-200"
                >
                  Clear
                </button>
              </div>
              <div className="space-y-2 max-h-64 overflow-auto pr-1">
                {clarifyingQuestions.map((clarifyingQ, index) => (
                  <button
                    key={index}
                    onClick={() => useClarifyingQuestion(clarifyingQ, question)}
                    className="w-full text-left bg-gray-800 hover:bg-gray-750 p-2 rounded-md border border-purple-500/30 hover:border-purple-400 transition text-xs text-purple-200 hover:text-purple-100"
                  >
                    <span className="font-medium text-purple-400 mr-1">→</span>
                    {clarifyingQ}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-300 mt-2 italic">
                Click a clarifying question - it will listen for your clarification response
              </p>
            </div>
          )}

          {/* Manual typed question input */}
          <div className="mt-4 w-72 bg-gray-700 p-3 rounded-lg shadow-inner">
            <p className="text-sm font-medium text-gray-300 mb-2">Type a question</p>
            <textarea
              value={typedQuestion}
              onChange={(e) => setTypedQuestion(e.target.value)}
              rows={3}
              placeholder="Type your interview question here..."
              className="w-full resize-none rounded-md bg-gray-800 text-white p-2 outline-none border border-gray-600 focus:border-emerald-500"
            />
            <div className="mt-2 flex justify-end">
              <button
                onClick={() => typedQuestion.trim() && handleQuery(typedQuestion.trim())}
                disabled={!typedQuestion.trim() || status.includes("Generating")}
                className={`px-4 py-2 rounded-md text-sm font-medium transition ${
                  !typedQuestion.trim() || status.includes("Generating")
                    ? "bg-gray-500 cursor-not-allowed text-gray-200"
                    : "bg-emerald-600 hover:bg-emerald-500 text-white"
                }`}
              >
                Submit Question
              </button>
            </div>
          </div>

          {/* About Company input */}
          <div className="mt-4 w-72 bg-gray-700 p-3 rounded-lg shadow-inner">
            <p className="text-sm font-medium text-gray-300 mb-2">About the Company (optional)</p>
            <textarea
              value={aboutCompany}
              onChange={(e) => setAboutCompany(e.target.value)}
              rows={4}
              placeholder="Paste company background here to tailor context..."
              className="w-full resize-none rounded-md bg-gray-800 text-white p-2 outline-none border border-gray-600 focus:border-emerald-500"
            />
            <p className="mt-1 text-[10px] text-gray-400">This will be included as company context for all answers.</p>
          </div>

          {/* Job description input */}
          <div className="mt-4 w-72 bg-gray-700 p-3 rounded-lg shadow-inner">
            <p className="text-sm font-medium text-gray-300 mb-2">Job Description (optional)</p>
            <textarea
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              rows={6}
              placeholder="Paste the job description here to tailor responses..."
              className="w-full resize-none rounded-md bg-gray-800 text-white p-2 outline-none border border-gray-600 focus:border-emerald-500"
            />
            <p className="mt-1 text-[10px] text-gray-400">This will be used to tailor all future answers.</p>
          </div>

          {/* Technical Information input */}
          <div className="mt-4 w-72 bg-gray-700 p-3 rounded-lg shadow-inner">
            <p className="text-sm font-medium text-gray-300 mb-2">Technical Information (optional)</p>
            <textarea
              value={technicalInfo}
              onChange={(e) => setTechnicalInfo(e.target.value)}
              rows={6}
              placeholder="Add any technical information relevant to the job (tools, technologies, specific requirements)..."
              className="w-full resize-none rounded-md bg-gray-800 text-white p-2 outline-none border border-gray-600 focus:border-emerald-500"
            />
            <p className="mt-1 text-[10px] text-gray-400">This will be included to tailor technical responses.</p>
          </div>

          {/* Technical Q&A Management */}
          <div className="mt-4 w-72 bg-gray-700 p-3 rounded-lg shadow-inner">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-gray-300">Technical Q&A (per profile)</p>
              <button
                onClick={addTechnicalQA}
                className="px-2 py-1 rounded text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white"
                title="Add new Q&A pair"
              >
                + Add
              </button>
            </div>
            <p className="text-[10px] text-gray-400 mb-3">
              Add questions and answers that will be available when this profile is active.
            </p>
            
            <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
              {technicalQAs.length === 0 ? (
                <p className="text-xs text-gray-500 italic">No Q&A pairs added yet. Click "Add" to add one.</p>
              ) : (
                technicalQAs.map((qa, index) => (
                  <div key={qa.id} className="bg-gray-800 p-3 rounded-md border border-gray-600">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-gray-400">Q&A #{index + 1}</span>
                      <button
                        onClick={() => removeTechnicalQA(qa.id)}
                        className="text-xs text-red-400 hover:text-red-300"
                        title="Remove this Q&A pair"
                      >
                        Remove
                      </button>
                    </div>
                    <div className="space-y-2">
                      <div>
                        <label className="text-xs text-gray-400 mb-1 block">Question:</label>
                        <textarea
                          value={qa.question}
                          onChange={(e) => updateTechnicalQA(qa.id, 'question', e.target.value)}
                          rows={2}
                          placeholder="Enter technical question..."
                          className="w-full resize-none rounded-md bg-gray-900 text-white p-2 text-xs outline-none border border-gray-700 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-400 mb-1 block">Answer:</label>
                        <textarea
                          value={qa.answer}
                          onChange={(e) => updateTechnicalQA(qa.id, 'answer', e.target.value)}
                          rows={4}
                          placeholder="Enter detailed answer (include commands, queries, code snippets as needed)..."
                          className="w-full resize-none rounded-md bg-gray-900 text-white p-2 text-xs outline-none border border-gray-700 focus:border-blue-500"
                        />
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right column: main content card */}
        <div className="flex-1 bg-gray-700 p-6 sm:p-8 rounded-2xl shadow-xl space-y-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-center text-emerald-400">
            AI Interview Assistant
          </h1>

        <div className="flex flex-col items-center">
          <div className="w-full flex items-center justify-between mb-2">
            <h2 className="text-xl font-semibold text-gray-300">
              Response Display
            </h2>
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-400">
                Speed: {readingSpeed} chars/sec
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
                {readingSpeed < 10 ? "Slow" : readingSpeed < 20 ? "Medium" : "Fast"} ({Math.round(readingSpeed * 12)} WPM)
              </span>
            </div>
          </div>
          <div className="w-full grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Left side - Scrolling text */}
            <div className="flex flex-col lg:col-span-2">
              
              <h3 className="text-sm font-medium text-gray-400 mb-2">
                {interviewMode === "procedural" ? "Procedural Steps" : "Narrative Response"}
              </h3>
              
              {interviewMode === "procedural" && proceduralSteps.length > 0 ? (
                // Procedural mode: Display steps
                <div className="bg-gray-800 p-6 rounded-lg border-2 border-emerald-500 shadow-xl space-y-4 max-h-[600px] overflow-y-auto">
                  {proceduralSteps.map((step, index) => (
                    <div key={index} className="bg-gray-700 p-4 rounded-lg border-l-4 border-emerald-400">
                      <div className="flex items-start gap-3">
                        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-600 text-white font-bold flex items-center justify-center">
                          {index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-white text-base leading-relaxed whitespace-pre-wrap break-words" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                            {step.split(/(```[\s\S]*?```|`[^`\n]+`)/g).map((part, partIndex) => {
                              if (part.match(/^```[\s\S]*?```$/)) {
                                // Code block
                                const code = part.replace(/```[\w]*\n?/g, '').trim();
                                return (
                                  <code key={partIndex} className="block mt-2 mb-2 p-3 bg-gray-900 text-emerald-300 rounded border border-emerald-600 font-mono text-sm whitespace-pre-wrap break-words" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                                    {code}
                                  </code>
                                );
                              } else if (part.match(/^`[^`\n]+`$/)) {
                                // Inline command
                                const cmd = part.replace(/`/g, '');
                                return (
                                  <code key={partIndex} className="px-2 py-1 bg-gray-900 text-blue-300 rounded border border-blue-600 text-sm font-mono break-words" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                                    {cmd}
                                  </code>
                                );
                              } else {
                                return <span key={partIndex} className="break-words" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{part}</span>;
                              }
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : interviewMode === "procedural" ? (
                // Procedural mode but no steps yet
                <div className="bg-gray-800 p-6 rounded-lg border-2 border-gray-600 text-center">
                  <p className="text-gray-400 italic">Ask a procedural question to see step-by-step process...</p>
                </div>
              ) : (
                // Q&A mode: Scrolling text display
                <ScrollingTextDisplay 
                  fullText={scrollingPrompt || fullResponse} 
                  readingSpeed={readingSpeed}
                  onScrollingStart={handleScrollingStart}
                />
              )}
              {fullResponse && interviewMode === "qa" && (
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={generateDeeperAnswer}
                    disabled={isGeneratingDeeper}
                    className={`px-4 py-2 rounded-md text-sm font-medium transition shadow ${
                      isGeneratingDeeper
                        ? "bg-gray-500 cursor-not-allowed text-gray-200"
                        : "bg-emerald-600 hover:bg-emerald-500 text-white"
                    }`}
                    aria-label="Generate a deeper, more specific answer"
                  >
                    {isGeneratingDeeper ? "Deepening..." : "Go deeper on this answer"}
                  </button>
                </div>
              )}

              {/* Moved below the scrolling text: Status and Your Question */}
              <div className="mt-4 space-y-4">
                <div className="bg-gray-600 p-3 rounded-lg shadow-inner">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-300">Current Status:</p>
                    {(isTimerRunning || responseTime !== null) && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400">Response Time:</span>
                        <span className={`font-mono text-sm font-semibold ${
                          isTimerRunning ? "text-yellow-400 animate-pulse" : "text-green-400"
                        }`}>
                          {formatResponseTime(responseTime)}
                        </span>
                      </div>
                    )}
                  </div>
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

                

                <div className="bg-gray-600 p-3 rounded-lg shadow-inner">
              <div className="flex items-center justify-start gap-3 mb-2">
                <p className="text-sm font-medium text-gray-300">Your Question:</p>
              </div>
                  <div className="min-h-[3rem] overflow-y-auto">
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
              </div>
            </div>
            {/* Right side - Code blocks/Commands */}
            <div className="flex flex-col">
              <h3 className="text-sm font-medium text-gray-400 mb-2">Technical Commands & Queries</h3>
              {codeBlocks.length > 0 ? (
                <div className="h-48 w-full bg-gray-900 border-4 border-blue-500 p-4 shadow-2xl rounded-xl overflow-y-auto space-y-3">
                  {codeBlocks.map((block, index) => (
                    <div key={index} className="bg-gray-800 p-3 rounded-lg border border-blue-400">
                      <pre className="text-sm text-blue-300 font-mono whitespace-pre-wrap break-words">
                        {block}
                      </pre>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="h-48 w-full bg-gray-900 border-4 border-blue-500 p-6 shadow-2xl rounded-xl overflow-hidden flex items-center justify-center">
                  <p className="text-sm text-blue-300 italic">
                    No technical commands or queries in this response
                  </p>
                </div>
              )}

              {/* Transcript actions */}
              <div className="mt-4 flex items-center gap-3 flex-wrap">
                <button
                  onClick={downloadTranscript}
                  className="px-4 py-2 rounded-md text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow"
                >
                  Download JSON Transcript
                </button>
                <button
                  onClick={downloadPlainTranscript}
                  className="px-4 py-2 rounded-md text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow"
                >
                  Download Text Transcript
                </button>
                <button
                  onClick={clearTranscript}
                  className="px-4 py-2 rounded-md text-sm font-semibold bg-gray-600 hover:bg-gray-500 text-white shadow"
                >
                  Clear Transcript
                </button>
                <button
                  onClick={clearStoredResponses}
                  className="px-4 py-2 rounded-md text-sm font-semibold bg-orange-600 hover:bg-orange-500 text-white shadow"
                  title={`Clear stored responses for current profile (Round ${interviewRound})`}
                >
                  Clear Stored Responses
                </button>
                {!isSessionRecording ? (
                  <button
                    onClick={startRecordingSession}
                    className="px-4 py-2 rounded-md text-sm font-semibold bg-red-600 hover:bg-red-500 text-white shadow"
                  >
                    ● Start Recording Session
                  </button>
                ) : (
                  <button
                    onClick={stopRecordingSession}
                    className="px-4 py-2 rounded-md text-sm font-semibold bg-red-700 hover:bg-red-600 text-white shadow"
                  >
                    ■ Stop & Download Transcript
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        {/* Close items-center wrapper */}
        </div>

        
      </div>
    </div>
  );
};

export default App;
