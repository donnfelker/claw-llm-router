import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify, tierFromModelId, FALLBACK_CHAIN } from "../classifier.js";

describe("classify", () => {
  describe("tier boundaries", () => {
    it("classifies short factual questions as SIMPLE", () => {
      const result = classify("What is the capital of France?");
      assert.equal(result.tier, "SIMPLE");
      assert.ok(result.confidence > 0.5);
    });

    it("classifies greetings as SIMPLE", () => {
      const result = classify("hello");
      assert.equal(result.tier, "SIMPLE");
    });

    it("classifies definitions as SIMPLE", () => {
      const result = classify("define photosynthesis");
      assert.equal(result.tier, "SIMPLE");
    });

    it("classifies code questions as MEDIUM or higher", () => {
      const result = classify("Write a function to sort an array in JavaScript");
      assert.ok(
        result.tier === "MEDIUM" || result.tier === "COMPLEX",
        `Expected MEDIUM or COMPLEX, got ${result.tier}`,
      );
    });

    it("classifies multi-file architecture as COMPLEX", () => {
      const result = classify(
        "Design a microservice architecture with Kubernetes for a distributed database system. " +
          "Create the deployment configs, implement the service mesh, and set up monitoring. " +
          "First create the base infrastructure, then deploy the services, and configure load balancing.",
      );
      assert.ok(
        result.tier === "COMPLEX" || result.tier === "REASONING",
        `Expected COMPLEX or REASONING, got ${result.tier}`,
      );
    });

    it("classifies mathematical proofs as REASONING", () => {
      const result = classify(
        "Prove the theorem that for any prime p, the group Z/pZ is a field. " +
          "Derive the proof step by step using formal logic and mathematical induction.",
      );
      assert.equal(result.tier, "REASONING");
    });
  });

  describe("COMPLEX override", () => {
    it("forces COMPLEX when many technical + imperative + agentic signals with multi-step", () => {
      const result = classify(
        "Build a distributed microservice architecture. First, design the database schema. " +
          "Then create the API endpoints and deploy to Kubernetes. Configure the infrastructure " +
          "and set up monitoring. Step 1: create the base. Step 2: implement services.",
      );
      assert.ok(
        result.tier === "COMPLEX" || result.tier === "REASONING",
        `Expected COMPLEX or REASONING, got ${result.tier}`,
      );
      assert.ok(result.confidence >= 0.85);
    });
  });

  describe("packed context detection", () => {
    it("scores on user text only (not system prompt)", () => {
      // The classifier should only score the user prompt, not system prompt
      const simpleResult = classify("hello");
      const withSystemResult = classify(
        "hello",
        "You are a complex system with many technical requirements",
      );
      // The tier should be the same regardless of system prompt
      assert.equal(simpleResult.tier, withSystemResult.tier);
    });
  });

  describe("dimension scoring", () => {
    it("detects code presence", () => {
      const result = classify("function foo() { return class Bar extends Base }");
      assert.ok(result.signals.some((s) => s.includes("code")));
    });

    it("detects reasoning markers", () => {
      const result = classify("prove this theorem step by step");
      assert.ok(result.signals.some((s) => s.includes("reasoning")));
    });

    it("detects simple indicators", () => {
      const result = classify("what is the meaning of life?");
      assert.ok(result.signals.some((s) => s.includes("simple")));
    });

    it("detects agentic tasks", () => {
      const result = classify("read file, look at the code, edit the config, and fix the bug");
      assert.ok(result.signals.some((s) => s.includes("agentic")));
    });

    it("detects multi-step patterns", () => {
      const result = classify("first create the file then add the content");
      assert.ok(result.signals.some((s) => s.includes("multi-step")));
    });

    it("detects long prompts", () => {
      const longPrompt = "explain this concept in detail ".repeat(100);
      const result = classify(longPrompt);
      assert.ok(result.signals.some((s) => s.includes("long")));
    });

    it("detects short prompts", () => {
      const result = classify("hi");
      assert.ok(result.signals.some((s) => s.includes("short")));
    });
  });

  describe("confidence", () => {
    it("returns confidence between 0.5 and 1.0", () => {
      const result = classify("help me with this");
      assert.ok(result.confidence >= 0.5);
      assert.ok(result.confidence <= 1.0);
    });

    it("simple prompts have high confidence with wider MEDIUM band", () => {
      const result = classify("what is 2+2?");
      // With wider MEDIUM band (boundary at -0.05), simple prompts
      // should land deeper in SIMPLE territory → higher confidence
      assert.ok(result.confidence > 0.6);
    });
  });

  describe("result shape", () => {
    it("returns all expected fields", () => {
      const result = classify("hello world");
      assert.ok("tier" in result);
      assert.ok("confidence" in result);
      assert.ok("score" in result);
      assert.ok("signals" in result);
      assert.ok("reasoningMatches" in result);
      assert.ok(!("needsLlmClassification" in result));
      assert.ok(Array.isArray(result.signals));
      assert.equal(typeof result.confidence, "number");
      assert.equal(typeof result.score, "number");
    });
  });
});

describe("tierFromModelId", () => {
  it("maps 'simple' to SIMPLE", () => assert.equal(tierFromModelId("simple"), "SIMPLE"));
  it("maps 'medium' to MEDIUM", () => assert.equal(tierFromModelId("medium"), "MEDIUM"));
  it("maps 'complex' to COMPLEX", () => assert.equal(tierFromModelId("complex"), "COMPLEX"));
  it("maps 'reasoning' to REASONING", () =>
    assert.equal(tierFromModelId("reasoning"), "REASONING"));
  it("maps 'auto' to undefined", () => assert.equal(tierFromModelId("auto"), undefined));
  it("strips claw-llm-router/ prefix", () =>
    assert.equal(tierFromModelId("claw-llm-router/simple"), "SIMPLE"));
  it("is case-insensitive", () => assert.equal(tierFromModelId("SIMPLE"), "SIMPLE"));
});

describe("FALLBACK_CHAIN", () => {
  it("SIMPLE falls back to MEDIUM then COMPLEX", () => {
    assert.deepEqual(FALLBACK_CHAIN.SIMPLE, ["SIMPLE", "MEDIUM", "COMPLEX"]);
  });

  it("MEDIUM falls back to COMPLEX", () => {
    assert.deepEqual(FALLBACK_CHAIN.MEDIUM, ["MEDIUM", "COMPLEX"]);
  });

  it("COMPLEX falls back to REASONING", () => {
    assert.deepEqual(FALLBACK_CHAIN.COMPLEX, ["COMPLEX", "REASONING"]);
  });

  it("REASONING has no fallback", () => {
    assert.deepEqual(FALLBACK_CHAIN.REASONING, ["REASONING"]);
  });
});
