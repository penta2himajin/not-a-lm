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

## Follow-ups (implemented)

- **Gate on chosen chunk**: reranker gate scores pre-merge key pool plus merged winner (span rescue may sit outside key top-K).
- **Span gate bypass**: author span rescue with `spanScore ≥ SPAN_AUTHOR_RESCUE` skips low-confidence refusal.
- **mech-1 vs mech-2**: index-time tag prefixes + query-time claim adjust in merge (`queryWantsMechanismPipeline` / `queryWantsEmbeddingConcept`).
- **Auto key-span compose fallback**: Rule 1c in G4a — overlapping author span or `keySpanText` copy when `key-span` wins retrieval.
- **Auto boost cap**: auto key-span boost cannot dethrone the key-only top-1 alone (prevents greeting false positives).

## Evaluation sets (`scripts/eval-retrieval-cases.mjs`)

| Set | Cases | Purpose |
|---|---|---|
| `FOCUS_CASES` | 6 | kNN-LM + embedding mechanism (partial compose) |
| `MECH2_CASES` | 3 | “What is embedding?” → `mech-2` must stay correct |
| `BASELINE_CASES` | 15 | No regression vs natKey-only |
| `GATE_SAFETY_CASES` | 3 | API: must not hit `limit-1` refusal |

```bash
npm run eval:dual-index          # offline top-1 (baseline vs dual)
npm run eval:dual-index:engine   # API E2E (needs dev server)
npm run eval:compose             # G4 unit (15 cases)
```

## Tuning constants (`span-index.ts`)

| Constant | Default | Role |
|---|---|---|
| `KEY_POOL` | 12 | Key candidates in merge |
| `SPAN_POOL` | 10 | Span hits considered |
| `SPAN_BOOST_WEIGHT` | 0.42 | Author span cosine weight |
| `SPAN_AUTO_BOOST` | 0.16 | Auto key-span boost (mid-ranked only) |
| `SPAN_AUTHOR_RESCUE` | 0.82 | Author span rescue threshold |
| `SPAN_MIN_COS` | 0.38 | Min auto key-span score |
| `SPAN_AUTHOR_MIN_COS` | 0.26 | Min author span score |

## Future work

- Rescue threshold tuning on larger query set
- Cross-encoder rerank on span text (with context prefix for short spans)
