import { NextResponse } from "next/server";
import { clearStoredResponses } from "../rag_utils";

export const dynamic = "force-dynamic";

/**
 * API endpoint to clear stored responses
 * POST /api/clear-responses
 * Body: { profileId?: string, interviewRound?: number }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const profileId = body?.profileId;
    const interviewRound = body?.interviewRound;
    
    const result = await clearStoredResponses(profileId, interviewRound);
    
    return NextResponse.json({
      success: result.success,
      message: `Cleared ${result.count} stored response(s)${profileId ? ` for profile` : ''}${interviewRound ? ` from round ${interviewRound}` : ''}`,
      count: result.count,
    });
  } catch (error: any) {
    console.error("💥 /api/clear-responses route crashed:", error);
    return NextResponse.json(
      { 
        success: false,
        error: error.message || "Internal Server Error" 
      },
      { status: 500 }
    );
  }
}

/**
 * GET endpoint to check how many responses are stored
 * Query params: ?profileId=xxx&interviewRound=1
 */
export async function GET(request: Request) {
  try {
    const { ChromaClient } = await import("chromadb");
    
    class DummyEmbeddingFunction {
      async generate(texts: string[]): Promise<number[][]> {
        return texts.map(() => []);
      }
    }

    const client = new ChromaClient({
      path: "./chroma_db",
    });

    try {
      const collection = await client.getCollection({
        name: "response_store",
        embeddingFunction: new DummyEmbeddingFunction(),
      });
      
      const url = new URL(request.url);
      const profileId = url.searchParams.get("profileId") || undefined;
      const interviewRoundParam = url.searchParams.get("interviewRound");
      const interviewRound = interviewRoundParam ? parseInt(interviewRoundParam, 10) : undefined;
      
      const allResults = await collection.get();
      let count = 0;
      
      if (allResults.ids && allResults.ids.length > 0) {
        // Filter by profile ID and/or round if specified
        if (profileId !== undefined || interviewRound !== undefined) {
          for (let i = 0; i < allResults.ids.length; i++) {
            const metadata = allResults.metadatas?.[i] as any;
            
            if (profileId !== undefined && metadata?.profile_id !== profileId) {
              continue;
            }
            
            if (interviewRound !== undefined) {
              const storedRound = metadata?.interview_round;
              if (storedRound !== interviewRound) {
                continue;
              }
            }
            
            count++;
          }
        } else {
          count = allResults.ids.length;
        }
      }
      
      return NextResponse.json({
        success: true,
        count,
        message: `Found ${count} stored response(s)${profileId ? ` for profile` : ''}${interviewRound ? ` in round ${interviewRound}` : ''}`,
      });
    } catch (error: any) {
      // Collection doesn't exist
      return NextResponse.json({
        success: true,
        count: 0,
        message: "No stored responses (collection doesn't exist)",
      });
    }
  } catch (error: any) {
    console.error("💥 /api/clear-responses GET route crashed:", error);
    return NextResponse.json(
      { 
        success: false,
        error: error.message || "Internal Server Error" 
      },
      { status: 500 }
    );
  }
}

