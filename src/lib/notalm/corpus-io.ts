/**
 * G7b — filesystem I/O for corpus YAML (authoring only; not used at reply time).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse, stringify } from "yaml";
import {
  finalizeClaim,
  langsOfClaim,
  type AuthorClaim,
} from "./corpus-author";

export function claimsDir(): string {
  return join(process.cwd(), "corpus", "claims");
}

export function claimPath(claimId: string): string {
  return join(claimsDir(), `${claimId}.yml`);
}

export function listClaimIds(): string[] {
  return readdirSync(claimsDir())
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => f.replace(/\.ya?ml$/, ""))
    .sort();
}

export function loadClaim(claimId: string): AuthorClaim | null {
  const path = claimPath(claimId);
  if (!existsSync(path)) return null;
  const raw = parse(readFileSync(path, "utf8")) as AuthorClaim;
  return raw;
}

export function toYaml(claim: AuthorClaim): string {
  return stringify(finalizeClaim(claim), { lineWidth: 100 });
}

export function validateAuthorClaim(raw: AuthorClaim): string | null {
  if (!raw?.claim || !/^[a-z][a-z0-9-]*$/.test(raw.claim)) {
    return "claim は kebab-case（先頭英小文字）で指定してください";
  }
  if (raw.speaker !== "bot" && raw.speaker !== "user") {
    return "speaker は bot|user";
  }
  if (langsOfClaim(raw).length === 0) {
    return "少なくとも1言語の nat + value が必要です";
  }
  for (const lang of langsOfClaim(raw) as ("ja" | "en" | "zh")[]) {
    const s = raw[lang];
    if (!s?.nat?.trim() || !s?.value?.trim()) {
      return `${lang}: nat と value の両方が必要です`;
    }
  }
  return null;
}

export type SaveResult = {
  path: string;
  yaml: string;
  claim: AuthorClaim;
  claimCount: number;
  built: boolean;
  buildLog?: string;
};

/** Finalize + write YAML + corpus:build. */
export function saveClaim(raw: AuthorClaim, force = false): SaveResult {
  const err = validateAuthorClaim(raw);
  if (err) throw new Error(err);

  const claim = finalizeClaim(raw);
  const path = claimPath(claim.claim);
  if (existsSync(path) && !force) {
    throw new Error(`exists: ${claim.claim}.yml（force で上書き）`);
  }

  const yaml = stringify(claim, { lineWidth: 100 });
  writeFileSync(path, yaml, "utf8");

  const build = spawnSync("npm", ["run", "corpus:build"], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });
  const buildLog = `${build.stdout || ""}${build.stderr || ""}`.trim();
  if (build.status !== 0) {
    throw new Error(`corpus:build failed\n${buildLog}`);
  }

  return {
    path,
    yaml,
    claim,
    claimCount: listClaimIds().length,
    built: true,
    buildLog,
  };
}
