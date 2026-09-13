import path from "node:path";
import { Rng, seedToState, freshNonce } from "../rules/rng.js";
import { JsonFileStore } from "../state/jsonFileStore.js";
import { reduce } from "../engine/reduce.js";
import { campaignComplete, planSuccession, DEFAULT_SKIP_YEARS } from "../engine/succession.js";
import type { GameEvent } from "../schema/event.js";

/**
 * End a campaign and age the world.
 *
 *   npm run succeed -- <save-id> [--years 12] [--force] [--dry]
 *
 * `planSuccession` has always been pure and tested; this is the thing that actually runs
 * it. The plan becomes ONE journaled root event, so a succession replays like any other
 * turn and can be rewound like any other turn — a time skip is not a special path, and the
 * moment it becomes one the journal stops being the truth.
 *
 * The one guard worth having: ending a campaign is a one-way door in the fiction, so it
 * will not happen because a side quest expired. `--force` is there for a table that has
 * decided otherwise, which is their business.
 */
const args = process.argv.slice(2);
const saveId = args.find((a) => !a.startsWith("--")) ?? "drowned_bell";
const force = args.includes("--force");
const dry = args.includes("--dry");
const yearsArg = args.indexOf("--years");
const years = yearsArg >= 0 ? Number(args[yearsArg + 1]) : DEFAULT_SKIP_YEARS;

if (!Number.isFinite(years) || years <= 0) {
  console.error(`--years wants a positive number of years, got "${args[yearsArg + 1]}".`);
  process.exit(1);
}

const store = new JsonFileStore("saves");
if (!(await store.exists(saveId))) {
  console.error(`No save "${saveId}".`);
  process.exit(1);
}

const state = await store.load(saveId);
const campaignId = state.meta.campaign_id;

if (!campaignId || !state.campaigns[campaignId]) {
  console.error(`Save "${saveId}" is not running a campaign, so there is nothing to succeed.`);
  process.exit(1);
}

const campaign = state.campaigns[campaignId]!;

if (!campaignComplete(state, campaignId) && !force) {
  console.error(`\n  "${campaign.title}" is not finished.`);
  console.error(`  Its climax quest is unresolved and some arcs are still open.`);
  console.error(`  Ending a campaign cannot be taken back in the fiction — pass --force if that is what you mean.\n`);
  process.exit(1);
}

// The nonce is journaled with the event, so replaying this succession re-rolls exactly the
// same deaths and the same drift. Committed dice pin it to the situation instead.
const nonce = state.meta.session_zero.dice === "committed" ? "" : freshNonce();
const rng = new Rng(seedToState(`${state.meta.seed}|succession|${campaignId}|${nonce}`));
const plan = planSuccession(state, rng, { campaignId, years });

console.log(`\n  ${campaign.title} — succession`);
console.log(`  ${"─".repeat(campaign.title.length + 14)}\n`);
for (const line of plan.summary) console.log(`  ${line}`);
console.log(`\n  ${plan.legacy.length} entries written to the legacy ledger.`);
console.log(`  ${plan.promoted.length} unresolved thread(s) promoted into the world.`);
console.log(`  ${plan.effects.length} effect(s) to apply.`);

if (dry) {
  console.log(`\n  --dry: nothing was written.\n`);
  process.exit(0);
}

const event: GameEvent = {
  id: `evt_succ${String(state.meta.turn + 1).padStart(4, "0")}`,
  turn: state.meta.turn + 1,
  world_minute: state.world.world_minute,
  type: "campaign_start",
  actor_id: null,
  target_ids: [],
  location_id: null,
  payload: {
    succession: true,
    campaign_id: campaignId,
    years,
    promoted: plan.promoted.map((s) => s.id),
    summary: plan.summary,
  },
  rolls: [],
  direct_effects: plan.effects,
  attitude_impact: [],
  witnesses: [],
  fact_ids: [],
  duration_minutes: 0,
  rng_nonce: nonce,
  derived_from: null,
  trigger_id: null,
};

// Everything the succession does is in `plan.effects` and therefore in this event. Nothing
// is mutated beside the journal — the legacy ledger, the campaign's status, the arcs and
// the promoted seeds all go through the reducer, so the whole generation-skip replays.
const applied = reduce(state, event);
const next = applied.state;

await store.commit(saveId, applied.journal, next);
await store.snapshot(saveId, `after-${campaignId}`);

console.log(`\n  ✓ ${years} years passed. The world is at turn ${next.meta.turn}.`);
console.log(`    A snapshot was taken first, so this is undoable.`);
console.log(`    Next: seed a new campaign into this world, or keep playing the survivors.\n`);
