/**
 * Claw LLM Router — Prompt Classifier
 *
 * 15-dimension weighted scoring. Runs 100% locally in <1ms.
 * No external API calls. Translated from classifier.py.
 */

// ── Keyword lists ─────────────────────────────────────────────────────────────

const CODE_KEYWORDS = [
  "function",
  "class",
  "import",
  "def",
  "select",
  "async",
  "await",
  "const",
  "let",
  "var",
  "return",
  "```",
];
const REASONING_KEYWORDS = [
  "prove",
  "theorem",
  "derive",
  "step by step",
  "chain of thought",
  "formally",
  "mathematical",
  "proof",
  "logically",
];
const SIMPLE_KEYWORDS = [
  "what is",
  "define",
  "translate",
  "hello",
  "yes or no",
  "capital of",
  "how old",
  "who is",
  "when was",
];
const TECHNICAL_KEYWORDS = [
  "algorithm",
  "optimize",
  "architecture",
  "distributed",
  "kubernetes",
  "microservice",
  "database",
  "infrastructure",
];
const CREATIVE_KEYWORDS = [
  "story",
  "poem",
  "compose",
  "brainstorm",
  "creative",
  "imagine",
  "write a",
];
const IMPERATIVE_VERBS = [
  "build",
  "create",
  "implement",
  "design",
  "develop",
  "construct",
  "generate",
  "deploy",
  "configure",
  "set up",
];
const CONSTRAINT_INDICATORS = [
  "under",
  "at most",
  "at least",
  "within",
  "no more than",
  "maximum",
  "minimum",
  "limit",
  "budget",
];
const OUTPUT_FORMAT_KEYWORDS = [
  "json",
  "yaml",
  "xml",
  "table",
  "csv",
  "markdown",
  "schema",
  "format as",
  "structured",
];
const REFERENCE_KEYWORDS = [
  "above",
  "below",
  "previous",
  "following",
  "the docs",
  "the api",
  "the code",
  "earlier",
  "attached",
];
const NEGATION_KEYWORDS = [
  "don't",
  "do not",
  "avoid",
  "never",
  "without",
  "except",
  "exclude",
  "no longer",
];
const DOMAIN_SPECIFIC_KEYWORDS = [
  "quantum",
  "fpga",
  "vlsi",
  "risc-v",
  "asic",
  "photonics",
  "genomics",
  "proteomics",
  "topological",
  "homomorphic",
  "zero-knowledge",
];
const AGENTIC_TASK_KEYWORDS = [
  "read file",
  "look at",
  "check the",
  "open the",
  "edit",
  "modify",
  "update the",
  "change the",
  "write to",
  "create file",
  "execute",
  "deploy",
  "install",
  "npm",
  "pip",
  "compile",
  "after that",
  "once done",
  "step 1",
  "step 2",
  "fix",
  "debug",
  "until it works",
  "iterate",
  "make sure",
  "verify",
  "confirm",
];
const MULTI_STEP_PATTERNS = [/first.*then/i, /step\s+\d/i, /\d\.\s/];

// ── Weights (must sum to 1.0) ─────────────────────────────────────────────────

// Weights aligned with ClawRouter (14 dims), scaled to fit our 15th (agenticTask)
const WEIGHTS: Record<string, number> = {
  reasoningMarkers: 0.17, // ClawRouter: 0.18
  codePresence: 0.14, // ClawRouter: 0.15
  simpleIndicators: 0.11, // ClawRouter: 0.12  (was 0.02 — key change)
  multiStepPatterns: 0.11, // ClawRouter: 0.12
  technicalTerms: 0.09, // ClawRouter: 0.10
  tokenCount: 0.08, // ClawRouter: 0.08
  agenticTask: 0.06, // ours only (not in ClawRouter)
  creativeMarkers: 0.05, // ClawRouter: 0.05
  questionComplexity: 0.04, // ClawRouter: 0.05
  constraintCount: 0.04, // ClawRouter: 0.04
  imperativeVerbs: 0.03, // ClawRouter: 0.03
  outputFormat: 0.03, // ClawRouter: 0.03
  domainSpecificity: 0.02, // ClawRouter: 0.02
  referenceComplexity: 0.02, // ClawRouter: 0.02
  negationComplexity: 0.01, // ClawRouter: 0.01
};

// ── Tier boundaries ───────────────────────────────────────────────────────────

const SIMPLE_MEDIUM_BOUNDARY = 0.0;
const MEDIUM_COMPLEX_BOUNDARY = 0.3;
const COMPLEX_REASONING_BOUNDARY = 0.5;
const CONFIDENCE_STEEPNESS = 12.0;
const MAX_TOKENS_FORCE_COMPLEX = 100_000;

export type Tier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";

export type ClassificationResult = {
  tier: Tier;
  confidence: number;
  score: number;
  signals: string[];
  reasoningMatches: number;
};

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-CONFIDENCE_STEEPNESS * x));
}

function countKeywords(text: string, keywords: string[]): string[] {
  return keywords.filter((kw) => text.includes(kw));
}

function scoreKeywords(
  text: string,
  keywords: string[],
  lowThreshold: number,
  highThreshold: number,
  scoreNone: number,
  scoreLow: number,
  scoreHigh: number,
  label: string,
): [number, string | null] {
  const matches = countKeywords(text, keywords);
  if (matches.length >= highThreshold) {
    return [scoreHigh, `${label} (${matches.slice(0, 3).join(", ")})`];
  }
  if (matches.length >= lowThreshold) {
    return [scoreLow, `${label} (${matches.slice(0, 3).join(", ")})`];
  }
  return [scoreNone, null];
}

export function classify(prompt: string, _systemPrompt?: string): ClassificationResult {
  const userText = prompt.toLowerCase();

  const estimatedTokens = Math.floor(userText.length / 4);
  const signals: string[] = [];
  const dimScores: Record<string, number> = {};

  // 1. Token count
  if (estimatedTokens < 50) {
    dimScores.tokenCount = -1.0;
    signals.push(`short (${estimatedTokens} tokens)`);
  } else if (estimatedTokens > 500) {
    dimScores.tokenCount = 1.0;
    signals.push(`long (${estimatedTokens} tokens)`);
  } else {
    dimScores.tokenCount = 0.0;
  }

  // 2. Code presence
  {
    const [score, sig] = scoreKeywords(userText, CODE_KEYWORDS, 1, 2, 0, 0.5, 1.0, "code");
    dimScores.codePresence = score;
    if (sig) signals.push(sig);
  }

  // 3. Reasoning markers (user prompt only)
  {
    const matches = countKeywords(userText, REASONING_KEYWORDS);
    if (matches.length >= 2) {
      dimScores.reasoningMarkers = 1.0;
      signals.push(`reasoning (${matches.slice(0, 3).join(", ")})`);
    } else if (matches.length === 1) {
      dimScores.reasoningMarkers = 0.7;
      signals.push(`reasoning (${matches[0]})`);
    } else {
      dimScores.reasoningMarkers = 0.0;
    }
  }

  const reasoningMatchCount = countKeywords(userText, REASONING_KEYWORDS).length;

  // 4. Technical terms
  {
    const [score, sig] = scoreKeywords(
      userText,
      TECHNICAL_KEYWORDS,
      2,
      4,
      0,
      0.5,
      1.0,
      "technical",
    );
    dimScores.technicalTerms = score;
    if (sig) signals.push(sig);
  }

  // 5. Creative markers
  {
    const [score, sig] = scoreKeywords(userText, CREATIVE_KEYWORDS, 1, 2, 0, 0.5, 0.7, "creative");
    dimScores.creativeMarkers = score;
    if (sig) signals.push(sig);
  }

  // 6. Simple indicators (negative signal)
  {
    const [score, sig] = scoreKeywords(userText, SIMPLE_KEYWORDS, 1, 2, 0, -1.0, -1.0, "simple");
    dimScores.simpleIndicators = score;
    if (sig) signals.push(sig);
  }

  // 7. Multi-step patterns
  if (MULTI_STEP_PATTERNS.some((p) => p.test(userText))) {
    dimScores.multiStepPatterns = 0.5;
    signals.push("multi-step");
  } else {
    dimScores.multiStepPatterns = 0.0;
  }

  // 8. Question complexity
  const qCount = (prompt.match(/\?/g) ?? []).length;
  dimScores.questionComplexity = qCount > 3 ? 0.5 : 0.0;
  if (qCount > 3) signals.push(`${qCount} questions`);

  // 9. Imperative verbs
  {
    const [score, sig] = scoreKeywords(userText, IMPERATIVE_VERBS, 1, 2, 0, 0.3, 0.5, "imperative");
    dimScores.imperativeVerbs = score;
    if (sig) signals.push(sig);
  }

  // 10. Constraint indicators
  {
    const [score, sig] = scoreKeywords(
      userText,
      CONSTRAINT_INDICATORS,
      1,
      3,
      0,
      0.3,
      0.7,
      "constraints",
    );
    dimScores.constraintCount = score;
    if (sig) signals.push(sig);
  }

  // 11. Output format keywords
  {
    const [score, sig] = scoreKeywords(
      userText,
      OUTPUT_FORMAT_KEYWORDS,
      1,
      2,
      0,
      0.4,
      0.7,
      "format",
    );
    dimScores.outputFormat = score;
    if (sig) signals.push(sig);
  }

  // 12. Reference complexity
  {
    const [score, sig] = scoreKeywords(
      userText,
      REFERENCE_KEYWORDS,
      1,
      2,
      0,
      0.3,
      0.5,
      "references",
    );
    dimScores.referenceComplexity = score;
    if (sig) signals.push(sig);
  }

  // 13. Negation complexity
  {
    const [score, sig] = scoreKeywords(userText, NEGATION_KEYWORDS, 2, 3, 0, 0.3, 0.5, "negation");
    dimScores.negationComplexity = score;
    if (sig) signals.push(sig);
  }

  // 14. Domain specificity
  {
    const [score, sig] = scoreKeywords(
      userText,
      DOMAIN_SPECIFIC_KEYWORDS,
      1,
      2,
      0,
      0.5,
      0.8,
      "domain-specific",
    );
    dimScores.domainSpecificity = score;
    if (sig) signals.push(sig);
  }

  // 15. Agentic task
  {
    const matches = countKeywords(userText, AGENTIC_TASK_KEYWORDS);
    if (matches.length >= 4) {
      dimScores.agenticTask = 1.0;
      signals.push(`agentic (${matches.slice(0, 3).join(", ")})`);
    } else if (matches.length >= 2) {
      dimScores.agenticTask = 0.5;
      signals.push(`agentic (${matches.slice(0, 2).join(", ")})`);
    } else {
      dimScores.agenticTask = 0.0;
    }
  }

  // ── Weighted sum ──────────────────────────────────────────────────────────
  const weightedScore = Object.entries(dimScores).reduce(
    (sum, [dim, score]) => sum + (WEIGHTS[dim] ?? 0) * score,
    0,
  );

  // ── Special overrides ─────────────────────────────────────────────────────

  // Large context → force COMPLEX
  if (estimatedTokens > MAX_TOKENS_FORCE_COMPLEX) {
    signals.push(`large context (${estimatedTokens} tokens) → COMPLEX`);
    return {
      tier: "COMPLEX",
      confidence: 0.95,
      score: weightedScore,
      signals,
      reasoningMatches: reasoningMatchCount,
    };
  }

  // 2+ reasoning keywords → force REASONING
  if (reasoningMatchCount >= 2) {
    const conf = Math.max(sigmoid(weightedScore), 0.85);
    signals.push(`reasoning override (${reasoningMatchCount} markers)`);
    return {
      tier: "REASONING",
      confidence: conf,
      score: weightedScore,
      signals,
      reasoningMatches: reasoningMatchCount,
    };
  }

  // Strong complexity signals → force COMPLEX
  // (mirrors the REASONING override pattern)
  const techMatches = countKeywords(userText, TECHNICAL_KEYWORDS);
  const imperativeMatches = countKeywords(userText, IMPERATIVE_VERBS);
  const agenticMatches = countKeywords(userText, AGENTIC_TASK_KEYWORDS);
  const complexitySignals = techMatches.length + imperativeMatches.length + agenticMatches.length;
  const hasMultiStep = MULTI_STEP_PATTERNS.some((p) => p.test(userText));
  const isLongPrompt = userText.length > 300;

  if (complexitySignals >= 4 && (hasMultiStep || isLongPrompt)) {
    const conf = Math.max(sigmoid(weightedScore), 0.85);
    signals.push(
      `complex override (${complexitySignals} signals: ${[...techMatches, ...imperativeMatches].slice(0, 3).join(", ")})`,
    );
    return {
      tier: "COMPLEX",
      confidence: conf,
      score: weightedScore,
      signals,
      reasoningMatches: reasoningMatchCount,
    };
  }

  // ── Map score to tier ─────────────────────────────────────────────────────
  let tier: Tier;
  let distance: number;

  if (weightedScore < SIMPLE_MEDIUM_BOUNDARY) {
    tier = "SIMPLE";
    distance = SIMPLE_MEDIUM_BOUNDARY - weightedScore;
  } else if (weightedScore < MEDIUM_COMPLEX_BOUNDARY) {
    tier = "MEDIUM";
    distance = Math.min(
      weightedScore - SIMPLE_MEDIUM_BOUNDARY,
      MEDIUM_COMPLEX_BOUNDARY - weightedScore,
    );
  } else if (weightedScore < COMPLEX_REASONING_BOUNDARY) {
    tier = "COMPLEX";
    distance = Math.min(
      weightedScore - MEDIUM_COMPLEX_BOUNDARY,
      COMPLEX_REASONING_BOUNDARY - weightedScore,
    );
  } else {
    tier = "REASONING";
    distance = weightedScore - COMPLEX_REASONING_BOUNDARY;
  }

  const confidence = sigmoid(distance);

  return {
    tier,
    confidence,
    score: weightedScore,
    signals,
    reasoningMatches: reasoningMatchCount,
  };
}

/** Map a virtual model id to a forced tier override (undefined = use classifier) */
export function tierFromModelId(modelId: string): Tier | undefined {
  const id = modelId.replace("claw-llm-router/", "").toLowerCase();
  const map: Record<string, Tier> = {
    simple: "SIMPLE",
    medium: "MEDIUM",
    complex: "COMPLEX",
    reasoning: "REASONING",
  };
  return map[id];
}

/** Fallback chain: if a tier fails, try the next one up */
export const FALLBACK_CHAIN: Record<Tier, Tier[]> = {
  SIMPLE: ["SIMPLE", "MEDIUM", "COMPLEX"],
  MEDIUM: ["MEDIUM", "COMPLEX"],
  COMPLEX: ["COMPLEX", "REASONING"],
  REASONING: ["REASONING"],
};
