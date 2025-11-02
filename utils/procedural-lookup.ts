import fs from 'fs';
import path from 'path';

export interface Phase {
  phase_number: number;
  phase_name: string;
  description: string;
}

export interface Framework {
  id: string;
  title: string;
  summary: string;
  phases: Phase[];
}

let cachedData: Framework[] | null = null;

/**
 * Load procedural data from JSON file
 */
function loadProceduralData(): Framework[] {
  if (cachedData) {
    return cachedData;
  }

  try {
    const filePath = path.join(process.cwd(), 'procedural_data.json');
    const fileContents = fs.readFileSync(filePath, 'utf-8');
    cachedData = JSON.parse(fileContents) as Framework[];
    return cachedData;
  } catch (error) {
    console.error('Error loading procedural_data.json:', error);
    return [];
  }
}

/**
 * Normalize text for matching (lowercase, remove special chars)
 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Check if query matches framework keywords
 */
function matchesFramework(query: string, framework: Framework): boolean {
  const normalizedQuery = normalizeText(query);
  const normalizedId = normalizeText(framework.id);
  const normalizedTitle = normalizeText(framework.title);
  
  // Extract key terms from framework title
  const titleWords = normalizedTitle.split(' ').filter(w => w.length > 3);
  
  // Check direct matches
  if (normalizedQuery.includes(normalizedId) || normalizedQuery.includes(normalizedTitle)) {
    return true;
  }
  
  // Check for key framework terms
  const frameworkKeywords: Record<string, string[]> = {
    'sans-incident-response': ['incident response', 'incident', 'sans', 'response process', 'security incident'],
    'sdlc-waterfall': ['sdlc', 'software development', 'development lifecycle', 'waterfall', 'software lifecycle', 'development process'],
    'nist-rmf': ['rmf', 'risk management', 'risk management framework', 'nist rmf', 'nist risk', 'risk framework']
  };
  
  const keywords = frameworkKeywords[framework.id] || [];
  const matchingKeywords = keywords.filter(keyword => normalizedQuery.includes(keyword));
  
  return matchingKeywords.length > 0;
}

/**
 * Check if query appears to be asking for procedural steps
 */
function isProceduralQuery(query: string): boolean {
  const normalizedQuery = normalizeText(query);
  const proceduralKeywords = [
    'steps',
    'phases',
    'process',
    'walk me through',
    'walk through',
    'how would you',
    'how do you',
    'explain the process',
    'explain the steps',
    'what are the steps',
    'what are the phases',
    'describe the process',
    'describe the steps'
  ];
  
  return proceduralKeywords.some(keyword => normalizedQuery.includes(keyword));
}

/**
 * Get procedural steps for a given topic
 * Returns the matching framework or null if not found
 */
export function getProceduralSteps(topic: string): Framework | null {
  const frameworks = loadProceduralData();
  
  if (!isProceduralQuery(topic)) {
    return null;
  }
  
  // Find matching framework
  const matchingFramework = frameworks.find(framework => 
    matchesFramework(topic, framework)
  );
  
  return matchingFramework || null;
}

/**
 * Format framework as a response string with first-person voice
 */
export function formatProceduralResponse(framework: Framework): string {
  // Start with an "I statement" summary
  let response = `I follow the ${framework.title}. ${framework.summary}\n\n`;
  
  response += `Here's how I approach it through ${framework.phases.length} key phases:\n\n`;
  
  // Format each phase as a numbered list with clear markdown formatting
  framework.phases.forEach((phase) => {
    response += `**Phase ${phase.phase_number}: ${phase.phase_name}**\n\n`;
    response += `${phase.description}\n\n`;
  });
  
  return response.trim();
}

