import { note_policy } from "../_build/js/release/build/mizchi/litestream/litestream.js";
import type { AmbiguousDecision, ApplyPolicy, ClientOptions, GateDecision, PolicyContext, ReadonlyQuery } from "./safety-contract.ts";
import { statement } from "./client.ts";

/** Consumer-owned policy registration; protocol messages only select a versioned name. */
function decide(phase: "before" | "ambiguous" | "after", context: Readonly<PolicyContext>, read: ReadonlyQuery): GateDecision | AmbiguousDecision {
  const intent = context.guard.intent;
  const id = intent && typeof intent === "object" && !Array.isArray(intent) ? intent.id : undefined;
  const selected = typeof id === "string" ? read(statement("SELECT score FROM notes WHERE id=?", [id])) : [];
  const score = selected.length === 1 ? Number(selected[0]!.score) : null;
  return JSON.parse(note_policy(JSON.stringify({ phase, context, matches: selected.length, score })));
}
export const applicationPolicies: Record<string, ApplyPolicy> = {
  "select-note@1": {
    before: (context, read) => decide("before", context, read) as GateDecision,
    onAmbiguous: (context, read) => decide("ambiguous", context, read) as AmbiguousDecision,
    after: (context, read) => decide("after", context, read) as GateDecision,
  },
};

/** Override these callbacks in the embedding app to show a merge/selection UI. */
export const clientOptions: ClientOptions = {
  retry: { attempts: 3, delayMs: 50 },
  onIssue: ({ issue }) => ({ action: "defer", reason: issue.message }),
  onReplicaIssue: ({ issue }) => ["replica-missing", "replica-corrupt", "replica-identity", "ltx-gap"].includes(issue.code)
    ? { action: "resnapshot", reason: "rebuild the confirmed image; database identity is checked before commit" }
    : { action: "defer", reason: issue.message },
};
