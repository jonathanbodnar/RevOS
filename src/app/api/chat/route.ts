import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Internal assistant.
 *
 * Two modes, both PHI-safe:
 *  - "elearning": keyword search over the user's visible training modules.
 *    When ANTHROPIC_API_KEY is set, the retrieved (non-PHI) module text is
 *    summarized into a direct answer; otherwise the matching modules are
 *    returned as links. No customer data is ever involved here.
 *  - "data": a whitelist of AGGREGATE, non-PHI answers scoped to the user's
 *    clinic (counts only — never an individual patient's details). This is the
 *    safe subset; richer customer-aware tool use stays gated behind a BAA'd
 *    model backend and PHI tokenization (not enabled here).
 *
 * Every exchange is logged to ChatLog (question + answer + non-PHI metadata).
 */
const Body = z.object({
  question: z.string().trim().min(1).max(1000),
  mode: z.enum(["elearning", "data"]).default("elearning"),
});

function audiencesFor(role: string): string[] {
  if (role === "PROVIDER") return ["BOTH", "PROVIDER"];
  return ["BOTH", "CLINIC_ADMIN"];
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { question, mode } = parsed.data;
  const clinicId = session.user.effectiveClinicId;

  let answer: string;
  let sources: { id: string; title: string }[] = [];
  let usedLlm = false;

  if (mode === "data") {
    answer = await answerDataQuestion(question, clinicId);
  } else {
    const result = await answerLearningQuestion(
      question,
      audiencesFor(session.user.originalRole),
    );
    answer = result.answer;
    sources = result.sources;
    usedLlm = result.usedLlm;
  }

  // Log the exchange (never contains PHI: elearning is non-PHI, data is
  // aggregate counts only).
  await prisma.chatLog
    .create({
      data: {
        userId: session.user.id,
        clinicId: clinicId ?? null,
        question,
        answer,
        mode,
        metadata: JSON.stringify({
          usedLlm,
          sourceIds: sources.map((s) => s.id),
        }),
      },
    })
    .catch(() => {});

  return NextResponse.json({ data: { answer, sources } });
}

// ── eLearning RAG (non-PHI) ──────────────────────────────────────────────────
async function answerLearningQuestion(
  question: string,
  audiences: string[],
): Promise<{ answer: string; sources: { id: string; title: string }[]; usedLlm: boolean }> {
  const modules = await prisma.learningModule.findMany({
    where: { publishedAt: { not: null }, audience: { in: audiences } },
    select: { id: true, title: true, summary: true, bodyHtml: true },
  });
  const terms = question
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  const scored = modules
    .map((m) => {
      const hay = `${m.title} ${m.summary ?? ""} ${m.bodyHtml ?? ""}`.toLowerCase();
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (scored.length === 0) {
    return {
      answer:
        "I couldn't find a training module about that. Try different wording, or browse Training in the sidebar.",
      sources: [],
      usedLlm: false,
    };
  }
  const sources = scored.map((s) => ({ id: s.m.id, title: s.m.title }));

  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    const llm = await askAnthropic(key, question, scored.map((s) => s.m));
    if (llm) return { answer: llm, sources, usedLlm: true };
  }
  // No LLM (or it failed): return the matched modules directly.
  return {
    answer:
      "Here are the training modules most relevant to your question — open one from Training for the full detail.",
    sources,
    usedLlm: false,
  };
}

async function askAnthropic(
  key: string,
  question: string,
  modules: { title: string; summary: string | null; bodyHtml: string | null }[],
): Promise<string | null> {
  const context = modules
    .map((m) => `# ${m.title}\n${m.summary ?? ""}\n${m.bodyHtml ?? ""}`)
    .join("\n\n---\n\n")
    .slice(0, 12000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.CHAT_MODEL || "claude-sonnet-5",
        max_tokens: 600,
        system:
          "You are RevOS's internal help assistant for clinic staff. Answer ONLY from the training content provided. If it isn't covered, say so. Never invent policy. Keep answers short and practical. The content contains no patient data; never ask for or output patient information.",
        messages: [
          {
            role: "user",
            content: `Training content:\n\n${context}\n\nQuestion: ${question}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    const text = json.content?.find((c) => c.type === "text")?.text;
    return text?.trim() || null;
  } catch {
    return null;
  }
}

// ── Aggregate data answers (non-PHI, clinic-scoped) ──────────────────────────
async function answerDataQuestion(
  question: string,
  clinicId: string | null,
): Promise<string> {
  if (!clinicId) {
    return "Switch into a clinic to ask about its patients.";
  }
  const q = question.toLowerCase();

  if (/(active|how many).*patient|patient.*(count|how many)/.test(q)) {
    const n = await prisma.customer.count({ where: { clinicId, isActive: true } });
    return `This clinic has ${n} active patient${n === 1 ? "" : "s"}.`;
  }
  if (/flag|at.?risk/.test(q)) {
    const n = await prisma.kPIFlag.count({ where: { clinicId, status: "open" } });
    return `There ${n === 1 ? "is" : "are"} ${n} open at-risk flag${n === 1 ? "" : "s"}. See “At-risk patients” in the sidebar.`;
  }
  if (/subscription|recurring/.test(q)) {
    const n = await prisma.subscription.count({
      where: { clinicId, status: "active" },
    });
    return `There ${n === 1 ? "is" : "are"} ${n} active subscription${n === 1 ? "" : "s"} in this clinic.`;
  }
  return "I can answer aggregate questions like “how many active patients”, “how many open flags”, or “active subscriptions”. For an individual patient, open their profile — I don't surface patient details in chat.";
}
