import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    return NextResponse.json({ error: "Missing GEMINI_API_KEY" }, { status: 500 });
  }

  const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models/";
  const GEMINI_MODEL = "gemini-2.5-flash";
  const apiUrl = `${BASE_URL}${GEMINI_MODEL}:streamGenerateContent?key=${apiKey}`;

  try {
    console.error("🧪 TEST: Calling Gemini API...");
    console.error("🧪 TEST: URL:", apiUrl.replace(/key=[^&]+/, 'key=***'));
    
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Say hello" }] }],
        generationConfig: { maxOutputTokens: 100 },
      }),
    });

    console.error("🧪 TEST: Response status:", response.status);
    console.error("🧪 TEST: Response OK:", response.ok);
    console.error("🧪 TEST: Has body:", !!response.body);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("🧪 TEST: Error response:", errorText);
      return NextResponse.json({ error: errorText, status: response.status }, { status: response.status });
    }

    if (!response.body) {
      return NextResponse.json({ error: "No response body" }, { status: 500 });
    }

    // Read the stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let chunkCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        chunkCount++;
        const chunk = decoder.decode(value, { stream: true });
        console.error(`🧪 TEST: Chunk ${chunkCount}:`, chunk.substring(0, 200));
        
        const lines = chunk.split('\n').filter(line => line.trim());
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
              if (text) {
                fullText += text;
                console.error(`🧪 TEST: Found text chunk:`, text);
              }
            } catch (e) {
              console.error(`🧪 TEST: Parse error:`, e);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    console.error("🧪 TEST: Full text:", fullText);
    console.error("🧪 TEST: Total chunks:", chunkCount);

    return NextResponse.json({
      success: true,
      text: fullText || "No text extracted",
      chunkCount,
    });
  } catch (error: any) {
    console.error("🧪 TEST: Exception:", error);
    return NextResponse.json({
      error: error.message,
      stack: error.stack,
    }, { status: 500 });
  }
}












