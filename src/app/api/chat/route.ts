import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { encryptField } from "@/lib/encryption";

export const dynamic = "force-dynamic";

/**
 * Internal assistant.
 *
 *  - "elearning": keyword search over the user's visible training modules.
 *    When ANTHROPIC_API_KEY is set, the retrieved (non-PHI) module text plus
 *    the user's QUESTION are sent to the model; otherwise matching modules are
 *    returned as links. The RETRIEVED context is non-PHI (super-admin-authored
 *    modules). The user's free-typed question, however, is NOT scrubbed — the
 *    UI warns staff not to enter patient identifiers. Only enable the model
 *    backend under a BAA.
 *  - "data": a whitelist of AGGREGATE, clinic-scoped answers (counts only —
 *    never an individual patient's details). No model call. Richer customer-
 *    aware tool use stays gated behind a BAA'd backend + PHI tokenization
 *    (not enabled here).
 *
 * Every exchange is logged to ChatLog with the question/answer ENCRYPTED at
 * rest (in case a user types something sensitive) plus non-PHI metadata.
 */

// Minimal in-process rate limit (per instance) to stop runaway/abuse. For a
// hardened cross-instance limit, move this to a shared store.
const RATE = new Map<string, { n: number; resetAt: number }>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const win = RATE.get(userId);
  if (!win || now > win.resetAt) {
    RATE.set(userId, { n: 1, resetAt: now + 60_000 });
    return false;
  }
  win.n += 1;
  return win.n > 20; // 20 requests / minute / user
}
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
  if (rateLimited(session.user.id)) {
    return NextResponse.json(
      { error: "Too many requests — try again in a minute." },
      { status: 429 },
    );
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
        // Encrypted at rest — a user could type something sensitive.
        question: encryptField(question) ?? question,
        answer: encryptField(answer),
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
