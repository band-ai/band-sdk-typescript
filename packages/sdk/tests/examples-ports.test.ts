import { describe, expect, it, vi } from "vitest";

// ── Mocks for optional peer deps used by the new scenarios ────────────────
// These keep the imports cheap and let us instantiate the example factories
// without network or real provider SDKs.

vi.mock("@langchain/openai", () => {
  class ChatOpenAI {
    public readonly model: string;
    public constructor(opts: { model: string }) {
      this.model = opts.model;
    }
  }
  return { ChatOpenAI };
});

vi.mock("@langchain/anthropic", () => {
  class ChatAnthropic {
    public readonly model: string;
    public constructor(opts: { model: string }) {
      this.model = opts.model;
    }
  }
  return { ChatAnthropic };
});

vi.mock("parlant-client", () => {
  class ParlantClient {
    public readonly agents = {
      create: async (req: { name: string }) => ({
        id: `stub-parlant-${req.name}`,
      }),
    };
    public readonly guidelines = {
      create: async () => ({ id: "stub-guideline" }),
    };
    public constructor(_opts: { environment: string }) {}
  }
  return { ParlantClient };
});

// ── langgraph 01–08 ───────────────────────────────────────────────────────

describe("langgraph numbered scenarios", () => {
  it("01-simple-agent builds an agent", async () => {
    const { createSimpleAgent } = await import(
      "../examples/langgraph/01-simple-agent"
    );
    const agent = await createSimpleAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("02-custom-tools builds an agent with calculator + weather tools", async () => {
    const { createCustomToolsAgent } = await import(
      "../examples/langgraph/02-custom-tools"
    );
    const agent = await createCustomToolsAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("03-custom-personality builds the pirate agent", async () => {
    const { createPirateAgent } = await import(
      "../examples/langgraph/03-custom-personality"
    );
    const agent = await createPirateAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("04-calculator-as-tool builds an agent with the calculator subgraph", async () => {
    const { createCalculatorAgent } = await import(
      "../examples/langgraph/04-calculator-as-tool"
    );
    const agent = await createCalculatorAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("05-rag-as-tool builds an agent with the RAG-stub tool", async () => {
    const { createRagAgent } = await import(
      "../examples/langgraph/05-rag-as-tool"
    );
    const agent = await createRagAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("06-delegate-to-sql-agent builds an agent with the SQL-stub tool", async () => {
    const { createSqlAgent } = await import(
      "../examples/langgraph/06-delegate-to-sql-agent"
    );
    const agent = await createSqlAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("07-tom-agent builds Tom", async () => {
    const { createTomAgent } = await import(
      "../examples/langgraph/07-tom-agent"
    );
    const agent = await createTomAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("08-jerry-agent builds Jerry", async () => {
    const { createJerryAgent } = await import(
      "../examples/langgraph/08-jerry-agent"
    );
    const agent = await createJerryAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });
});

// ── parlant 01–05 ─────────────────────────────────────────────────────────

describe("parlant numbered scenarios", () => {
  const env = "http://localhost:8800";

  it("01-basic-agent provisions a parlant agent and builds the Thenvoi agent", async () => {
    process.env.PARLANT_ENVIRONMENT = env;
    const { createBasicParlantAgent } = await import(
      "../examples/parlant/01-basic-agent"
    );
    const agent = await createBasicParlantAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("02-with-guidelines builds the comprehensive-guidelines agent", async () => {
    process.env.PARLANT_ENVIRONMENT = env;
    const { createGuidelinesAgent } = await import(
      "../examples/parlant/02-with-guidelines"
    );
    const agent = await createGuidelinesAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("03-support-agent builds the support persona", async () => {
    process.env.PARLANT_ENVIRONMENT = env;
    const { createSupportAgent } = await import(
      "../examples/parlant/03-support-agent"
    );
    const agent = await createSupportAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("04-tom-agent builds Tom (Parlant)", async () => {
    process.env.PARLANT_ENVIRONMENT = env;
    const { createTomAgent } = await import(
      "../examples/parlant/04-tom-agent"
    );
    const agent = await createTomAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("05-jerry-agent builds Jerry (Parlant)", async () => {
    process.env.PARLANT_ENVIRONMENT = env;
    const { createJerryAgent } = await import(
      "../examples/parlant/05-jerry-agent"
    );
    const agent = await createJerryAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });
});

// ── 20-questions-arena ────────────────────────────────────────────────────

describe("20-questions-arena", () => {
  it("thinker-agent builds the thinker", async () => {
    process.env.OPENAI_API_KEY = "test";
    const { createThinkerAgent } = await import(
      "../examples/20-questions-arena/thinker-agent"
    );
    const agent = await createThinkerAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("guesser-agent builds the guesser", async () => {
    process.env.OPENAI_API_KEY = "test";
    const { createGuesserAgent } = await import(
      "../examples/20-questions-arena/guesser-agent"
    );
    const agent = await createGuesserAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });
});

// ── coding-agents (planner + reviewer) ────────────────────────────────────

describe("coding-agents", () => {
  it("planner-agent builds the Claude SDK planner", async () => {
    const { createPlannerAgent } = await import(
      "../examples/coding-agents/planner-agent"
    );
    const agent = await createPlannerAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("reviewer-agent builds the Codex reviewer", async () => {
    const { createReviewerAgent } = await import(
      "../examples/coding-agents/reviewer-agent"
    );
    const agent = await createReviewerAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });
});

// ── opencode + google-adk ─────────────────────────────────────────────────

describe("opencode + google-adk examples", () => {
  it("opencode-agent builds the OpenCode-backed agent", async () => {
    const { createOpencodeAgent } = await import(
      "../examples/opencode/opencode-agent"
    );
    const agent = createOpencodeAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("google-adk-agent builds the ADK-backed agent", async () => {
    const { createGoogleADKAgent } = await import(
      "../examples/google-adk/google-adk-agent"
    );
    const agent = createGoogleADKAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("google-adk 02-custom-instructions builds the research agent", async () => {
    const { createResearchAgent } = await import(
      "../examples/google-adk/02-custom-instructions"
    );
    const agent = createResearchAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("google-adk 03-custom-tools builds the tools agent", async () => {
    const { createToolsAgent } = await import(
      "../examples/google-adk/03-custom-tools"
    );
    const agent = createToolsAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });
});

// ── anthropic numbered scenarios ──────────────────────────────────────────

describe("anthropic numbered scenarios", () => {
  it("02-custom-instructions builds the support agent", async () => {
    const { createSupportAgent } = await import(
      "../examples/anthropic/02-custom-instructions"
    );
    const agent = createSupportAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("03-tom-agent builds Tom (Anthropic)", async () => {
    const { createTomAgent } = await import(
      "../examples/anthropic/03-tom-agent"
    );
    const agent = createTomAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("04-jerry-agent builds Jerry (Anthropic)", async () => {
    const { createJerryAgent } = await import(
      "../examples/anthropic/04-jerry-agent"
    );
    const agent = createJerryAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("05-contact-management builds the contact-managed agent", async () => {
    const { createContactAgent } = await import(
      "../examples/anthropic/05-contact-management"
    );
    const agent = createContactAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("06-custom-tools builds the tools agent (Anthropic)", async () => {
    const { createToolsAgent } = await import(
      "../examples/anthropic/06-custom-tools"
    );
    const agent = createToolsAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });
});

// ── openai + gemini custom-tools scenarios ────────────────────────────────

describe("openai/gemini custom-tools scenarios", () => {
  it("openai 02-custom-tools builds the tools agent", async () => {
    const { createToolsAgent } = await import(
      "../examples/openai/02-custom-tools"
    );
    const agent = createToolsAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("gemini 02-custom-tools builds the tools agent", async () => {
    const { createToolsAgent } = await import(
      "../examples/gemini/02-custom-tools"
    );
    const agent = createToolsAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });
});

// ── claude-sdk numbered scenarios ─────────────────────────────────────────

describe("claude-sdk numbered scenarios", () => {
  it("02-extended-thinking builds the thinking agent", async () => {
    const { createThinkingAgent } = await import(
      "../examples/claude-sdk/02-extended-thinking"
    );
    const agent = createThinkingAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("03-tom-agent builds Tom (Claude SDK)", async () => {
    const { createTomAgent } = await import(
      "../examples/claude-sdk/03-tom-agent"
    );
    const agent = createTomAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("04-jerry-agent builds Jerry (Claude SDK)", async () => {
    const { createJerryAgent } = await import(
      "../examples/claude-sdk/04-jerry-agent"
    );
    const agent = createJerryAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });
});

// ── acp (server + client) ─────────────────────────────────────────────────

describe("acp examples", () => {
  it("acp-server builds the agent + server pair", async () => {
    const { createACPServerExample } = await import(
      "../examples/acp/acp-server"
    );
    const { agent, server } = createACPServerExample();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
    expect(server).toBeDefined();
    expect(typeof server.connectStdio).toBe("function");
  });

  it("acp-client builds an ACPClientAdapter-backed agent", async () => {
    const { createACPClientAgent } = await import(
      "../examples/acp/acp-client"
    );
    const agent = createACPClientAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });
});

// ── debate-agents (Claude advocate + Codex skeptic) ───────────────────────

describe("debate-agents", () => {
  it("advocate-agent builds the Claude advocate", async () => {
    const { createAdvocateAgent } = await import(
      "../examples/debate-agents/advocate-agent"
    );
    const agent = createAdvocateAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("skeptic-agent builds the Codex skeptic", async () => {
    const { createSkepticAgent } = await import(
      "../examples/debate-agents/skeptic-agent"
    );
    const agent = createSkepticAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });
});

// ── triage-coordinator (router + specialists) ────────────────────────────

describe("triage-coordinator", () => {
  it("coordinator-agent builds the routing coordinator", async () => {
    const { createCoordinatorAgent } = await import(
      "../examples/triage-coordinator/coordinator-agent"
    );
    const agent = createCoordinatorAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("frontend-specialist builds the frontend specialist", async () => {
    const { createFrontendAgent } = await import(
      "../examples/triage-coordinator/frontend-specialist"
    );
    const agent = createFrontendAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });

  it("security-specialist builds the security specialist", async () => {
    const { createSecurityAgent } = await import(
      "../examples/triage-coordinator/security-specialist"
    );
    const agent = createSecurityAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.run).toBe("function");
  });
});
