import { NextResponse } from "next/server";
import {
  listClaimIds,
  loadClaim,
  saveClaim,
  toYaml,
  validateAuthorClaim,
} from "@/lib/notalm/corpus-io";
import { finalizeClaim, type AuthorClaim } from "@/lib/notalm/corpus-author";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("claim");
  if (id) {
    const claim = loadClaim(id);
    if (!claim) {
      return NextResponse.json({ error: `not found: ${id}` }, { status: 404 });
    }
    return NextResponse.json({
      claim,
      yaml: toYaml(claim),
      finalized: finalizeClaim(claim),
    });
  }
  return NextResponse.json({ claims: listClaimIds(), count: listClaimIds().length });
}

type Body = {
  action?: "preview" | "save";
  claim?: AuthorClaim;
  force?: boolean;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const action = body.action ?? "preview";
  const raw = body.claim;
  if (!raw) {
    return NextResponse.json({ error: "claim required" }, { status: 400 });
  }

  const verr = validateAuthorClaim(raw);
  if (verr) {
    return NextResponse.json({ error: verr }, { status: 400 });
  }

  const finalized = finalizeClaim(raw);
  const yaml = toYaml(raw);

  if (action === "preview") {
    return NextResponse.json({ finalized, yaml, exists: !!loadClaim(raw.claim) });
  }

  if (action === "save") {
    try {
      const result = saveClaim(raw, !!body.force);
      return NextResponse.json({
        ok: true,
        ...result,
        finalized: result.claim,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.startsWith("exists:") ? 409 : 500;
      return NextResponse.json({ error: msg }, { status });
    }
  }

  return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
}
