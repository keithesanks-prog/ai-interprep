import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Provider = "gemini";

const DEFAULT_FINAL_MODEL =
  process.env.GEMINI_IMAGE_MODEL ?? "imagen-3.0-pro";
const DEFAULT_DRAFT_MODEL =
  process.env.GEMINI_DRAFT_IMAGE_MODEL ?? "gemini-1.5-flash";

type StylePreset =
  | "cartoon"
  | "3d-soft"
  | "cel-shaded"
  | "anime"
  | "hyper-realistic"
  | "custom";

interface Characteristics {
  height?: string;
  physique?: string;
  age?: string;
  genderPresentation?: string;
  hairstyle?: string;
  facialFeatures?: string;
  clothing?: string;
  accessories?: string;
  personality?: string;
  setting?: string;
}

interface GenerateImageRequest {
  prompt?: string;
  provider?: Provider;
  draftMode?: boolean;
  aspectRatio?: string;
  negativePrompt?: string;
  mimeType?: string;
  style?: StylePreset;
  characteristics?: Characteristics;
  characterId?: string;
}

const STYLE_PROMPTS: Record<Exclude<StylePreset, "custom">, string> = {
  cartoon:
    "Primary style: cartoon style, bold outlines, playful proportions, vibrant flat colors.",
  "3d-soft":
    "Primary style: soft 3D render with gentle lighting, rounded forms, plush tactile quality.",
  "cel-shaded":
    "Primary style: cel-shaded illustration with crisp contour lines and flat color blocks.",
  anime:
    "Primary style: anime illustration with dynamic pose, expressive eyes, stylized shading.",
  "hyper-realistic":
    "Primary style: hyper-realistic portrait with cinematic lighting and intricate detail.",
};

function buildDesignPrompt(
  prompt: string,
  style?: StylePreset,
  characteristics?: Characteristics
) {
  const parts: Array<string> = [
    "You are a character designer. Use the prompt to design the character as described.",
  ];

  if (style && style !== "custom") {
    parts.push(STYLE_PROMPTS[style]);
  }

  const characteristicLines =
    characteristics && Object.values(characteristics).some((v) => !!v)
      ? Object.entries(characteristics)
          .filter(([, value]) => value && value.trim().length > 0)
          .map(([key, value]) => {
            const label = key
              .replace(/([A-Z])/g, " $1")
              .replace(/^\w/, (c) => c.toUpperCase());
            return `${label}: ${value!.trim()}`;
          })
      : [];

  if (characteristicLines.length > 0) {
    parts.push(
      "Physical & stylistic traits:",
      ...characteristicLines.map((line) => `- ${line}`)
    );
  }

  parts.push(`Prompt: ${prompt.trim()}`);

  return parts.join("\n");
}

async function generateWithGemini({
  prompt,
  aspectRatio,
  negativePrompt,
  mimeType,
  style,
  characteristics,
  draftMode,
}: {
  prompt: string;
  aspectRatio?: string;
  negativePrompt?: string;
  mimeType?: string;
  style?: StylePreset;
  characteristics?: Characteristics;
  draftMode: boolean;
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY in environment");
  }

  const modelId = draftMode ? DEFAULT_DRAFT_MODEL : DEFAULT_FINAL_MODEL;
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const promptText = buildDesignPrompt(prompt, style, characteristics);
  const parts: Array<Record<string, unknown>> = [{ text: promptText }];

  if (negativePrompt?.trim()) {
    parts.push({ text: `Avoid: ${negativePrompt.trim()}` });
  }

  const requestBody: Record<string, unknown> = {
    contents: [{ role: "user", parts }],
  };

  const generationConfig: Record<string, unknown> = {};

  if (aspectRatio) {
    generationConfig.aspectRatio = aspectRatio;
  }

  if (draftMode) {
    generationConfig.responseModalities = ["IMAGE"];
  }

  if (Object.keys(generationConfig).length > 0) {
    requestBody.generationConfig = generationConfig;
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`Gemini image generation failed: ${raw}`);
  }

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error("Failed to parse Gemini response as JSON");
  }

  const candidate = data?.candidates?.[0];
  const part = candidate?.content?.parts?.find(
    (p: any) => p?.inlineData?.mimeType?.startsWith("image/")
  );
  const inlineData = part?.inlineData;
  const base64Data = inlineData?.data;

  if (!base64Data) {
    throw new Error("No image data returned from Gemini");
  }

  const inferredMimeType =
    mimeType || inlineData?.mimeType || "image/png";

  return {
    base64Data,
    mimeType: inferredMimeType,
    safetyRatings: candidate?.safetyRatings ?? [],
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as GenerateImageRequest;
    const prompt = body.prompt?.trim();

    if (!prompt) {
      return NextResponse.json(
        { error: "Missing required field: prompt" },
        { status: 400 }
      );
    }

    const provider = body.provider ?? "gemini";
    if (provider !== "gemini") {
      return NextResponse.json(
        { error: `Unsupported image provider: ${provider}` },
        { status: 400 }
      );
    }

    const draftMode = !!body.draftMode;

    const image = await generateWithGemini({
      prompt,
      aspectRatio: body.aspectRatio,
      negativePrompt: body.negativePrompt,
      mimeType: body.mimeType,
      style: body.style,
      characteristics: body.characteristics,
      draftMode,
    });

    return NextResponse.json({
      provider,
      draftMode,
      model: draftMode ? DEFAULT_DRAFT_MODEL : DEFAULT_FINAL_MODEL,
      characterId: body.characterId || null,
      style: body.style ?? "custom",
      image,
    });
  } catch (error: any) {
    console.error("💥 /api/generate-image error:", error);
    return NextResponse.json(
      { error: error?.message ?? "Internal Server Error" },
      { status: 500 }
    );
  }
}





