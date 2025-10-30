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
interface CompanyProfile {
  id: string;
  name: string;
  aboutCompany: string;
  jobDescription: string;
  updatedAt: number;
}
const PROFILES_STORAGE_KEY = 'aiInterviewProfiles';

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

// --- Extract code blocks from text ---
function extractCodeBlocks(text: string): { cleanText: string; codeBlocks: string[] } {
  // This regex finds code blocks AND optionally the preamble like 'The query I created was:' right before them
  const blockPattern = /(\b(The query I created was:|The command I used was:|Here is the query:|Here is the command:|The command was:|The SPL query was:)[\s:]*\n*)?(```[\s\S]*?```)/gi;
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks: string[] = [];
  let cleanText = text;

  // Track replacements to avoid duplicates
  let replacedSpans: { start: number; end: number }[] = [];

  // Find blocks with optional preambles
  cleanText = cleanText.replace(blockPattern, (match, p1, preamble, codeBlock, offset) => {
    // Always extract the code (removing triple backticks etc)
    const cleanBlock = codeBlock
      .replace(/^```[a-zA-Z]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    codeBlocks.push(cleanBlock);
    // If there was a preamble, insert the placeholder
    if (preamble) {
      return `${preamble.trim()} (pause)`;
    }
    // If just code block, remove it from text
    return "";
  });

  // Remove any leftover code blocks standing alone
  cleanText = cleanText.replace(codeBlockRegex, "").trim();

  // Clean up extra whitespace/newlines
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, codeBlocks };
}

// --- Scrolling Text Display ---
interface ScrollingTextDisplayProps {
  fullText: string;
  readingSpeed?: number; // Base characters per second
}

const PAUSE_REGEX = /(\(pause\))/gi;

const ScrollingTextDisplay: React.FC<ScrollingTextDisplayProps> = ({
  fullText,
  readingSpeed = 12, // Base: ~12 characters per second (adjustable)
}) => {
  const textRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const pausedElapsedRef = useRef<number>(0); // Track elapsed time when paused
  const isPausedRef = useRef<boolean>(false); // Use ref to check pause state in animation loop
  const [isPaused, setIsPaused] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);

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

    // Measure text and container
    const textWidth = textRef.current.scrollWidth;
    const containerWidth = containerRef.current.clientWidth;
    const startPosition = containerWidth;
    const endPosition = -textWidth;
    const totalDistance = textWidth + containerWidth;

    // Calculate total duration based on reading speed
    const pixelsPerCharacter = 18;
    const totalCharacters = fullText.length;
    const basePixelsPerSecond = readingSpeed * pixelsPerCharacter;
    
    // Adjust for content complexity
    let speedMultiplier = 1.0;
    const hasLongWords = /\w{8,}/.test(fullText);
    const punctuationCount = (fullText.match(/[.,!?;:]/g) || []).length;
    if (hasLongWords) speedMultiplier *= 0.9;
    if (punctuationCount > totalCharacters * 0.05) speedMultiplier *= 0.95;
    
    const adjustedPixelsPerSecond = basePixelsPerSecond * speedMultiplier;
    const totalDuration = totalDistance / adjustedPixelsPerSecond;

    // Reset position to start
    if (textRef.current) {
      textRef.current.style.transform = `translateX(${startPosition}px)`;
    }

    // Start animation
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
      
      // Calculate current position (linear interpolation)
      const progress = Math.min(elapsed / totalDuration, 1);
      const currentX = startPosition + (endPosition - startPosition) * progress;
      
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
  const [hasMounted, setHasMounted] = useState(false);
  const [readingSpeed, setReadingSpeed] = useState(12); // Characters per second

  // Recording session state
  const [isSessionRecording, setIsSessionRecording] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);

  // Profiles state
  const [profiles, setProfiles] = useState<CompanyProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [profileNameInput, setProfileNameInput] = useState<string>("");

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

  const downloadTranscript = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      aboutCompany,
      jobDescription,
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
  }, [conversation, aboutCompany, jobDescription]);

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
    lines.push("");
    for (const evt of conversation) {
      const role = evt.role.toUpperCase();
      lines.push(`[${formatTime(evt.timestamp)}] ${role}:`);
      lines.push(evt.content);
      lines.push("");
    }
    return lines.join("\n");
  }, [conversation, aboutCompany, jobDescription]);

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

  useEffect(() => setHasMounted(true), []);

  // Load profiles from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CompanyProfile[];
        setProfiles(Array.isArray(parsed) ? parsed : []);
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
        updatedAt: Date.now(),
      };
      setProfiles(prev => [newProfile, ...prev]);
      setSelectedProfileId(newProfile.id);
      setStatus(`Saved new profile: ${name}`);
    }
  }, [profileNameInput, aboutCompany, jobDescription, selectedProfileId]);

  const newProfile = useCallback(() => {
    setSelectedProfileId("");
    setProfileNameInput("");
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
    setStatus(`Deleted profile${p ? `: ${p.name}` : ''}.`);
  }, [selectedProfileId, profiles]);

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
      const clarifyingPrompt = `Based on this interview question, generate 3-4 concise clarifying questions that would help understand what specific direction or angle the interviewer wants the answer to take. The clarifying questions should be short (one sentence each) and focused on different aspects (technical depth, specific examples, industry context, etc.).\n\nOriginal question: "${originalQuestion}"\n${aboutCompany.trim() ? `Company context (about company):\n${aboutCompany.trim()}\n` : ""}\n\nGenerate clarifying questions as a simple list, one per line, without numbering or bullets.`;

      const clarifyingText = await generateText(clarifyingPrompt);
      
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
  }, [aboutCompany, addEvent]);

  const handleQuery = useCallback(async (query: string, isClarification: boolean = false) => {
    if (!query || query.trim().length < 5) {
      setStatus("Query is too short or empty. Cannot proceed.");
      return;
    }

    console.log("📝 Full question being processed:", query);
    console.log("📏 Question length:", query.length, "characters");

    if (!isClarification) {
      addEvent({ role: 'user', content: query });
    } else {
      addEvent({ role: 'clarifying', content: query, metadata: { phase: 'combined_prompt' } });
    }

    setStatus("Generating response...");
    if (!isClarification) {
      setFullResponse("");
      setClarifyingQuestions([]);
    }

    try {
      const fullQuery = query.trim();
      const companyContext = aboutCompany.trim() ? `Company context (about company):\n${aboutCompany.trim()}\n` : "";
      const roleContext = jobDescription.trim() ? `Role context (job description):\n${jobDescription.trim()}\n` : "";
      const rolePreamble =
        (companyContext || roleContext
          ? `${companyContext}${roleContext}\nAnswer the interview question tailored to this context. Keep it spoken-style and aim for ~30 seconds (~70–90 words).\n\nInterview question: ${fullQuery}`
          : `Answer in ~30 seconds (~70–90 words), spoken-style.\n\nInterview question: ${fullQuery}`);
      const generatedText = await generateText(rolePreamble);

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
        addEvent({ role: 'assistant', content: '[No response generated]' });
        return;
      }

      let { cleanText, codeBlocks: extractedBlocks } = extractCodeBlocks(generatedText);
      
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

      addEvent({ role: 'assistant', content: cleanText, metadata: { codeBlocks: extractedBlocks } });
    } catch (error: any) {
      console.error("Query process failed:", error);
      setFullResponse("A network or API error occurred. Check the console.");
      setStatus("Failed: API communication failed. See console.");
      addEvent({ role: 'assistant', content: '[API error]' });
    }
  }, [jobDescription, aboutCompany, addEvent]);

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

      const deeperPrompt = `The interviewer asked the following question and the candidate answered. Please produce a deeper, more specific answer that builds directly on the existing answer. Add technical specifics, trade-offs, concrete examples, concise metrics, and relevant tools or methods where appropriate. Keep it conversational, spoken-style, and target ~30 seconds (~70–90 words).\n\nOriginal question: "${question}"\n\n${aboutCompany.trim() ? `Company context (about company):\n${aboutCompany.trim()}\n` : ""}${jobDescription.trim() ? `Role context (job description):\n${jobDescription.trim()}\n` : ""}\n\nExisting answer: "${fullResponse}"\n\nNow provide a refined, deeper answer that assumes the listener heard the existing answer and expands on the most important specifics (without repeating filler).`;

      const generatedText = await generateText(deeperPrompt);
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
      addEvent({ role: 'assistant', content: cleanText, metadata: { codeBlocks: extractedBlocks, type: 'deeper' } });
    } catch (e) {
      console.error("Deeper generation failed:", e);
      setStatus("Failed to generate deeper answer.");
      addEvent({ role: 'assistant', content: '[Deeper generation failed]' });
    } finally {
      setIsGeneratingDeeper(false);
    }
  }, [question, fullResponse, jobDescription, aboutCompany, addEvent]);

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
        
        const combinedPrompt = `Based on this original interview answer, the interviewer asked a clarifying question, and the candidate provided additional information. Please provide a refined, comprehensive answer that incorporates both the original response and the new clarification.\n\nOriginal question: "${originalQuestion}"\n\nOriginal answer: "${originalAnswer}"\n\nClarifying question asked: "${clarifyingQuestion}"\n\nClarification provided: "${clarificationAnswer}"\n\nPlease provide a refined answer that:\n1. Maintains the key points from the original answer\n2. Integrates the new information from the clarification\n3. Provides a more complete and targeted response\n 4. Stays conversational and natural\n${jobDescription.trim() ? `\nRole context (job description):\n${jobDescription.trim()}\n` : ""}${aboutCompany.trim() ? `Company context (about company):\n${aboutCompany.trim()}\n` : ""}`;

        setScrollingPrompt("");
        handleQuery(combinedPrompt, true);
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
  }, [isSpeechSupported, requestMicPermission, handleQuery, jobDescription, aboutCompany, status, addEvent]);

  const startListening = useCallback(async () => {
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
      
      const completeQuestion = [...allFinalTranscripts, interimTranscript].filter(t => t.trim()).join(" ").trim();
      
      if (completeQuestion.length > 10) {
        isProcessing = true;
        clearSpeechTimeout();
        setQuestion(completeQuestion);
        setStatus("Complete question: " + completeQuestion.substring(0, 60) + (completeQuestion.length > 60 ? "..." : ""));
        try { recognition.stop(); } catch {}
        addEvent({ role: 'user', content: completeQuestion, metadata: { source: 'microphone' } });
        handleQuery(completeQuestion);
      }
    };

    let retriedNoSpeech = false;

    recognition.onstart = () => {
      setStatus("Listening continuously... Speak your full question clearly.");
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
    };
    recognition.onend = () => {
      clearSpeechTimeout();
      // If we have final transcripts but haven't processed yet, do it now
      if (!isProcessing && allFinalTranscripts.length > 0) {
        processCompleteQuestion();
      } else if (!isProcessing && !allFinalTranscripts.length && (status.includes("Listening") || status.includes("Mic active"))) {
        setStatus("No speech detected. Try again.");
      }
    };

    try { recognition.start(); } catch (e) {
      console.error("recognition.start failed", e);
      setStatus("Error: Could not start microphone.");
    }
  }, [isSpeechSupported, status, handleQuery, requestMicPermission, addEvent]);

  return (
    <div className="min-h-screen bg-gray-800 text-white p-4 sm:p-8 flex items-start justify-center font-sans">
      <div className="w-full max-w-6xl flex gap-4">
        {/* Left column: Ask button fixed on the left */}
        <div className="flex-shrink-0 sticky top-6 self-start">
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
          <div className="w-full grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Left side - Scrolling text */}
            <div className="flex flex-col lg:col-span-2">
              
              <h3 className="text-sm font-medium text-gray-400 mb-2">Narrative Response</h3>
              <ScrollingTextDisplay fullText={scrollingPrompt || fullResponse} readingSpeed={readingSpeed} />
              {fullResponse && (
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
