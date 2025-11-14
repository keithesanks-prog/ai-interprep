import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Speech-to-Text API route using AssemblyAI
 * More reliable than Web Speech API, works in Electron and regular browsers
 * 
 * Setup: Get a free API key from https://www.assemblyai.com/
 * Add ASSEMBLYAI_API_KEY to .env.local
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get("audio") as File;
    let languageCode = formData.get("language") as string || "en-US";
    
    // Convert language codes to AssemblyAI format (e.g., "en-US" -> "en")
    if (languageCode.includes("-")) {
      languageCode = languageCode.split("-")[0];
    }

    if (!audioFile) {
      return NextResponse.json(
        { error: "No audio file provided" },
        { status: 400 }
      );
    }

    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    
    if (!apiKey) {
      return NextResponse.json(
        { 
          error: "AssemblyAI API key not configured",
          message: "Add ASSEMBLYAI_API_KEY to .env.local. Get a free key at https://www.assemblyai.com/",
          fallback: true
        },
        { status: 500 }
      );
    }

    // Convert audio file to buffer
    const arrayBuffer = await audioFile.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    // Upload audio to AssemblyAI
    const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
      method: "POST",
      headers: {
        authorization: apiKey,
      },
      body: audioBuffer,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error("AssemblyAI upload error:", errorText);
      return NextResponse.json(
        { error: `Failed to upload audio: ${errorText}` },
        { status: uploadResponse.status }
      );
    }

    const { upload_url } = await uploadResponse.json();

    // Start transcription
    const transcriptResponse = await fetch("https://api.assemblyai.com/v2/transcript", {
      method: "POST",
      headers: {
        authorization: apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        audio_url: upload_url,
        language_code: languageCode,
        punctuate: true,
        format_text: true,
      }),
    });

    if (!transcriptResponse.ok) {
      const errorText = await transcriptResponse.text();
      console.error("AssemblyAI transcript error:", errorText);
      return NextResponse.json(
        { error: `Failed to start transcription: ${errorText}` },
        { status: transcriptResponse.status }
      );
    }

    const { id } = await transcriptResponse.json();

    // Poll for transcription result
    let transcript = null;
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max wait

    while (!transcript && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second

      const statusResponse = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
        headers: {
          authorization: apiKey,
        },
      });

      const statusData = await statusResponse.json();

      if (statusData.status === "completed") {
        transcript = statusData.text;
        break;
      } else if (statusData.status === "error") {
        return NextResponse.json(
          { error: `Transcription failed: ${statusData.error}` },
          { status: 500 }
        );
      }

      attempts++;
    }

    if (!transcript) {
      return NextResponse.json(
        { error: "Transcription timed out" },
        { status: 408 }
      );
    }

    return NextResponse.json({ transcript });
  } catch (error: any) {
    console.error("Speech-to-text route error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

