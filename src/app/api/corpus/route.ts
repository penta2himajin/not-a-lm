import { NextResponse } from "next/server";
import {
  listClaimIds,
  loadClaim,
  saveClaim,
  toYaml,
  validateAuthorClaim,
} from "@/lib/notalm/corpus-io";
import { finalizeClaim, langsOfClaim, type AuthorClaim } from "@/lib/notalm/corpus-author";
import { draftMissingLangs, unifiedDiff } from "@/lib/notalm/corpus-draft";
import type { Lang } from "@/lib/notalm/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  action?: "preview" | "save" | "draft";
  claim?: AuthorClaim;
  force?: boolean;
  sourceLang?: Lang;
  targets?: Lang[];
  overwrite?: boolean;
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

  if (action === "draft") {
    if (!raw.claim || !/^[a-z][a-z0-9-]*$/.test(raw.claim)) {
      return NextResponse.json(
        { error: "claim は kebab-case（先頭英小文字）で指定してください" },
        { status: 400 },
      );
    }
    if (langsOfClaim(raw).length === 0) {
      return NextResponse.json(
        { error: "下書き元に少なくとも1言語の nat+value が必要です" },
        { status: 400 },
      );
    }
    try {
      const beforeYaml = toYaml(raw);
      const drafted = await draftMissingLangs(raw, {
        sourceLang: body.sourceLang,
        targets: body.targets,
        overwrite: body.overwrite,
      });
      const afterYaml = toYaml(drafted.claim);
      return NextResponse.json({
        ok: true,
        claim: drafted.claim,
        finalized: finalizeClaim(drafted.claim),
        yaml: afterYaml,
        diff: unifiedDiff(beforeYaml, afterYaml),
        sourceLang: drafted.sourceLang,
        drafted: drafted.drafted,
        notes: drafted.notes,
      });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 502 },
      );
    }
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
