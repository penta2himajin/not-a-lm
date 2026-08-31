/**
 * P0: warm models and sample reply RTT breakdowns (trace.timingMs).
 */
import { writeFileSync } from "node:fs";

const BASE = process.env.NALM_BASE || "http://localhost:43123";

async function status() {
  return fetch(`${BASE}/api/status`).then((r) => r.json());
}

async function warm() {
  await fetch(`${BASE}/api/status`, { method: "POST" }).catch(() => {});
  for (let i = 0; i < 90; i++) {
    const st = await status();
    const ok =
      st.status?.backend === "dense" && st.rerankerReady && st.nliReady;
    console.log(
      `warm ${i}`,
      st.status?.backend,
      `dense=${st.denseReady}`,
      `rr=${st.rerankerReady}`,
      `nli=${st.nliReady}`,
    );
    if (ok) return st;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("models not ready");
}

async function chat(userText, { generate = true, history = [], resetSession = false } = {}) {
  const wall0 = performance.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      history,
      userText,
      generate,
      resetSession,
    }),
  });
  const wallMs = Math.round(performance.now() - wall0);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { wallMs, data };
}

const CASES = [
  { id: "off-who", generate: false, q: "お前誰？" },
  { id: "on-who", generate: true, q: "お前誰？" },
  { id: "on-mech", generate: true, q: "仕組み教えて" },
  { id: "on-negate-rag", generate: true, q: "あなたはRAGで生成しているの？" },
  {
    id: "on-fuse",
    generate: true,
    q: "RAGで生成しているのと、既存の似た手法は？",
  },
  { id: "on-en-who", generate: true, q: "Who are you?" },
  { id: "on-zh-who", generate: true, q: "你是谁？" },
];

const rows = [];
await warm();

// Discard first generate call (extra JIT / cache fill)
console.log("prime…");
await chat("こんにちは", { generate: true, resetSession: true });

for (const c of CASES) {
  // 3 warm trials; report median by total
  const trials = [];
  for (let t = 0; t < 3; t++) {
    const { wallMs, data } = await chat(c.q, {
      generate: c.generate,
      resetSession: true,
    });
    const tr = data.trace || {};
    trials.push({
      wallMs,
      latencyMs: tr.latencyMs,
      timingMs: tr.timingMs || {},
      operation: tr.operation,
      generated: tr.generated,
      backend: data.backend,
      claim: tr.chosen?.chunk?.claim,
      text: (data.message?.text || "").slice(0, 60),
    });
  }
  trials.sort((a, b) => (a.timingMs.total ?? a.latencyMs) - (b.timingMs.total ?? b.latencyMs));
  const mid = trials[1];
  rows.push({
    id: c.id,
    generate: c.generate,
    q: c.q,
    ...mid,
    trials: trials.map((t) => t.timingMs.total ?? t.latencyMs),
  });
  console.log(
    c.id,
    "median total",
    mid.timingMs.total,
    "wall",
    mid.wallMs,
    "op",
    mid.operation,
    mid.timingMs,
  );
}

const out = {
  at: new Date().toISOString(),
  base: BASE,
  rows,
};
writeFileSync("/opt/cursor/artifacts/p0_rtt_bench.json", JSON.stringify(out, null, 2));

// Markdown-ish table to stdout
console.log("\n=== median timingMs (engine) ===");
const keys = [
  "total",
  "queryEmbed",
  "retrieve",
  "gate",
  "polarity",
  "fuse",
  "fuseRerank",
  "fusePlan",
  "single",
  "spanEmbed",
  "spanNli",
  "selectRender",
];
console.log(["case", "wall", "op", ...keys].join("\t"));
for (const r of rows) {
  console.log(
    [
      r.id,
      r.wallMs,
      r.operation || "-",
      ...keys.map((k) => r.timingMs[k] ?? ""),
    ].join("\t"),
  );
}
