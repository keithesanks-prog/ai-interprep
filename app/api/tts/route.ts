import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TTS_MODEL = "gemini-2.5-flash-preview-tts";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models/";

export async function POST(request: Request) {
  try {
    const { text } = await request.json();
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.error("❌ Missing GEMINI_API_KEY in environment.");
      return NextResponse.json({ error: "Missing API key" }, { status: 500 });
    }

    if (!text) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }

    const apiUrl = `${BASE_URL}${TTS_MODEL}:generateContent?key=${apiKey}`;
    console.log("📡 Sending text to Gemini TTS:", text.slice(0, 40) + "...");

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
        },
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Rasalgethi" },
        },
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      console.error("❌ Gemini TTS error:", raw);
      return NextResponse.json({ error: raw }, { status: response.status });
    }

    const data = JSON.parse(raw);
    const part = data?.candidates?.[0]?.content?.parts?.[0];
    const audioData = part?.inlineData?.data;

    if (!audioData) {
      console.error("❌ No inlineData in TTS response:", data);
      return NextResponse.json(
        { error: "No audio returned from Gemini TTS" },
        { status: 500 }
      );
    }

    return NextResponse.json({ audioData });
  } catch (err: any) {
    console.error("💥 /api/tts route crashed:", err);
    return NextResponse.json(
      { error: err.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}
