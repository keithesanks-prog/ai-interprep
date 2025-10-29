import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models/";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const prompt = body?.prompt;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.error("❌ Missing GEMINI_API_KEY in environment.");
      return NextResponse.json(
        { error: "Missing GEMINI_API_KEY in environment" },
        { status: 500 }
      );
    }

    if (!prompt || typeof prompt !== "string") {
      console.error("❌ Invalid prompt:", prompt);
      return NextResponse.json(
        { error: "Invalid or missing 'prompt' in request body" },
        { status: 400 }
      );
    }

    const apiUrl = `${BASE_URL}${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    console.log("📡 Calling Gemini with prompt:", prompt);

    const geminiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: {
          parts: [
            {
              text: "You are a concise interview assistant. Provide clear, professional spoken-style responses.",
            },
          ],
        },
      }),
    });

    const text = await geminiResponse.text(); // read *raw* response for debugging

    if (!geminiResponse.ok) {
      console.error("❌ Gemini returned error response:", text);
      return NextResponse.json(
        { error: text || "Gemini API error" },
        { status: geminiResponse.status }
      );
    }

    console.log("✅ Gemini returned OK response.");
    // Try to parse JSON only after success
    try {
      const data = JSON.parse(text);
      return NextResponse.json(data);
    } catch (err) {
      console.error("⚠️ Failed to parse Gemini JSON:", err);
      return NextResponse.json(
        { error: "Invalid JSON from Gemini", raw: text },
        { status: 500 }
      );
    }
  } catch (err: any) {
    console.error("💥 /api/generate route crashed:", err);
    return NextResponse.json(
      { error: err.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}
