/**
 * RAG Utilities
 * 
 * This module handles retrieval of relevant experiences from the vector database
 * using semantic similarity search with Gemini embeddings.
 */

import { ChromaClient } from "chromadb";

// Configuration
const COLLECTION_NAME = "experience_store";
const DB_PATH = "./chroma_db";
const EMBEDDING_MODEL = "models/embedding-001";
const DEFAULT_TOP_K = 5;

/**
 * Dummy embedding function for ChromaDB client
 * (We use our own Gemini embeddings, but ChromaDB requires an embedding function)
 */
class DummyEmbeddingFunction {
  async generate(texts: string[]): Promise<number[][]> {
    // Return empty embeddings - we'll use our own embeddings
    return texts.map(() => []);
  }
}

/**
 * Interface for a retrieved experience chunk
 */
export interface RelevantChunk {
  chunkId: string;
  text: string;
  metadata: {
    experience_id: number;
    title: string;
    company: string;
    chunk_index: number;
    total_chunks: number;
    star_format: string;
  };
  score?: number;
}

/**
 * Generate embedding for a query using Gemini's embedding model
 */
async function generateQueryEmbedding(query: string, apiKey: string): Promise<number[]> {
  try {
    // Use Gemini's REST API for embeddings
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          content: {
            parts: [{ text: query }],
          },
          taskType: "RETRIEVAL_QUERY",
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini embedding API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    
    // Handle different response formats
    if (data.embedding?.values) {
      return data.embedding.values;
    } else if (data.embedding) {
      return Array.isArray(data.embedding) ? data.embedding : [];
    } else {
      throw new Error("Invalid embedding response format");
    }
  } catch (error: any) {
    console.error("❌ Error generating embedding:", error.message);
    throw new Error(`Failed to generate embedding: ${error.message}`);
  }
}

/**
 * Fallback: Load experiences from JSON file when ChromaDB is not available
 */
async function loadExperiencesFromJSON(): Promise<any[]> {
  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const jsonPath = path.join(process.cwd(), "experiences.json");
    const data = await fs.readFile(jsonPath, "utf-8");
    return JSON.parse(data);
  } catch (error: any) {
    console.error("❌ Failed to load experiences.json:", error.message);
    return [];
  }
}

/**
 * Format experience as STAR format string
 */
function formatExperienceAsSTAR(exp: any): string {
  return `**${exp.title}** (${exp.company})
Situation: ${exp.situation}
Task: ${exp.task}
Action: ${exp.action}
Result: ${exp.result}`;
}

/**
 * Simple keyword-based matching when ChromaDB isn't available
 */
function matchExperiencesByKeywords(query: string, experiences: any[], topK: number): string[] {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3); // Words longer than 3 chars
  
  // Score each experience based on keyword matches
  const scored = experiences.map(exp => {
    const text = `${exp.title} ${exp.description} ${exp.situation} ${exp.task} ${exp.action} ${exp.result}`.toLowerCase();
    const score = queryWords.reduce((sum, word) => {
      return sum + (text.includes(word) ? 1 : 0);
    }, 0);
    return { exp, score };
  });
  
  // Sort by score and return top K
  const topExperiences = scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(item => formatExperienceAsSTAR(item.exp));
  
  // If no matches, return a few random experiences
  if (topExperiences.length === 0) {
    return experiences.slice(0, topK).map(formatExperienceAsSTAR);
  }
  
  return topExperiences;
}

/**
 * Retrieve relevant experiences from the vector database using semantic similarity search
 * Falls back to JSON file with keyword matching if ChromaDB is not available
 * 
 * @param query - The user's query/question to search for
 * @param topK - Number of top results to return (default: 5)
 * @returns Array of relevant experience chunks, formatted and ready for prompt injection
 */
export async function getRelevantExperiences(
  query: string,
  topK: number = DEFAULT_TOP_K
): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY not set in environment variables");
    throw new Error("GEMINI_API_KEY environment variable is required");
  }

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    console.warn("⚠️  Empty query provided to getRelevantExperiences");
    return [];
  }

  try {
    // Initialize ChromaDB client
    const client = new ChromaClient({
      path: DB_PATH,
    });

    // Get the collection
    let collection;
    try {
      collection = await client.getCollection({
        name: COLLECTION_NAME,
        embeddingFunction: new DummyEmbeddingFunction(),
      });
    } catch (error: any) {
      console.error(`❌ Error accessing ChromaDB collection '${COLLECTION_NAME}':`, error.message);
      throw new Error(
        `ChromaDB collection '${COLLECTION_NAME}' not found. Please run ingest.py first to create the vector database.`
      );
    }

    // Generate embedding for the query
    console.log(`🔍 Generating embedding for query: "${query.slice(0, 50)}..."`);
    const queryEmbedding = await generateQueryEmbedding(query, apiKey);

    if (!queryEmbedding || queryEmbedding.length === 0) {
      throw new Error("Failed to generate valid embedding for query");
    }

    // Query ChromaDB for similar chunks
    // Retrieve more chunks to account for deduplication by experience_id
    const queryResults = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: Math.min(topK * 3, await collection.count()), // Get more to deduplicate
    });

    if (
      !queryResults.ids ||
      !queryResults.ids[0] ||
      queryResults.ids[0].length === 0
    ) {
      console.warn("⚠️  No results found in vector database");
      return [];
    }

    // Extract results and deduplicate by experience_id
    const chunks: RelevantChunk[] = [];
    const seenExperienceIds = new Set<number>();

    for (let i = 0; i < queryResults.ids[0].length; i++) {
      const chunkId = queryResults.ids[0][i];
      const metadata = queryResults.metadatas?.[0]?.[i] as any;
      const document = queryResults.documents?.[0]?.[i] as string;
      const distance = queryResults.distances?.[0]?.[i] as number | undefined;

      if (!metadata || !document) {
        continue;
      }

      const experienceId = metadata.experience_id || metadata.id;
      
      // Skip if we've already seen this experience (deduplicate)
      if (seenExperienceIds.has(experienceId)) {
        continue;
      }

      // Only add if we haven't reached the requested number
      if (chunks.length >= topK) {
        break;
      }

      seenExperienceIds.add(experienceId);
      
      chunks.push({
        chunkId,
        text: document,
        metadata: {
          experience_id: experienceId,
          title: metadata.title || "Unknown",
          company: metadata.company || "Unknown",
          chunk_index: metadata.chunk_index || 0,
          total_chunks: metadata.total_chunks || 1,
          star_format: metadata.star_format || "",
        },
        score: distance !== undefined ? 1 - distance : undefined, // Convert distance to similarity score
      });
    }

    if (chunks.length === 0) {
      console.warn("⚠️  No relevant chunks found after deduplication");
      return [];
    }

    console.log(`✅ Retrieved ${chunks.length} relevant experience chunks`);

    // Format chunks as STAR format strings for prompt injection
    // Use the star_format from metadata if available, otherwise format from chunk
    const formattedExperiences = chunks.map((chunk) => {
      // Prefer the stored STAR format, otherwise use the chunk text
      return chunk.metadata.star_format || chunk.text;
    });

    return formattedExperiences;
  } catch (error: any) {
    console.error("❌ Error in getRelevantExperiences:", error.message);
    console.log("⚠️ Falling back to JSON file with keyword matching...");
    
    // Fallback: Load from JSON and use keyword matching
    try {
      const experiences = await loadExperiencesFromJSON();
      if (experiences.length > 0) {
        const matched = matchExperiencesByKeywords(query, experiences, topK);
        console.log(`✅ Retrieved ${matched.length} experiences from JSON fallback`);
        return matched;
      } else {
        console.warn("⚠️ No experiences found in JSON file");
        return [];
      }
    } catch (fallbackError: any) {
      console.error("❌ Fallback also failed:", fallbackError.message);
      return []; // Return empty array instead of throwing
    }
  }
}

/**
 * Get relevant experiences as structured objects (alternative return format)
 */
export async function getRelevantExperiencesStructured(
  query: string,
  topK: number = DEFAULT_TOP_K
): Promise<RelevantChunk[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }

  try {
    const client = new ChromaClient({
      path: DB_PATH,
    });

    const collection = await client.getCollection({
      name: COLLECTION_NAME,
      embeddingFunction: new DummyEmbeddingFunction(),
    });

    const queryEmbedding = await generateQueryEmbedding(query, apiKey);

    const queryResults = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: Math.min(topK * 3, await collection.count()),
    });

    const chunks: RelevantChunk[] = [];
    const seenExperienceIds = new Set<number>();

    if (queryResults.ids && queryResults.ids[0]) {
      for (let i = 0; i < queryResults.ids[0].length; i++) {
        const metadata = queryResults.metadatas?.[0]?.[i] as any;
        const experienceId = metadata?.experience_id || metadata?.id;

        if (seenExperienceIds.has(experienceId)) {
          continue;
        }

        if (chunks.length >= topK) {
          break;
        }

        seenExperienceIds.add(experienceId);
        chunks.push({
          chunkId: queryResults.ids[0][i],
          text: queryResults.documents?.[0]?.[i] as string,
          metadata: {
            experience_id: experienceId,
            title: metadata?.title || "Unknown",
            company: metadata?.company || "Unknown",
            chunk_index: metadata?.chunk_index || 0,
            total_chunks: metadata?.total_chunks || 1,
            star_format: metadata?.star_format || "",
          },
          score: queryResults.distances?.[0]?.[i] !== undefined 
            ? 1 - (queryResults.distances?.[0]?.[i] as number)
            : undefined,
        });
      }
    }

    return chunks;
  } catch (error: any) {
    console.error("❌ Error in getRelevantExperiencesStructured:", error.message);
    throw error;
  }
}

/**
 * Retrieve relevant technical Q&A from the vector database
 * 
 * @param query - The user's query/question to search for
 * @param topK - Number of top results to return (default: 3)
 * @returns Array of relevant Q&A pairs, formatted and ready for prompt injection
 */
export async function getRelevantTechnicalQA(
  query: string,
  topK: number = 3
): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY not set in environment variables");
    throw new Error("GEMINI_API_KEY environment variable is required");
  }

  if (!query || typeof query !== "string" || query.trim().length === 0) {
    console.warn("⚠️  Empty query provided to getRelevantTechnicalQA");
    return [];
  }

  try {
    const client = new ChromaClient({
      path: DB_PATH,
    });

    let collection;
    try {
      collection = await client.getCollection({
        name: "technical_qa",
        embeddingFunction: new DummyEmbeddingFunction(),
      });
    } catch (error: any) {
      console.warn(`⚠️  Technical Q&A collection not found: ${error.message}`);
      return []; // Return empty if collection doesn't exist
    }

    const queryEmbedding = await generateQueryEmbedding(query, apiKey);

    if (!queryEmbedding || queryEmbedding.length === 0) {
      throw new Error("Failed to generate valid embedding for query");
    }

    const queryResults = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: Math.min(topK * 2, await collection.count()),
    });

    if (
      !queryResults.ids ||
      !queryResults.ids[0] ||
      queryResults.ids[0].length === 0
    ) {
      return [];
    }

    const qaPairs: Array<{ question: string; answer: string }> = [];
    const seenQAIds = new Set<number>();

    for (let i = 0; i < queryResults.ids[0].length; i++) {
      const metadata = queryResults.metadatas?.[0]?.[i] as any;
      const document = queryResults.documents?.[0]?.[i] as string;

      if (!metadata || !document) {
        continue;
      }

      const qaId = metadata.qa_id || metadata.id;

      if (seenQAIds.has(qaId)) {
        continue;
      }

      if (qaPairs.length >= topK) {
        break;
      }

      seenQAIds.add(qaId);
      
      // Extract question and answer from metadata or document
      const question = metadata.question || document.split("Question:")[1]?.split("\n")[0]?.trim() || "Technical Question";
      const answer = metadata.answer || document.split("Answer:")[1]?.trim() || document;
      
      qaPairs.push({ question, answer });
    }

    if (qaPairs.length === 0) {
      return [];
    }

    console.log(`✅ Retrieved ${qaPairs.length} relevant technical Q&A pairs`);

    // Format as Q&A pairs
    const formattedQA = qaPairs.map((qa) => {
      return `Q: ${qa.question}\nA: ${qa.answer}`;
    });

    return formattedQA;
  } catch (error: any) {
    console.error("❌ Error in getRelevantTechnicalQA:", error.message);
    return []; // Return empty array on error, don't break the flow
  }
}

/**
 * Store a generated response for future consistency checks
 * 
 * @param question - The question that was asked
 * @param response - The generated response
 * @param metadata - Optional metadata (interview mode, etc.)
 */
export async function storeResponse(
  question: string,
  response: string,
  metadata?: {
    interviewMode?: string;
    interviewRound?: number;
    timestamp?: number;
    profileId?: string;
  }
): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY not set in environment variables");
    throw new Error("GEMINI_API_KEY environment variable is required");
  }

  try {
    const client = new ChromaClient({
      path: DB_PATH,
    });

    // Get or create the responses collection
    let collection;
    try {
      collection = await client.getCollection({
        name: "response_store",
        embeddingFunction: new DummyEmbeddingFunction(),
      });
    } catch (error: any) {
      // Collection doesn't exist, create it
      console.log("📦 Creating response_store collection...");
      collection = await client.createCollection({
        name: "response_store",
        embeddingFunction: new DummyEmbeddingFunction(),
      });
    }

    // Generate embedding for the question
    const questionEmbedding = await generateQueryEmbedding(question, apiKey);
    
    if (!questionEmbedding || questionEmbedding.length === 0) {
      throw new Error("Failed to generate valid embedding for question");
    }

    // Create a unique ID for this response
    const responseId = `response_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    
    // Store the response
    await collection.add({
      ids: [responseId],
      embeddings: [questionEmbedding],
      documents: [response],
      metadatas: [{
        question: question.substring(0, 500), // Store truncated question in metadata
        response_length: response.length,
        interview_mode: metadata?.interviewMode || "qa",
        interview_round: metadata?.interviewRound || 1,
        timestamp: metadata?.timestamp || Date.now(),
        profile_id: metadata?.profileId || "",
      }],
    });

    console.log(`✅ Stored response for question: "${question.substring(0, 50)}..."`);
  } catch (error: any) {
    console.error("❌ Error storing response:", error.message);
    // Don't throw - fail silently to not break the main flow
  }
}

/**
 * Check if a similar question has been answered before
 * 
 * @param question - The question to check
 * @param similarityThreshold - Minimum similarity score (0-1) to consider a match (default: 0.85)
 * @returns The stored response if a similar question is found, null otherwise
 */
export async function getStoredResponse(
  question: string,
  similarityThreshold: number = 0.85,
  interviewRound?: number,
  profileId?: string
): Promise<{ response: string; similarity: number; storedQuestion: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEY not set in environment variables");
    return null;
  }

  if (!question || typeof question !== "string" || question.trim().length === 0) {
    return null;
  }

  try {
    const client = new ChromaClient({
      path: DB_PATH,
    });

    let collection;
    try {
      collection = await client.getCollection({
        name: "response_store",
        embeddingFunction: new DummyEmbeddingFunction(),
      });
    } catch (error: any) {
      // Collection doesn't exist yet, no stored responses
      console.log("📦 Response store collection doesn't exist yet");
      return null;
    }

    const count = await collection.count();
    if (count === 0) {
      return null;
    }

    // Generate embedding for the query
    const queryEmbedding = await generateQueryEmbedding(question, apiKey);
    
    if (!queryEmbedding || queryEmbedding.length === 0) {
      return null;
    }

    // Query for similar questions - filter by round if specified
    const queryOptions: any = {
      queryEmbeddings: [queryEmbedding],
      nResults: 10, // Get more to filter by round
    };
    
    const queryResults = await collection.query(queryOptions);

    if (
      !queryResults.ids ||
      !queryResults.ids[0] ||
      queryResults.ids[0].length === 0 ||
      !queryResults.documents ||
      !queryResults.documents[0] ||
      queryResults.documents[0].length === 0
    ) {
      return null;
    }

    // Find the best match, filtering by round if specified
    let bestMatch: { index: number; similarity: number } | null = null;
    
    for (let i = 0; i < queryResults.ids[0].length; i++) {
      const distance = queryResults.distances?.[0]?.[i];
      const similarity = distance !== undefined ? 1 - distance : 0;
      const metadata = queryResults.metadatas?.[0]?.[i] as any;
      
      // If round is specified, filter by round
      if (interviewRound !== undefined) {
        const storedRound = metadata?.interview_round;
        if (storedRound !== interviewRound) {
          continue; // Skip if round doesn't match
        }
      }
      
      // If profile ID is specified, filter by profile
      if (profileId !== undefined && profileId !== "") {
        const storedProfileId = metadata?.profile_id;
        if (storedProfileId !== profileId) {
          continue; // Skip if profile doesn't match
        }
      }
      
      // Check similarity threshold
      if (similarity >= similarityThreshold) {
        if (!bestMatch || similarity > bestMatch.similarity) {
          bestMatch = { index: i, similarity };
        }
      }
    }
    
    if (!bestMatch) {
      return null;
    }

    const matchIndex = bestMatch.index;
    const similarity = bestMatch.similarity;
    const storedResponse = queryResults.documents[0][matchIndex] as string;
    const storedQuestion = (queryResults.metadatas?.[0]?.[matchIndex]?.question || question) as string;

    console.log(`✅ Found stored response with similarity: ${similarity.toFixed(2)}`);
    console.log(`   Stored question: "${storedQuestion.substring(0, 50)}..."`);

    return {
      response: storedResponse,
      similarity,
      storedQuestion,
    };
  } catch (error: any) {
    console.error("❌ Error checking stored responses:", error.message);
    return null; // Fail silently
  }
}

/**
 * Clear stored responses from the response store
 * Can filter by profile ID and/or interview round
 * 
 * @param profileId - Optional: Only clear responses for this profile
 * @param interviewRound - Optional: Only clear responses for this round
 * @returns Success status and count of cleared responses
 */
export async function clearStoredResponses(
  profileId?: string,
  interviewRound?: number
): Promise<{ success: boolean; count: number }> {
  try {
    const client = new ChromaClient({
      path: DB_PATH,
    });

    let collection;
    try {
      collection = await client.getCollection({
        name: "response_store",
        embeddingFunction: new DummyEmbeddingFunction(),
      });
    } catch (error: any) {
      // Collection doesn't exist, nothing to clear
      console.log("📦 Response store collection doesn't exist");
      return { success: true, count: 0 };
    }

    const count = await collection.count();
    
    if (count === 0) {
      console.log("📦 No stored responses to clear");
      return { success: true, count: 0 };
    }

    // Get all responses to filter by profile ID and/or round
    const allResults = await collection.get();
    
    if (!allResults.ids || allResults.ids.length === 0) {
      return { success: true, count: 0 };
    }

    // Filter IDs based on profile ID and/or round
    const idsToDelete: string[] = [];
    
    for (let i = 0; i < allResults.ids.length; i++) {
      const metadata = allResults.metadatas?.[i] as any;
      
      // Check profile ID filter
      if (profileId !== undefined && metadata?.profile_id !== profileId) {
        continue; // Skip if profile doesn't match
      }
      
      // Check round filter
      if (interviewRound !== undefined) {
        const storedRound = metadata?.interview_round;
        if (storedRound !== interviewRound) {
          continue; // Skip if round doesn't match
        }
      }
      
      idsToDelete.push(allResults.ids[i] as string);
    }
    
    if (idsToDelete.length === 0) {
      console.log("📦 No matching responses to clear");
      return { success: true, count: 0 };
    }

    // Delete filtered responses
    await collection.delete({
      ids: idsToDelete,
    });
    
    console.log(`✅ Cleared ${idsToDelete.length} stored responses${profileId ? ` for profile ${profileId}` : ''}${interviewRound ? ` from round ${interviewRound}` : ''}`);
    return { success: true, count: idsToDelete.length };
  } catch (error: any) {
    console.error("❌ Error clearing stored responses:", error.message);
    throw new Error(`Failed to clear stored responses: ${error.message}`);
  }
}
