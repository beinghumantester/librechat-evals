// Read/write pinned reference answers for inference-drift regression checks
// — the same discipline as camelid-evals' golden-store.ts/capture-golden.ts,
// generalized from "does a local engine's byte-for-byte output match" to
// "did a chat model's answer to a fixed question drift from a previously
// captured, human-eyeballed reference." A case with a `goldenId` and no
// captured file for it reports BLOCKED, never a fabricated PASS — same
// guardrail camelid's README documents for its own golden mechanism.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, "..", "..", "evals", "golden");

export interface GoldenReference {
  goldenId: string;
  caseId: string;
  capturedAt: string;
  baseUrl: string;
  answerText: string;
}

export function readGolden(goldenId: string): GoldenReference | undefined {
  const path = join(GOLDEN_DIR, `${goldenId}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeGolden(ref: GoldenReference): void {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(join(GOLDEN_DIR, `${ref.goldenId}.json`), JSON.stringify(ref, null, 2) + "\n");
}
