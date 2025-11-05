import { NextResponse } from "next/server";
import { getRelevantExperiences, getRelevantTechnicalQA, getStoredResponse, storeResponse } from "../rag_utils";
import { getProceduralSteps, Framework } from "../../../utils/procedural-lookup";

export const dynamic = "force-dynamic";

const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models/";

/**
 * Extract the actual interview question from the prompt
 */
function extractQuestion(prompt: string): string {
  // Try to extract question from common patterns
  const patterns = [
    /Interview question:\s*(.+?)(?:\n|$)/i,
    /question:\s*(.+?)(?:\n|$)/i,
    /Ask[ed]?:\s*(.+?)(?:\n|$)/i,
  ];

  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  // If no pattern matches, use the last 200 chars as a fallback
  return prompt.slice(-200).trim();
}

/**
 * Fallback function to format basic procedural response if Gemini fails
 */
function formatBasicProceduralResponse(framework: Framework, userQuery: string): string {
  // Extract context from user query
  const contextMatch = userQuery.match(/(?:with|for|in|on|at)\s+([A-Z][a-zA-Z\s]+?)(?:\s|$|,|\.)/i);
  const context = contextMatch ? contextMatch[1].trim() : "the situation";
  
  let response = `I follow the ${framework.title} when handling ${context}. ${framework.summary}\n\n`;
  response += `Here's how I approach it through ${framework.phases.length} key phases:\n\n`;
  
  framework.phases.forEach((phase) => {
    response += `**Phase ${phase.phase_number}: ${phase.phase_name}**\n\n`;
    // Convert to first-person action-oriented style
    const description = phase.description
      .replace(/This phase involves/g, "I focus on")
      .replace(/Activities include/g, "I typically")
      .replace(/Key activities include/g, "I typically")
      .replace(/The goal is/g, "My goal is");
    response += `${description}\n\n`;
  });
  
  return response.trim();
}

/**
 * Generate contextualized procedural response using Gemini
 * Takes the framework phases and user's specific scenario to create a personalized, first-person response
 */
async function generateContextualizedProceduralResponse(
  framework: Framework,
  userQuery: string,
  apiKey: string
): Promise<any> {
  // Format framework phases as context for Gemini
  const phasesContext = framework.phases.map(phase => 
    `Phase ${phase.phase_number}: ${phase.phase_name}\n${phase.description}`
  ).join('\n\n');

  const systemInstruction = `You are an expert Incident Commander or Process Lead responding to an interview question about ${framework.title}. 

**FRAMEWORK PHASES:**
${phasesContext}

**CRITICAL REQUIREMENTS:**

1. **I-Statement Persona:** Write STRICTLY in first-person ("I"). Never use "you", "we", or third-person. Every action must be stated as something "I" did or would do.

2. **Scenario Injection:** Immediately address the specific scenario mentioned in the user's query (e.g., "AWS incident", "security breach", "software deployment"). Extract context clues from their question and apply them throughout.

3. **Action-Oriented & Concise:** Focus on ACTIONS TAKEN, not general definitions. Each phase should describe what "I" specifically did or would do in that scenario. Be concise - aim for 2-3 sentences per phase.

4. **Format:**
   - Start with an "I-statement" summary sentence that introduces the framework and addresses the user's specific scenario
   - Then list each phase formatted as: **Phase X: [Phase Name]**. **I [action-oriented description]**.
   - Use bold for phase headers only
   - Keep descriptions focused on concrete actions, not theory

5. **Example Style:**
   Instead of: "Containment focuses on limiting the scope..."
   Write: "**Phase 3: Containment**. **I immediately** isolated the affected AWS resources by applying strict Security Group ACLs to stop lateral movement, while preserving disk snapshots for forensic analysis."

6. **Contextualization:** Extract specific technologies, tools, or services mentioned in the user query (AWS, Azure, specific tools, etc.) and incorporate them naturally into each phase's actions.

Generate a response that directly answers the user's specific scenario using the framework phases as guidance.`;

  const userPrompt = `Based on the ${framework.title} framework, describe how I would handle this specific scenario: ${userQuery}

Provide a concise, first-person, action-oriented response that addresses this specific scenario.`;

  const apiUrl = `${BASE_URL}${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  
  console.log("🤖 Generating contextualized procedural response via Gemini...");
  
  const geminiResponse = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
    }),
  });

  const text = await geminiResponse.text();

  if (!geminiResponse.ok) {
    console.error("❌ Gemini returned error response:", text);
    throw new Error(`Gemini API error: ${text}`);
  }

  try {
    const data = JSON.parse(text);
    return data;
  } catch (err) {
    console.error("⚠️ Failed to parse Gemini JSON:", err);
    throw new Error("Invalid JSON from Gemini");
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const prompt = body?.prompt;
    const profileTechnicalQAs = body?.technicalQAs || []; // Profile-specific Q&A pairs
    const interviewMode = body?.interviewMode || "qa"; // "qa" or "procedural"
    const interviewRound = body?.interviewRound || 1; // Interview round (1-7)
    const profileId = body?.profileId || ""; // Profile ID for storing responses
    const previousQA = body?.previousQA || null; // Previous question and response for building upon
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

    // Extract the actual question for RAG retrieval
    const actualQuestion = extractQuestion(prompt);
    console.log("🔍 Extracted question for RAG:", actualQuestion);

    // Check for stored response first (for consistency) - filter by round and profile
    console.log("🔎 Checking for stored response (Round", interviewRound, profileId ? `, Profile ${profileId}` : "", ")...");
    const storedResponse = await getStoredResponse(actualQuestion, 0.85, interviewRound, profileId);
    
    if (storedResponse) {
      console.log(`✅ Using stored response (similarity: ${storedResponse.similarity.toFixed(2)})`);
      return NextResponse.json({
        candidates: [{
          content: {
            parts: [{
              text: storedResponse.response
            }]
          }
        }]
      });
    }

    // Check if this is a procedural question that matches a known framework
    console.log("🔎 Checking for procedural framework match...");
    const proceduralFramework = getProceduralSteps(actualQuestion);
    
    if (proceduralFramework) {
      console.log(`✅ Found procedural framework: ${proceduralFramework.title}`);
      
      try {
        // Use Gemini to contextualize and personalize the procedural response
        const proceduralResponse = await generateContextualizedProceduralResponse(
          proceduralFramework,
          actualQuestion,
          apiKey
        );
        
        // Extract response text from procedural response
        const responseText = proceduralResponse?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        
        // Store the procedural response for future consistency
        if (responseText) {
          storeResponse(actualQuestion, responseText, {
            interviewMode: "procedural",
            interviewRound,
            profileId,
            timestamp: Date.now(),
          }).catch(err => {
            console.error("⚠️ Failed to store procedural response (non-blocking):", err.message);
          });
        }
        
        return NextResponse.json(proceduralResponse);
      } catch (error: any) {
        console.error("❌ Error generating contextualized procedural response:", error.message);
        // Fallback to basic formatted response if Gemini fails
        console.log("⚠️ Falling back to basic procedural response format");
        const fallbackResponse = formatBasicProceduralResponse(proceduralFramework, actualQuestion);
        return NextResponse.json({
          candidates: [{
            content: {
              parts: [{
                text: fallbackResponse
              }]
            }
          }]
        });
      }
    }

    // Continue with RAG logic if no procedural framework match
    console.log("📚 No procedural framework match, proceeding with RAG...");

    // Retrieve relevant experiences using RAG utility
    console.log("📚 Retrieving relevant experiences from vector database...");
    let retrievedContext = "";
    let technicalQAContext = "";
    
    try {
      // Retrieve experiences
      const relevantExperiences = await getRelevantExperiences(actualQuestion, 5);
      
      if (relevantExperiences.length > 0) {
        console.log(`✅ Retrieved ${relevantExperiences.length} relevant experiences`);
        retrievedContext = relevantExperiences.join("\n\n");
      } else {
        console.warn("⚠️  No experiences retrieved from RAG.");
        retrievedContext = ""; // Empty context - Gemini will use general knowledge
      }

      // Retrieve technical Q&A from vector database
      const technicalQA = await getRelevantTechnicalQA(actualQuestion, 3);
      
      if (technicalQA.length > 0) {
        console.log(`✅ Retrieved ${technicalQA.length} relevant technical Q&A pairs from database`);
        technicalQAContext = "\n\n**TECHNICAL Q&A REFERENCE (from database):**\n\n" + technicalQA.join("\n\n");
      }

      // Add profile-specific Q&A if provided and relevant
      if (profileTechnicalQAs && profileTechnicalQAs.length > 0) {
        // Filter profile Q&A based on question relevance (simple keyword matching)
        const questionLower = actualQuestion.toLowerCase();
        const relevantProfileQA = profileTechnicalQAs
          .filter((qa: any) => {
            if (!qa.question || !qa.answer) return false;
            const qaLower = (qa.question + " " + qa.answer).toLowerCase();
            // Check if question keywords match profile Q&A
            const questionWords = questionLower.split(/\s+/).filter(w => w.length > 3);
            return questionWords.some(word => qaLower.includes(word));
          })
          .slice(0, 3); // Limit to top 3 most relevant

        if (relevantProfileQA.length > 0) {
          console.log(`✅ Using ${relevantProfileQA.length} relevant profile-specific Q&A pairs`);
          const profileQAFormatted = relevantProfileQA.map((qa: any) => 
            `Q: ${qa.question}\nA: ${qa.answer}`
          ).join("\n\n");
          technicalQAContext += "\n\n**PROFILE-SPECIFIC TECHNICAL Q&A:**\n\n" + profileQAFormatted;
        }
      }
    } catch (error: any) {
      console.error("❌ Error retrieving experiences:", error.message);
      console.log("⚠️ ChromaDB not available - proceeding with general knowledge (no RAG context)");
      // Set empty context so Gemini proceeds with general knowledge instead of error message
      retrievedContext = "";
      technicalQAContext = "";
    }

    const apiUrl = `${BASE_URL}${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    console.log("📡 Calling Gemini with RAG-augmented prompt");
    console.log("📋 Interview mode:", interviewMode);

    // Build the prompt template with retrieved context based on interview mode
    let systemInstruction: string;
    
    if (interviewMode === "procedural") {
      // Procedural interview mode - format as step-by-step process with SPECIFIC commands and locations
      systemInstruction = `You are an expert AI interviewer assistant helping with a PROCEDURAL INTERVIEW. The interviewer wants SPECIFIC, ACTIONABLE steps with exact commands, tools, and locations.

**RETRIEVED CONTEXT:**

${retrievedContext}${technicalQAContext}

**CRITICAL RULE:** Do not repeat the same story within the same conversation session. If the retrieved context is repetitive, synthesize a high-level summary instead.

**Response Guidelines for Procedural Interviews:**
- Format your response as a CLEAR, NUMBERED LIST of steps with SPECIFIC, ACTIONABLE details
- Each step MUST include:
  * Exact commands with actual syntax (CLI commands, API calls, scripts, queries)
  * Specific cloud service locations and navigation paths (e.g., "AWS GuardDuty → Findings → Filter by severity 'HIGH'")
  * Exact paths, URLs, or feature locations within tools
  * Specific tool names and their exact locations/features used
- Structure each step as: "Step X: [Goal/Objective] - [Specific actions including exact commands, cloud service locations, navigation paths, and tools]"
- Reference relevant experiences from the retrieved context when applicable
- Keep steps logical and sequential
- Aim for 4-10 steps depending on complexity
- Be concrete and actionable - AVOID vague descriptions like "check the system" or "review logs"
- Include actual command syntax, exact UI navigation paths, and specific tool locations

**CRITICAL REQUIREMENTS:**
- Include actual commands: e.g., \`aws guardduty list-findings --finding-criteria file://criteria.json\`, \`az security alert list --filter "severity eq 'High'"\`
- Include exact cloud service locations: e.g., "Navigate to AWS GuardDuty → Findings → Filter by severity 'HIGH' → Click on finding ID"
- Include specific navigation paths: e.g., "Azure Portal → Security Center → Security alerts → Filter by severity 'High' → Review affected resources"
- Include exact tool locations: e.g., "GCP Security Command Center → Findings → Filter by severity 'CRITICAL' → Export findings"

**Example Format:**
Step 1: Initial assessment and preparation - Run \`aws guardduty list-detectors\` to identify active detectors, then navigate to AWS GuardDuty → Settings → Check data sources are enabled. Review AWS CloudTrail logs using \`aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRole\`.

Step 2: Investigate specific findings - Navigate to AWS GuardDuty → Findings → Filter by severity 'HIGH' → Select finding → Review details tab → Check affected resources → Export finding details using \`aws guardduty get-findings --finding-ids <finding-id>\`.

Remember: Be SPECIFIC with commands, exact cloud service navigation paths, and specific tool locations. Avoid high-level descriptions.`;
    } else {
      // Q&A interview mode (default)
      // Build previous Q&A context section if available
      const previousQASection = previousQA 
        ? `**PREVIOUS QUESTION AND RESPONSE (BUILD UPON THIS):**

**Previous Question:** ${previousQA.question}

**Previous Response:** ${previousQA.response}

**CRITICAL INSTRUCTION:** The user is asking a follow-up question that should build upon and expand the previous response. Your task is to:
1. Acknowledge the previous response
2. Provide MORE DETAILED and DEEPER explanations of the points mentioned in the previous response
3. Expand on technical details, examples, or scenarios from the previous response
4. Add additional context, examples, or practical applications
5. Go deeper into the "how" and "why" aspects that were only briefly mentioned before

The new question may ask for clarification, more detail, or expansion on specific aspects of the previous response. Treat it as an opportunity to provide a comprehensive, in-depth answer that builds directly on what was said before.

---`

        : "";

      const contextSection = retrievedContext || technicalQAContext 
        ? `**RETRIEVED CONTEXT:**

${retrievedContext}${technicalQAContext}

**CRITICAL RULE:** Do not repeat the same story within the same conversation session. If the retrieved context is repetitive, synthesize a high-level summary instead.

**Response Guidelines:**`
        : `**Response Guidelines:**`;

      systemInstruction = `You are an expert AI interviewer answering interview questions. ${retrievedContext || technicalQAContext 
        ? `Use the following retrieved experience data and technical Q&A to answer the user's question, but if the context doesn't fully address the question, feel free to use your general knowledge to provide a complete answer.` 
        : `Answer the question using your general knowledge and expertise.`}

${previousQASection}

${contextSection}
- Target ~30 seconds spoken duration (about 70–90 words, roughly 450–700 characters)
- Be natural, conversational, and easy to speak aloud
- Use short sentences and contractions (I'm, we're, it's)
- Use the STAR format briefly (1 short line each) when referencing experiences
- For technical questions, reference the technical Q&A provided above
- Emphasize impact/results; skip deep details unless asked
- Sound conversational, not robotic or scripted
${previousQA ? "- Since this is a follow-up question, focus on expanding and deepening the previous response with more detail, examples, and practical applications" : ""}

**For Technical Questions:**
- Answer the question DIRECTLY and FIRST
- Reference the technical Q&A provided above when relevant
- If the question asks for a specific command, query, or code snippet, provide it immediately after briefly explaining the approach
- When providing a command/query/code snippet, explicitly mention it using phrases like "For a command to do that, I would use..." or "Here's a query that would work..."
- Include the actual command/query/code as a markdown code block using triple backticks
- Insert "(pause)" right before the code block in your spoken text so the user can pause and review it
- End your response with: "Would you like me to go deeper into that?"

Remember: Write like you're speaking. Keep it conversational, brief, and tightly within ~30 seconds.`;
    }

    // Send the user's question as the main content, with RAG-retrieved context in system instruction
    const geminiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: {
          parts: [{ text: systemInstruction }],
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
      
      // Extract the response text
      const responseText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      
      // Store the response for future consistency (async, don't wait)
      if (responseText) {
        storeResponse(actualQuestion, responseText, {
          interviewMode,
          interviewRound,
          profileId,
          timestamp: Date.now(),
        }).catch(err => {
          console.error("⚠️ Failed to store response (non-blocking):", err.message);
        });
      }
      
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
