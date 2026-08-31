# Dual-index retrieval (natKey + span secondary)

Stage 1 ranks chunks by **`natKey`** bi-encoder cosine. A **secondary span index** adds author `spans[]` and **auto key-spans** (n-gram TF-IDF hooks) so focus queries that match answer-side vocabulary can surface the right claim.

## Architecture

```
query vector
  ├─ keyIndex:  query × natKey     → top-K chunks (K=12)
  └─ spanIndex: query × span.text  → top-M span hits (M=10)
        author spans (compose-grade)
        auto key-spans (retrieval hooks from value n-grams)

merge (Boost + rescue):
  candidates = key top-K ∪ span-hit parent chunks
  finalScore = keyScore + 0.42 × bestSpanCosine(chunk)
  winner → G2/G3/G4 (compose gets focusSpanId when author span won)
```

## Auto key-spans

1. Split `value` on sentence punctuation (`。！？.!?`)
2. Character trigrams per segment; score = `tf × log((N+1)/df)` (corpus DF)
3. Merge high-scoring n-grams into contiguous `[start,end)` intervals in `value`
4. Skip intervals overlapping author spans (≥70%)

**Index-only** — compose output still prefers author `spans[]`; auto spans are retrieval hooks.

## Trace fields

- `retrievalSource`: `"natKey"` | `"span"`
- `matchedSpanId`: author span id or `auto-{n}`
- `matchedSpanKind`: `"author"` | `"key-span"`
- `spanScore`: best span cosine for chosen chunk

## Evaluation

```bash
npm run eval:dual-index          # offline top-1 (baseline vs dual)
npm run eval:dual-index:engine   # API E2E (needs dev server)
```

Focus set (6): kNN-LM ×3 langs, embedding mechanism ×3 langs — targets `mech-existing` / `mech-1`.

Baseline set (15): from `eval-embed-retrieval` — must not regress.

## Tuning constants (`span-index.ts`)

| Constant | Default | Role |
|---|---|---|
| `KEY_POOL` | 12 | Key candidates in merge |
| `SPAN_POOL` | 10 | Span hits considered |
| `SPAN_BOOST_WEIGHT` | 0.42 | Span cosine weight |
| `SPAN_MIN_COS` | 0.38 | Min span score to contribute |

## Follow-ups

- Rescue threshold tuning on larger query set
- Cross-encoder rerank on span text (with context prefix for short spans)
- G4 compose fallback when `key-span` wins (substring copy without author span id)
