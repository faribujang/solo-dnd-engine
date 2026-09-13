# Solo D&D Engine — Technical Build Specification

**Audience:** an implementing agent (Claude Fable 5.1) building from scratch.
**Status:** v10. Parts I–IV are the original design. Parts V–XII are the running changelog:
what the build taught us, what other games taught us, and what has been added since.
Where they disagree, **the later part wins** — superseded sections are marked in place.
Authoritative for architecture and data model. Deviate only with a stated reason.

**Where the engine actually is:** 348 tests, 79 source files, replay byte-identical. Phases
0–8 of §37 are done. What is left is the client, the world, and the four gaps in §46.1.

---

## 0. The one rule everything derives from

> **Code owns truth. The LLM owns voice.**

The LLM never holds game state, never rolls dice, never decides success, never edits HP.
Every turn, state is **re-rendered fresh** into the prompt from disk. The LLM's outputs are
**proposals** that code validates against a schema and a whitelist before committing.

If the LLM disappeared mid-campaign, the save file would still be a complete, correct,
playable world. That is the test for whether a piece of information is in the right place.

---

## 1. The memory problem, solved concretely

A rolling prose summary loses details. It is used here **only for pacing/tone**, never for facts.
Recall is handled by three tiers with different guarantees:

| Tier | Mechanism | Recall guarantee | Size in prompt |
|---|---|---|---|
| **1. Structured state** | Typed JSON, re-rendered every turn | **Perfect, always present** | ~1.5–3k tokens (sliced) |
| **2. Fact ledger** | Append-only atomic facts, tag-retrieved | **Perfect, retrieved on relevance** | ~0.5–1.5k tokens |
| **3. Scene digests** | Short prose recap per finished scene | Lossy — *tone only* | ~0.3k tokens |

### Why this works where summaries fail

- A summary compresses **everything** and so degrades **everything**. The fact ledger compresses
  **nothing** — it just doesn't show you facts that aren't relevant right now.
- Facts are **tagged by entity**. Walk into the inn and you get *every* fact ever recorded about
  that innkeeper, verbatim, at turn 400 exactly as at turn 4.
- State (HP, gold, position, quest step, affinity) is never in prose at all, so it cannot drift.

### The CANON block

Every narration prompt contains a section labeled `CANON — you may not contradict these`.
It holds the retrieved facts verbatim. Contradicting canon is the single failure mode we
design against hardest.

---

## 2. Architecture

```
Player text
    |
    v
[1] INTENT PARSE       -> LLM call (cheap model, structured JSON out)
    |                     Proposes: action type, skill, target, difficulty BAND
    v
[2] VALIDATE + RESOLVE -> PURE CODE. No LLM.
    |                     Legality check, DC lookup, seeded dice, damage, costs
    v
[3] REDUCE             -> PURE CODE. Event -> newState via reducer + trigger DSL
    |                     Quest triggers, attitude deltas, faction rep, knowledge spread
    v
[4] BUILD CONTEXT      -> PURE CODE. Deterministic prompt assembly with token budget
    |
    v
[5] NARRATE            -> LLM call (good model, structured JSON out)
    |                     Returns: prose + new facts + attitude deltas + soft proposals
    v
[6] COMMIT PROPOSALS   -> PURE CODE. Whitelist validation, clamping, persist
    |
    v
Render to player, append to journal
```

Steps 2, 3, 4, 6 are **pure functions with no I/O**. They are unit-testable and are where
95% of the correctness lives. Steps 1 and 5 are the only nondeterministic parts.

---

## 3. Storage layout

Local JSON now. A `StateStore` interface so Postgres drops in later without touching game code.

```
saves/
  <campaign_id>/
    campaign.json        # meta, seed, model config, turn counter
    world.json           # clock, calendar, weather, flags, factions
    locations.json       # map graph
    entities.json        # PC, companions, NPCs, monsters
    items.json           # definitions + instances
    quests.json
    relationships.json   # directed attitude edges
    facts.jsonl          # append-only fact ledger
    journal.jsonl        # append-only event log (the real source of truth)
    digests.json         # per-scene prose recaps (tone only)
    rejects.jsonl        # rejected LLM proposals — your best debug signal
```

```ts
interface StateStore {
  load(campaignId: string): Promise<GameState>;
  commit(campaignId: string, events: Event[], next: GameState): Promise<void>;
  appendFacts(campaignId: string, facts: Fact[]): Promise<void>;
  listCampaigns(): Promise<CampaignMeta[]>;
  snapshot(campaignId: string, label: string): Promise<string>;  // save scumming
  restore(campaignId: string, snapshotId: string): Promise<void>;
}
```

Implementations: `JsonFileStore` (build now), `PostgresStore` (stub the class, do not implement).

**Event sourcing:** `journal.jsonl` is append-only and complete. The other JSON files are a
materialized cache that can be **rebuilt by replaying the journal through the reducer**.
Build `npm run rebuild <campaign>` and a test asserting `replay(journal) === current state`.
This gives you time-travel, undo, and a very strong correctness check for free.

---

## 4. Data model

All schemas defined once in **Zod**, in `src/schema/`. Zod is the single source of truth:
it generates the TypeScript types, does runtime validation on load, **and** emits JSON Schema
for the LLM structured-output calls. Never hand-write a type that duplicates a Zod schema.

IDs are stable, human-readable, prefixed strings: `npc_thorne`, `loc_citadel_gate`,
`q_missing_caravan`, `item_def_longsword`, `item_inst_0042`, `fact_0311`.

### 4.1 Entity

Covers PC, companions, NPCs and monsters — one schema, `kind` discriminates.

```jsonc
{
  "id": "npc_thorne",
  "kind": "npc",                       // pc | companion | npc | monster
  "name": "Thorne Blackwater",
  "aliases": ["the innkeeper", "old Thorne"],
  "descriptor": "grizzled innkeeper, missing his left ear",

  "location_id": "loc_rusty_flagon",
  "faction_ids": ["fac_ashen_hand"],

  "abilities": { "str": 10, "dex": 12, "con": 13, "int": 11, "wis": 14, "cha": 9 },
  "level": 3,
  "class_id": "cls_commoner",
  "race_id": "race_human",
  "hp": { "current": 18, "max": 22, "temp": 0 },
  "ac": 12,
  "speed": 30,
  "proficiency_bonus": 2,
  "proficiencies": {
    "skills": ["insight", "persuasion"],
    "saves": ["wis"],
    "weapons": [],
    "tools": ["brewers_supplies"]
  },
  "conditions": [
    { "id": "poisoned", "source_event_id": "evt_0210", "expires_world_minute": 123500 }
  ],
  "resources": {
    "spell_slots": { "1": { "max": 0, "used": 0 } },
    "hit_dice": { "max": 3, "used": 1 }
  },

  "inventory": ["item_inst_0042"],
  "equipped": { "main_hand": "item_inst_0042", "armor": null },

  // --- drives LLM VOICE, never mechanics ---
  "personality": {
    "traits": ["speaks in short sentences", "counts coins while talking"],
    "ideal": "A debt paid is a night's sleep earned.",
    "bond": "The Flagon was his father's.",
    "flaw": "Will sell out anyone to the Ashen Hand.",
    "voice": "clipped, wary, dry humour"
  },
  "goals": [
    { "text": "Clear his debt before midwinter", "priority": 1, "quest_id": "q_thornes_debt" }
  ],
  "schedule": [
    { "from_hour": 6,  "to_hour": 23, "location_id": "loc_rusty_flagon" },
    { "from_hour": 23, "to_hour": 6,  "location_id": "loc_flagon_upstairs" }
  ],

  "known_fact_ids": ["fact_0004", "fact_0031"],
  "ai_policy": null,                   // companions only: aggressive|support|cautious|skirmish
  "alive": true,
  "flags": {}
}
```

Notes:

- `schedule` makes the world feel alive for near-zero cost. Advance the clock -> NPCs relocate.
- `personality` is the *only* free-text field the narrator is asked to honour for voice.
- `known_fact_ids` is the knowledge model. See §6.3.

### 4.2 Location

```jsonc
{
  "id": "loc_citadel_gate",
  "name": "The Sunken Gate",
  "region_id": "reg_citadel",
  "short_desc": "A cracked stone arch half-swallowed by the ravine wall.",
  "long_desc": "Full paragraph. Sent on FIRST VISIT or an explicit 'look around' only.",
  "exits": [
    { "dir": "north", "to": "loc_citadel_hall", "travel_minutes": 2,
      "locked_by": "item_def_rusted_key", "hidden_until_flag": null, "desc": "an iron door" },
    { "dir": "up", "to": "loc_ravine_ledge", "travel_minutes": 15,
      "requires_check": { "skill": "athletics", "band": "medium" } }
  ],
  "features": [
    { "id": "feat_dry_well", "name": "dry well", "desc": "...",
      "interactions": ["search", "climb_down", "listen"], "state": { "searched": false } }
  ],
  "contains_item_ids": ["item_inst_0091"],
  "ambient": { "light": "dim", "sound": "dripping water", "smell": "wet stone" },
  "on_enter_triggers": [],
  "discovered": true,
  "visited_count": 3,
  "danger_level": 2,
  "encounter_table_id": "enc_citadel_l1",
  "flags": {}
}
```

`contains_entity_ids` is **derived** from `entity.location_id` — never stored, to avoid two
sources of truth. Provide a selector `entitiesAt(state, locId)`.

### 4.3 Quest

```jsonc
{
  "id": "q_missing_caravan",
  "title": "The Missing Caravan",
  "giver_entity_id": "npc_thorne",
  "status": "active",                  // unknown|available|active|complete|failed|expired
  "visibility": "known",               // hidden|rumored|known
  "summary": "Player-facing one-liner shown in the quest log.",
  "dm_notes": "TRUTH the player doesn't know: the caravan guard sold them out.",
  "current_step_id": "step_2",
  "steps": [
    {
      "id": "step_1",
      "desc": "Find the caravan's last camp",
      "status": "complete",
      "preconditions": [],
      "completion_triggers": [
        { "on": "enter_location", "match": { "location_id": "loc_burned_camp" } }
      ],
      "on_complete": [
        { "t": "add_fact", "text": "The camp was burned from the inside.",
          "subjects": ["q_missing_caravan"], "importance": 4 }
      ]
    },
    {
      "id": "step_2",
      "desc": "Learn who betrayed them",
      "status": "active",
      "preconditions": [
        { "t": "quest_step_done", "quest_id": "q_missing_caravan", "step_id": "step_1" }
      ],
      "completion_triggers": [
        { "on": "dialogue", "match": { "target_ids": ["npc_garret"] },
          "when": { "t": "affinity", "subject": "npc_garret", "object": "pc_main",
                    "dim": "trust", "op": "gte", "value": 40 } }
      ],
      "on_complete": []
    }
  ],
  "leads": [
    { "text": "Thorne says the caravan was headed for the old mill.", "learned_turn": 12,
      "source_entity_id": "npc_thorne", "points_to_location_id": "loc_old_mill" }
  ],
  "rewards": {
    "xp": 300, "gold": 50, "item_def_ids": ["item_def_cloak_shadow"],
    "relationship_deltas": [
      { "subject": "npc_thorne", "object": "pc_main", "dims": { "trust": 15 } }
    ]
  },
  "deadline_world_minute": 145000,
  "failure_triggers": [ { "on": "death", "match": { "target_ids": ["npc_garret"] } } ],
  "requires": [],
  "blocks": ["q_join_ashen_hand"]
}
```

`leads` is what the DM is allowed to hint at. `dm_notes` is what the DM knows but must not
volunteer. Both go in the prompt, clearly labelled.

### 4.4 Item

Split **definition** (shared, static) from **instance** (owned, stateful).

```jsonc
// definition
{ "id": "item_def_longsword", "name": "Longsword", "kind": "weapon",
  "weight": 3, "value_cp": 1500, "desc": "...",
  "damage": { "dice": "1d8", "type": "slashing", "versatile": "1d10" },
  "properties": ["versatile"], "tags": ["martial", "metal"] }

// instance
{ "id": "item_inst_0042", "def_id": "item_def_longsword",
  "owner": { "t": "entity", "id": "npc_thorne" },
  "qty": 1, "charges": null, "attunement": null,
  "nickname": "his father's blade",          // narrator may set this
  "condition": "worn", "flags": { "stolen_from": "pc_main" } }
```

`owner` is a tagged union: `{t:"entity"}` | `{t:"location"}` | `{t:"container", id}`. One field,
one source of truth for where every object in the world is.

### 4.5 Relationship — the semantic layer

Directed edges. Thorne's feelings about you are not your feelings about Thorne.

```jsonc
{
  "npc_thorne->pc_main": {
    "subject": "npc_thorne",
    "object": "pc_main",

    // numeric spine: CODE writes these, they drive MECHANICS
    "dims": { "affinity": 34, "trust": 12, "fear": 0, "respect": 40 },   // each -100..100
    "disposition": "warming",        // DERIVED label from dims, not stored independently

    // semantic layer: LLM writes this, it drives VOICE
    "opinion": "Thinks you're competent but reckless. Has not forgiven the tavern fire, but needs your help more than he resents you.",
    "tags": ["indebted_to_pc", "suspicious_of_pc_magic"],

    "history": [
      { "turn": 12, "event_id": "evt_0044", "dims": { "trust": 10 },
        "reason": "Returned his brother's ring" },
      { "turn": 31, "event_id": "evt_0132", "dims": { "affinity": -15, "respect": 5 },
        "reason": "Burned down half his common room killing the ghoul" }
    ]
  }
}
```

**Mechanical consequences** (in code, `src/rules/social.ts`):

- Social check DC modified by affinity: `dc -= clamp(round(affinity / 20), -3, +3)`
- `trust < -30` -> NPC refuses to share `secret` facts regardless of roll
- `fear > 50` -> NPC will flee combat, or comply without a check
- `affinity > 60` -> merchant prices at 0.9x; will offer aid unprompted
- Faction propagation: harming a faction member applies a **damped** delta to every other
  member who could plausibly have heard (`faction_rep_spill = 0.3`)

**Write rules:**

- `dims` change only via committed `Event.attitude_impact` or the narrator's
  `attitude_deltas` proposal, **clamped to ±10 per dimension per turn**.
- `opinion` is rewritten by the narrator at most once per scene, and only for NPCs present.
- `history` is append-only and is what regenerates `opinion` if it ever gets garbled.

### 4.6 Fact

```jsonc
{
  "id": "fact_0311",
  "turn": 47,
  "world_minute": 123480,
  "text": "Thorne owes 200gp to the Ashen Hand and they have threatened his daughter.",
  "kind": "npc",                       // world|npc|item|quest|pc_action|lore
  "subjects": ["npc_thorne", "fac_ashen_hand"],
  "location_id": "loc_rusty_flagon",
  "quest_ids": ["q_thornes_debt"],
  "importance": 4,                     // 1..5, 5 = never dropped from context
  "secret": true,
  "known_by": ["npc_thorne", "pc_main"],
  "source": "narrator",                // narrator|authored|player_action
  "superseded_by": null
}
```

Facts are **append-only**. A fact is never edited; if the world changes, write a new fact and
set `superseded_by` on the old one. This is what makes recall lossless.

### 4.7 Event (journal entry)

```jsonc
{
  "id": "evt_0132",
  "turn": 31,
  "world_minute": 122900,
  "type": "attack",   // move|attack|skill_check|dialogue|item_transfer|cast|rest|trade|
                      // observe|quest_update|death|enter_location|time_pass
  "actor_id": "pc_main",
  "target_ids": ["mon_ghoul_01"],
  "location_id": "loc_rusty_flagon",
  "payload": { "weapon": "item_inst_0042", "damage": 9,
               "damage_type": "slashing", "killed": true },
  "rolls": [
    { "purpose": "attack", "die": "d20", "raw": 17, "mods": 5, "total": 22,
      "target": 12, "success": true, "advantage": "none" }
  ],
  "attitude_impact": [
    { "subject": "npc_thorne", "object": "pc_main", "dims": { "affinity": -15, "respect": 5 },
      "reason": "collateral damage to the common room" }
  ],
  "witnesses": ["npc_thorne", "npc_mira"],
  "fact_ids": ["fact_0140"],
  "rng_state_before": "a3f19c02"
}
```

`witnesses` drives knowledge propagation (§6.3). `rng_state_before` makes replay exact.

### 4.8 World

```jsonc
{
  "world_minute": 123480,             // single monotonic clock; derive day/hour/season
  "calendar": { "day": 86, "month": "Hammer", "year": 1492 },
  "weather": { "current": "cold rain", "changes_at_minute": 124000 },
  "flags": { "gate_lever_pulled": true, "ashen_hand_alerted": false },
  "factions": {
    "fac_ashen_hand": {
      "name": "The Ashen Hand", "rep_with_pc": -20,
      "member_ids": ["npc_thorne"], "goals": ["control the river trade"]
    }
  },
  "triggers": [],                     // global triggers
  "scene_id": "scene_0009",
  "scene_started_turn": 44
}
```

One clock in minutes. Every action has a duration. Long rest = 480 min. This is what makes
quest deadlines, NPC schedules and torch burn actually work.

---

## 5. The trigger DSL — how everything interacts dynamically

This is the answer to "how do world, characters and quests interact." It is **declarative
data, evaluated by code** — never a hardcoded `if` tree, and never the LLM's job.

```ts
type Condition =
  | { t: "flag";            key: string; eq: unknown }
  | { t: "has_item";        entity_id: Id; item_def_id: Id; min?: number }
  | { t: "entity_at";       entity_id: Id; location_id: Id }
  | { t: "entity_dead";     entity_id: Id }
  | { t: "affinity";        subject: Id; object: Id; dim: Dim; op: "gte"|"lte"; value: number }
  | { t: "quest_status";    quest_id: Id; status: QuestStatus }
  | { t: "quest_step_done"; quest_id: Id; step_id: Id }
  | { t: "knows_fact";      entity_id: Id; fact_id: Id }
  | { t: "world_time";      op: "before"|"after"; world_minute: number }
  | { t: "faction_rep";     faction_id: Id; op: "gte"|"lte"; value: number }
  | { t: "all" | "any" | "not"; of: Condition[] };

type Effect =
  | { t: "set_flag";         key: string; value: unknown }
  | { t: "give_item";        entity_id: Id; item_def_id: Id; qty: number }
  | { t: "remove_item";      entity_id: Id; item_def_id: Id; qty: number }
  | { t: "move_entity";      entity_id: Id; location_id: Id }
  | { t: "spawn_entity";     template_id: Id; location_id: Id }
  | { t: "damage";           entity_id: Id; amount: number; damage_type: string }
  | { t: "heal";             entity_id: Id; amount: number }
  | { t: "adjust_attitude";  subject: Id; object: Id; dims: Partial<Dims>; reason: string }
  | { t: "faction_rep";      faction_id: Id; delta: number }
  | { t: "set_quest_status"; quest_id: Id; status: QuestStatus }
  | { t: "advance_quest";    quest_id: Id; step_id: Id }
  | { t: "add_lead";         quest_id: Id; text: string; points_to_location_id?: Id }
  | { t: "reveal_location";  location_id: Id }
  | { t: "reveal_exit";      location_id: Id; dir: string }
  | { t: "add_fact";         text: string; subjects: Id[]; importance: 1|2|3|4|5; secret?: boolean }
  | { t: "teach_fact";       entity_id: Id; fact_id: Id }
  | { t: "advance_time";     minutes: number }
  | { t: "start_combat";     enemy_ids: Id[] };

type Trigger = {
  id: Id;
  on: EventType;
  match?: Partial<Event>;     // structural match on the event
  when?: Condition;           // additional state predicate
  then: Effect[];
  once?: boolean;             // default true
  fired?: boolean;
};
```

Triggers live wherever they belong: on quest steps, on locations (`on_enter_triggers`), on
entities (`on_death`, `on_first_talk`), and in a global `world.triggers` list.

**The reducer:**

```ts
function reduce(state: GameState, event: Event): { state: GameState; cascade: Event[] } {
  let s = applyDirect(state, event);            // the event's own mechanical payload
  const fired = collectTriggers(s, event)       // quests + locations + entities + world
                  .filter(t => matches(t, event) && evaluate(t.when, s));
  const cascade: Event[] = [];
  for (const t of fired) {
    for (const e of t.then) {
      const { state: s2, emitted } = applyEffect(s, e, event);
      s = s2;
      cascade.push(...emitted);
    }
  }
  s = propagateKnowledge(s, event);             // §6.3
  s = applyAttitudes(s, event);                 // §4.5 write rules
  return { state: s, cascade };
}
```

Cascading events re-enter the reducer, **depth-limited to 8** with a cycle guard. Every
cascade event is journaled, so "why did the guards turn hostile" is always answerable.

**This is the dynamism.** Kill an NPC -> `death` event -> quest failure trigger fires ->
faction rep drops -> rep spill adjusts every member's attitude -> a fact is written ->
witnesses learn it -> gossip propagates it. All from data, all deterministic, all replayable.

---

## 6. Subsystems

### 6.1 Dice and DCs — the LLM never sets these

Seeded PRNG (small xorshift, or `seedrandom`) whose state lives in `campaign.json`. Every roll
advances it; every event records the state before. Replay is bit-exact.

The intent parser proposes a **difficulty band**, never a number. Code maps it:

| Band | DC |
|---|---|
| trivial | 5 |
| easy | 10 |
| medium | 15 |
| hard | 20 |
| very_hard | 25 |
| near_impossible | 30 |

Then code applies situational modifiers from **state, not vibes**: light level for Stealth and
Perception, affinity for social checks, exhaustion, conditions, cover for attacks, and
advantage/disadvantage sources. Ship a `modifiers.ts` with one exported function per source so
the reasoning is auditable and testable.

Hard invariants, enforced in code:

- Natural 1 / natural 20 handling per 5e — crits on attack rolls; no auto-success or
  auto-failure on ability checks.
- A check is only offered if the action is **possible**. Impossible actions are refused
  narratively, never rolled for.
- Resource costs (spell slots, charges, ammo, gold) are deducted **before** narration.

### 6.2 Rules content and licensing

Use the **SRD 5.1 / 5.2 (Creative Commons)** for classes, spells, monsters, conditions and
items. Do **not** use named published adventures, Forgotten Realms proper nouns, or non-SRD
monsters. Keep SRD content in `content/srd/*.json`, clearly separated from
`content/campaign/*.json`, with CC-BY attribution in `content/srd/LICENSE.md`.

### 6.3 Knowledge propagation — who knows what

A genuine differentiator, cheap to build, and it makes the DM feel smart.

- Every `Fact` has `known_by: Id[]`.
- On commit, every entity in `event.witnesses` learns the facts that event produced.
- A **gossip pass** runs on `advance_time`: for each fact with `secret: false`, each knower has
  a per-hour chance to teach it to co-located entities, scaled by their mutual affinity.
  Faction members get a separate, faster channel.
- The context builder **filters facts by knower**. When talking to the guard, the prompt
  contains only facts the guard knows plus facts the PC knows. The guard cannot mention the
  murder unless the guard learned about it.
- Secrets can be extracted with a social check gated on `trust` (§4.5).

### 6.4 Companion AI — code, not a second agent

A behaviour policy per companion, evaluated by pure functions. Do **not** build a second LLM
agent for this; it is slower, costlier and less reliable than 200 lines of TypeScript.

```ts
type Policy = "aggressive" | "support" | "cautious" | "skirmish";
function chooseAction(self: Entity, s: CombatState): Action;
```

Rough shapes: `support` heals any ally below 40% HP, else buffs, else cantrip. `aggressive`
targets lowest effective HP in reach. `cautious` disengages below 30% HP. The player can always
override — "Mira, hold the door" becomes an intent that sets a one-round directive the policy
must respect.

Companion *dialogue* flavour can be one cheap LLM call per scene, or a line drawn from their
`personality`. Their *actions* are always code.

### 6.5 Combat

Standard 5e initiative, turn-order queue in state. Positions are **zone-based, not grid**: each
location has abstract zones (`entrance`, `by_the_fire`, `behind_the_bar`) with an adjacency
list. This gets 90% of the tactical feel for 10% of the complexity, and it suits a text UI.
A grid can come later; the zone abstraction will not need to change.

Combat is a `CombatState` inside `GameState`, not a separate mode of the app. The turn pipeline
is identical — only the legal action set narrows.

---

## 7. Context builder — the most important module

`src/context/build.ts`. Deterministic, pure, token-budgeted. Sections are assembled by priority
and each has a cap; when over budget, low-priority sections shed content **by rule**, never by
truncating mid-object.

| # | Section | Priority | Budget | Contents |
|---|---|---|---|---|
| 1 | System / DM persona | fixed | 600 | Role, hard constraints, output contract |
| 2 | **CANON** | 1 | 1200 | Retrieved facts, verbatim, "do not contradict" |
| 3 | Scene | 2 | 400 | Location, exits, time, weather, ambient, features |
| 4 | PC sheet | 2 | 350 | Compact: HP, AC, resources, conditions, key inventory |
| 5 | Present NPCs | 3 | 900 | Per NPC: descriptor, personality, relationship dims + opinion, their known facts about the PC |
| 6 | Party | 3 | 300 | Companion HP / resources / policy |
| 7 | Active quests | 4 | 400 | Current step, leads, `dm_notes` for quests in play |
| 8 | Recent turns | 5 | 900 | Last 6 turns verbatim |
| 9 | Scene digests | 6 | 300 | Prose recap of earlier scenes — **tone only** |
| 10 | This turn's mechanics | fixed | 200 | The resolved roll and its consequences |

Target total: **4–6k tokens**. Everything above is generated from state; nothing is carried
forward from a previous prompt. **There is no conversation history in the API sense** — each
narration call is stateless. That is what makes drift structurally impossible.

**Fact retrieval** (`selectFacts`):

```
score = 3 * subject_overlap_with_present_entities
      + 2 * (fact.location_id === current_location)
      + 2 * quest_overlap_with_active_quests
      + importance
      + recency_bonus(decays over 50 turns)

filter: not superseded, and (not secret OR pc_main ∈ known_by)
sort desc, take until budget
always include: every fact with importance === 5
```

No embeddings. At a few thousand facts, tag filtering is exact, instant and free. Add vector
search only if a save exceeds ~20k facts, behind the same `selectFacts` signature.

---

## 8. LLM contracts

Both calls use **structured output** (JSON Schema derived from Zod). No prose parsing anywhere.

### 8.1 Intent parse (cheap, fast model, temperature 0)

Input: player text + legal action list + present entities / exits / inventory.

```jsonc
{
  "action": "skill_check",  // move|skill_check|attack|cast|talk|use_item|trade|rest|
                            // look|inventory|meta|unclear
  "skill": "stealth",
  "ability": "dex",
  "actor_id": "pc_main",
  "target_ids": ["mon_bugbear_01"],
  "target_location_id": null,
  "item_instance_id": null,
  "spell_id": null,
  "difficulty_band": "medium",
  "rationale": "Sneaking past a sleeping creature in dim light",
  "dialogue_intent": null,  // for talk: persuade|deceive|intimidate|inquire|chat + topic
  "confidence": 0.9
}
```

If `confidence < 0.6` or `action === "unclear"`, ask the player to clarify. Never guess.

### 8.2 Narration (good model, temperature ~0.8)

```jsonc
{
  "narration": "Two to four paragraphs, second person. Ends with the situation, not a question.",
  "facts": [
    { "text": "...", "kind": "npc", "subjects": ["npc_thorne"],
      "importance": 3, "secret": false }
  ],
  "attitude_deltas": [
    { "subject": "npc_thorne", "object": "pc_main", "dims": { "trust": 5 },
      "reason": "You paid without haggling" }
  ],
  "opinion_updates": [
    { "subject": "npc_thorne", "object": "pc_main", "opinion": "..." }
  ],
  "proposals": [
    { "t": "set_flag", "key": "thorne_mentioned_the_mill", "value": true },
    { "t": "add_lead", "quest_id": "q_missing_caravan", "text": "...",
      "points_to_location_id": "loc_old_mill" }
  ],
  "suggested_actions": ["Ask about the Ashen Hand", "Head north to the mill", "Search the room"],
  "scene_change": null
}
```

### 8.3 Commit validation — non-negotiable

`proposals` are checked against a **narrow whitelist**. The narrator may only propose:
`set_flag`, `add_lead`, `reveal_location`, `reveal_exit`, `add_fact`, `teach_fact`,
`adjust_attitude`, `move_entity` (NPCs only), `advance_time` (≤ 60 min).

It may **never** propose: `damage`, `heal`, `give_item`, `remove_item`, `set_quest_status`,
`advance_quest`, `faction_rep`, `spawn_entity`, `start_combat`. Those come only from the rules
engine or from authored triggers.

Anything unrecognised or out of range is **dropped and logged to `rejects.jsonl`** — never
applied, never silently accepted. `attitude_deltas` clamp to ±10 per dim per turn. Unknown IDs
are dropped. Read `rejects.jsonl` often; it is the best debugging signal in the system.

---

## 9. Model routing

`config/models.json`, hot-swappable, one entry per role:

```jsonc
{
  "roles": {
    "intent":     { "provider": "gemini", "model": "<gemini flash>", "max_tokens": 500,  "temperature": 0 },
    "narrate":    { "provider": "gemini", "model": "<gemini flash>", "max_tokens": 1200, "temperature": 0.8 },
    "narrate_hi": { "provider": "openrouter", "model": "<pick at build time>", "max_tokens": 1600, "temperature": 0.8 },
    "companion":  { "provider": "gemini", "model": "<gemini flash>", "max_tokens": 200,  "temperature": 0.7 },
    "digest":     { "provider": "gemini", "model": "<gemini flash>", "max_tokens": 300,  "temperature": 0.3 }
  },
  "fallback_chain": ["gemini", "openrouter"],
  "escalate_to_hi_when": { "importance_gte": 4, "scene_opening": true, "combat_round": false }
}
```

One `LLMClient` interface with adapters for `gemini` and `openrouter` (both are
OpenAI-compatible enough). On 429 or 5xx: fall through the chain, then retry with backoff, then
surface a clean "the DM is thinking too hard, try again" rather than crashing the turn.

**Do not hardcode model IDs from any document, including this one.** Read the provider's live
model list at build time and record the chosen IDs in config.

---

## 10. Repo layout

```
src/
  schema/     zod schemas: entity, location, quest, item, relationship, fact, event, world
  state/      store.ts (interface), jsonFileStore.ts, selectors.ts, migrate.ts
  rules/      dice.ts, checks.ts, modifiers.ts, combat.ts, social.ts, rest.ts, srd.ts
  engine/     reduce.ts, effects.ts, conditions.ts, triggers.ts, knowledge.ts, turn.ts
  context/    build.ts, sections.ts, selectFacts.ts, render.ts, budget.ts
  llm/        client.ts, gemini.ts, openrouter.ts, intent.ts, narrate.ts, validate.ts
  ui/         (phase 5)
  cli/        play.ts, rebuild.ts, inspect.ts
content/
  srd/        LICENSE.md + SRD data
  campaign/   authored world content
  templates/  monster / NPC templates
tests/
  rules/      dice, checks, modifiers — heavy coverage
  engine/     reducer, trigger cascades, cycle guard
  context/    budget shedding, fact-selection determinism
  golden/     replay journal -> assert final state
saves/
config/
```

---

## 11. Build phases and acceptance criteria

> **Status: see Part V (§32–37), which supersedes this section and §20/§30.** Phases 0–4 are
> **complete and gated** (151 tests). Phase 4 added
> combat — initiative, action economy, zones, opportunity attacks, conditions, a spell
> subset with concentration, CPU policies and morale — plus three dice modes (§31.1). Earlier: the canon and
> deadline tests, committed dice with the RNG state deleted, the schema migration from §30,
> character creation on an SRD subset, XP and level-up, computed AC, death saves, and the
> affordance engine. Phases 0 and 1 were the first pass; Much of what phases 2 and 3
> describe was built alongside them and is tested — the fact ledger, retrieval, relationships,
> knowledge propagation, gossip, quest state machines, deadlines, the world clock, NPC
> schedules, factions and travel all exist. What remains of those phases is their gates, not
> their code. **See Part II §20 for the revised roadmap**, which supersedes the table below
> for everything after phase 1.

Each phase must be demonstrably complete before the next starts.

**Phase 0 — Skeleton, no LLM.**
Zod schemas, `JsonFileStore`, reducer, trigger DSL, dice, checks. A CLI where you type
structured commands: `move north`, `attack goblin`, `check stealth medium`.
*Done when:* a scripted 30-action sequence runs and `replay(journal)` reproduces the exact
final state, byte for byte.

**Phase 1 — Turn loop with LLM.**
Intent parse, narration, context builder, commit validation. One hand-authored location, two
NPCs. Free text in, prose out.
*Done when:* 20 turns of free-text play with zero schema violations reaching state, and
`rejects.jsonl` reviewed and understood.

**Phase 2 — Memory and relationships.**
Fact ledger, `selectFacts`, relationship dims + opinions, knowledge propagation, gossip.
*Done when:* the **canon test** passes — a scripted 60-turn session in which a detail
established at turn 3 (an NPC's brother's name, a promise made) is recalled correctly and
unprompted at turn 55; **and** an NPC provably does not know a secret they never witnessed.

**Phase 3 — Quests and world.**
Quest state machines, leads, deadlines, world clock, NPC schedules, factions, multi-room map,
travel with time cost.
*Done when:* a two-quest campaign can be completed, **and** can be failed by letting a deadline
expire — with the failure cascading correctly through triggers.

**Phase 4 — Combat and companions.**
Initiative, zones, conditions, companion policies, rests.
*Done when:* a 3-round, 4-combatant fight resolves with 5e arithmetic verified by hand.

**Phase 5 — Web UI.**
Next.js App Router. Mobile-first: narrative feed, input box, collapsible panels for character
sheet / party / quest log / map / inventory. Dice-roll display showing the actual roll, mods and
DC — surfacing the mechanics is what convinces the player the DM isn't cheating. Sprites via
CSS/Canvas 2D: portraits and a simple location tile. No game engine dependency.

**Phase 6 — Deploy.**
Vercel + Postgres behind the existing `PostgresStore` adapter. Auth can be a single shared secret.

---

## 12. Explicit non-goals and anti-patterns

Do **not**:

- Use LangGraph, LangChain, or any agent framework. The turn loop is a six-step pipeline; a
  framework adds a dependency and a second deploy target for no capability gain.
- Keep an LLM conversation history. Every call is stateless and rebuilt from state.
- Let the narrator write HP, gold, items, quest status, or combat outcomes.
- Store derived data (`contains_entity_ids`, `disposition`) as a second source of truth.
- Use embeddings before the fact count justifies it.
- Build the app launcher / multi-app platform. That is a separate later project; just keep
  `config/` and `saves/` cleanly separated from `src/` so it can be wrapped later.
- Add a database before phase 6. JSON files, behind the `StateStore` interface.

---

## 13. First deliverable for the builder

Start at Phase 0 and stop at its acceptance criterion. Before writing engine code, produce:

1. The complete Zod schema set in `src/schema/`, with a one-line comment per field.
2. A hand-authored 4-room starter campaign in `content/campaign/` that exercises every schema
   field at least once — including two quests, three NPCs with relationships, one faction, and
   at least five triggers of different types.
3. The reducer with its cycle guard, and the golden replay test.

Then report back with the golden replay test passing, before touching an LLM.

---

# Part II — from engine to game

Part I (§0–13) specifies the engine, and phases 0 and 1 of it are built. Part II covers
everything between "the rules work" and "this is a game someone would play": the character
systems, the systems a tabletop session has that a text adventure does not, and the client.

The rules of Part I still hold. Nothing below relaxes **code owns truth, the LLM owns
voice**, and nothing below is allowed to give the narrator a number it can change.

---

## 14. Character system

The largest gap in Part I: there is no way to make a character, no way to advance one, and
no way to cast a spell. All three are load-bearing for a D&D game.

### 14.1 Character creation

A guided flow, not a form. Each step is a turn like any other, so it is journaled and
rewindable.

1. **Name and pronouns.** Pronouns are a field on `Entity`, used by the narrator; never
   inferred from a name.
2. **Ability scores.** Three methods, player's choice: standard array (15/14/13/12/10/8),
   point buy (27 points, 8–15 before racial), or 4d6-drop-lowest rolled through the seeded
   PRNG so the roll is in the journal and cannot be quietly re-rolled.
3. **Race**, from SRD. Applies ability increases, speed, size, darkvision, traits.
4. **Class**, from SRD. Sets hit die, proficiencies, saving throws, level-1 features,
   spellcasting ability.
5. **Background**, from SRD. Skill and tool proficiencies, starting gold, and a
   `personality` block — traits, ideal, bond, flaw. These feed the narrator's voice for the
   *player character*, which the DM uses to colour description, never to make decisions.
6. **Starting equipment**, by class and background, with the standard either/or choices.
7. **Portrait**, chosen from a bundled sprite set (see §17.9).

**Session zero.** Before the first scene, ask three things and store them on `campaign.json`:
- **Tone** — grim, heroic, comic, or a blend. Injected into the DM system prompt.
- **Lines and veils** — content the player does not want in their game at all (lines) or
  wants handled off-screen (veils). This is standard tabletop practice and it belongs in
  the system prompt as a hard constraint, not a content filter bolted on afterwards.
- **Difficulty** — affects DC bands, encounter budgets, and whether death is permanent
  (§14.5).

New schema: `CampaignMeta.session_zero: { tone, lines: string[], veils: string[], difficulty }`.

### 14.2 Progression

XP is already awarded by quest rewards and consumed by nothing.

- **XP thresholds**, SRD table, levels 1–20. Realistically the campaign targets 1–8.
- **Level-up** is a player-confirmed flow, not automatic: HP (average or rolled — rolled
  goes through the seeded PRNG), proficiency bonus, class features, ability score
  improvement at 4/8/12/16/19, new spell slots and spells.
- **Milestone levelling** as an alternative, driven by a `level_up` effect on a quest's
  `on_complete`. Some campaigns want this; make it a campaign setting.
- Level-up is an `Effect` (`grant_xp`, `level_up`), so it is journaled and replays exactly.

### 14.3 Equipment

`equipped` slots exist but nothing derives from them. They must.

- **AC is computed, never stored.** `ac = base(armor) + min(dex_mod, dex_cap) + shield +
  bonuses`. Unarmoured is 10 + dex. Store the computation, not the result — a stored AC and
  an equipped breastplate will disagree eventually.
- **Attunement**, maximum three, enforced.
- **Two-handed / versatile / finesse** already exist as properties and are honoured by the
  attack resolver; extend to reach, thrown, ammunition.
- **Encumbrance** as an optional variant, off by default: carrying capacity is
  `str × 15`, with speed penalties past thresholds.
- **Containers** — `ItemOwner` already has a `container` arm; make it real for packs,
  chests and corpses.

### 14.4 Spellcasting — a deliberate subset

Full 5e spellcasting is enormous and most of it will never come up in a solo campaign.
Implement a curated slice and be explicit that it is a slice:

- **Cantrips plus levels 1–3.** Roughly forty SRD spells, chosen for coverage rather than
  completeness: attack cantrips, healing, buffs, a few utility, a few control.
- **Slots** already exist on `Entity.resources`. Casting spends one; a long rest restores all.
- **Prepared vs known** per class, correctly.
- **Resolution paths**: spell attack roll (like an attack), saving throw (target rolls),
  or no roll (buffs, utility). All three go through the existing resolver — a spell save DC
  is `8 + prof + spellcasting mod`, computed in code.
- **Concentration**: one at a time, broken by a new concentration spell, by incapacitation,
  or by failing a Constitution save (DC 10 or half damage, whichever is higher) when damaged.
  This is the rule most digital adaptations get wrong; it is cheap to get right.
- **Ritual casting** where the spell allows it, costing time instead of a slot — which the
  world clock already makes meaningful.

Anything outside the subset is refused honestly by the intent parser, the way `cast` is
today. A clear "that spell isn't in this game yet" beats a silent approximation.

### 14.5 Death, and what happens after

Currently HP 0 is instant death. 5e is more interesting, and for a solo game the design
question matters more than the rule.

- **Death saves.** At 0 HP the character is unconscious and stable/dying is resolved by
  three successes or three failures. A natural 20 restores 1 HP; a natural 1 counts twice.
  Damage taken while down is an automatic failure; damage from a crit is two.
- **Stabilisation** by a Medicine check or any healing.
- **On actual death**, offer three options, driven by the difficulty setting:
  1. **Rewind** to the start of the encounter. Free, exact, already built (§19 of Part I) —
     this is the single best argument for the event-sourced design.
  2. **Continue** — the campaign goes on without the character. For a solo game this
     usually means a new character picking up the thread.
  3. **Permadeath** — the save is closed and archived.

Whichever is chosen, the death is journaled and the world remembers it: NPCs who witnessed
it learn a fact, factions react, quests fail.

---

## 15. Combat, in detail

Part I §6.5 sketched combat. The detail that matters:

- **Initiative** — d20 + dex mod, ties to higher dex, then to the PC. A turn-order queue on
  `CombatState`.
- **Action economy** — action, bonus action, movement, one reaction per round. Modelled
  explicitly, because "why can't I do that" is answerable only if the budget is real.
- **Zones, not a grid.** Already chosen. Movement is zone-to-zone along the adjacency list;
  a move within your zone is free, a move between adjacent zones costs your movement, and a
  zone two steps away needs a Dash. This gives you positioning, flanking-by-zone, ranged vs
  melee, and cover, at a fraction of a grid's complexity — and it reads well in text.
- **Opportunity attacks** on leaving a zone occupied by a hostile, unless you Disengage.
- **Cover** from zone features: half (+2 AC), three-quarters (+5), total (untargetable).
- **Conditions with real mechanics.** Today only four affect anything. Implement the SRD
  set properly: blinded, charmed, deafened, frightened, grappled, incapacitated, invisible,
  paralysed, petrified, poisoned, prone, restrained, stunned, unconscious, plus the six
  exhaustion levels.
- **Monster behaviour** by policy, like companions — never an LLM. Add `target_priority`
  (lowest HP, biggest threat, nearest, spellcaster-first) and **morale**: creatures below a
  threshold flee, which makes fights end in ways other than a wipe.
- **Companion directives** — the player can spend their turn giving an order ("Mira, hold
  the door"), which sets a one-round override the policy must respect.

**Presentation note that is really a design constraint:** the combat log is a *separate*
stream from the narrative feed (§17.4). Mixing "you hit for 7" into the DM's prose makes
both worse.

---

## 16. World systems

What a tabletop session has that the engine does not yet.

### 16.1 Settlements

There is no layer between a room and the world. Towns need one.

New schema `Settlement`: id, name, region, member `location_id`s, population, and
**`reputation_with_pc`** — a town-level standing separate from any individual's opinion and
from faction rep. Killing someone in the street should move all three differently.

Settlements own **services**: an inn (long rest at a price, rumours), a shop (§16.4), a
temple (healing, curing conditions), a job board (repeatable quests). Services are
`Location`s tagged with a service type, so they are ordinary rooms the player walks into.

### 16.2 Fast travel

Over the graph of **discovered** locations only.

- Costs the real travel time along the shortest discovered path, so deadlines still bite.
- Carries **encounter risk** proportional to path `danger_level` and time of day; a rolled
  encounter interrupts the journey at the risky node.
- Blocked in combat, while over-encumbered, and by location flags (`no_fast_travel` for a
  dungeon you have to walk out of).
- Implemented as a single `fast_travel` action resolving to a sequence of `move_entity` and
  `advance_time` effects, so the journal records the whole journey.

### 16.3 Loot and persistence

**Recommendation: persist.** Items dropped or left behind stay where they are, forever.
`ItemInstance.owner` already models this correctly and the phase-0 store already writes it.

A world that quietly deletes what you left on the floor teaches players that the world is a
backdrop. Persisting costs nothing — a save is a few hundred kilobytes of text — and it
buys the stash-in-the-inn behaviour that makes a place feel like *yours*.

Corpses become containers holding what the creature carried, and decay to nothing after a
few in-world days, so a battlefield does not stay a shop forever.

### 16.4 Economy

- **Shop inventories** are real `ItemInstance`s owned by a container, restocked on a clock,
  so buying the last healing draught means there is not one.
- **Prices** already shift with affinity (`priceMultiplierPct`). Haggling is a Persuasion
  check against a DC set by the merchant's Insight; success shifts one band.
- **Selling** at a markdown, typically half, worse for goods the merchant does not deal in.
- Currency stays in copper internally (`value_cp`) and is displayed in gp/sp/cp.

### 16.5 Random encounters

`encounter_table_id` exists on `Location` and nothing reads it. Give it a table of weighted
entries — combat, discovery, social, environmental — rolled on travel and on resting in
dangerous places. Not every encounter is a fight; a table of only monsters makes travel a
chore.

---

## 17. The web client

Mobile-first, because the point is playing on a phone. Everything below is a view over
state that already exists unless marked NEW.

### 17.1 Layout

- **Desktop**: three columns — character rail (left), narrative feed (centre), context
  panel (right, tabbed: quests / map / party / log).
- **Mobile**: single column, narrative feed full width, with a bottom tab bar for
  character / quests / map / log. The feed is never more than one tap away.
- The narrative feed is the anchor on both. Everything else is a panel over it.

### 17.2 Character rail — the always-visible stats

HP bar, AC, conditions as chips, spell slots as pips (one row per level), hit dice, and the
active concentration spell if any. Portrait, name, level, XP bar.

**On "mana":** 5e has no mana — it has spell slots, and slots are more interesting because
a 1st-level slot and a 3rd-level slot are different resources. Pips per level read better
than a bar anyway. If you want a mana bar instead, that is a real fork in the rules and
should be a campaign setting, not a display choice. See §19.

### 17.3 Narrative feed

Streamed prose (§18), the player's own input echoed above each response, and inline
**dice-roll cards**.

The roll card is the most important component in the client. It shows the natural die, the
modifiers *itemised by source*, the DC, and the outcome — `d20 14 · +3 dex · +2 prof · −2
dim light · = 17 vs DC 15 · SUCCESS`. The engine already produces every one of those
numbers with its provenance (`rules/modifiers.ts` returns a reason per modifier). Surfacing
them is what convinces a player the DM is not fudging, which is the whole reason the
architecture puts dice in code.

### 17.4 Combat view

Activates on `start_combat`. Initiative order as a strip, zones as a small node diagram
with tokens, a separate scrolling combat log, and action buttons for the current turn's
economy. The narrative feed continues underneath, one paragraph per round rather than per
action, so prose does not drown the tactics.

### 17.5 Quest tracker

Active / completed / failed. Per quest: summary, current objective, every lead learned with
where it came from, and — where the lead points somewhere — a button that pins it on the map.
`dm_notes` never appears here; it is the DM's, not the player's.

### 17.6 History log — NEW view, existing data

Two streams over the journal:

- **Events** — every turn, filterable by type, with its dice.
- **Chronicle** — only what mattered: facts of importance 4–5, quest transitions, deaths,
  relationship shifts past a threshold. This is the "what have I actually done" view.

**The cascade inspector.** Every cascade event already records `derived_from` and
`trigger_id`. Click any consequence and see the chain that produced it: *you killed Garret →
`t_garret_falls` fired → Ashen Hand reputation −30 → spilled −9 onto four members → a fact
was written → three people witnessed it*. No other game in this genre can show you that,
because no other one keeps the causal graph. It is nearly free here and it is the single
most distinctive thing the client can offer.

Same view is the **rewind UI**: pick any row, see what would be undone, confirm.

### 17.7 Relationships view — NEW view, existing data

Three tabs, because they are three different things and players conflate them:

- **People** — every character you have met, their disposition, the four dimensions as small
  bars, their written opinion of you, and their attitude history as a sparkline with the
  reason on hover.
- **Factions** — reputation, known members, goals, and what they have been doing offscreen
  (from the ambient beats).
- **Settlements** — town-level standing, services, and whether you are welcome. NEW data
  (§16.1).

### 17.8 Character sheet and equipment

Full sheet with derived values shown as their computation, not just their result: hovering
AC shows `11 leather + 3 dex = 14`.

**Equipment.** Slot-based, click-to-equip on mobile and drag on desktop, with the derived
stats updating live and a diff on hover (`+1 AC, −1 stealth`). Inventory filterable by kind,
with weight if encumbrance is on, and attunement shown as three slots.

### 17.9 Map — NEW rendering, NEW schema

The one thing here that needs a schema change, and it is cheap now and painful later:
**`Location` needs coordinates.** Add `coords: { x, y }` and `Region` needs a bounding box.
Retrofitting coordinates onto a hand-authored world after it has grown is miserable.

- Canvas or SVG, pan and zoom, drawn from the location graph with exits as edges.
- **Fog of war** — undiscovered locations are absent; discovered-but-unvisited are outlined;
  visited are filled. `Location.discovered` and `visited_count` already carry this.
- **Pins** — the player, active quest objectives, pinned leads, settlements, points of
  interest. Different shapes, not just different colours.
- Click a discovered location to **fast travel** (§16.2), with the time cost and encounter
  risk shown before confirming.
- Region-level zoom out to a world view; region maps stitched by shared edges.

### 17.10 Ambient feed

The offscreen beats the world generates (§Part I, ambient) shown as a quiet "meanwhile"
strip — *the Ashen Hand moved openly while you were away*. This is what makes the world feel
like it kept running. It is already generated and currently thrown away by the CLI.

### 17.11 Settings and accessibility

For a text-first game these are not optional extras:

- Text size, line width, and font (including a dyslexia-friendly face).
- Reduced motion, honouring `prefers-reduced-motion`.
- Light/dark/system.
- Screen-reader semantics on the feed — new prose announced politely, roll cards read as a
  sentence rather than as a table.
- Session-zero content settings, editable mid-campaign.
- **Export the campaign** as a readable chronicle — Markdown or a printable page. People
  want the story they made.

---

## 18. Latency and streaming

Two model calls per turn is three to six seconds. That is a long time to stare at nothing,
and it is worth designing around rather than apologising for.

**The tension to resolve first:** the narrator returns a JSON envelope, and JSON does not
stream into a reader nicely. Three options, in order of preference:

1. **Order the schema so `narration` comes first, and incrementally parse the stream.** Show
   prose as it arrives, apply the metadata when the object closes. One call, full streaming,
   no extra cost. This is the recommendation.
2. Two calls — one streaming prose, one extracting metadata. Simple, but doubles latency and
   cost, and risks the two disagreeing.
3. No streaming. Acceptable only if 1 and 2 both fail on a given provider.

**Everything else that helps:**
- Intent parsing on the fastest cheap model available, at temperature 0. It is translation,
  not authorship.
- Echo the player's input immediately and show the dice result *before* the prose arrives —
  the mechanics resolve in microseconds, so there is no reason to make the player wait for
  the narrator to learn whether they succeeded.
- Prompt caching on the stable prefix (system prompt, campaign constants).
- A skeleton or a period-appropriate idle line, never a spinner.

---

## 19. Open design decisions — ANSWERED

> **All of these were decided. See Part III §22 for the settled table.** Kept here with the
> original recommendations so the reasoning behind each answer is still visible.

1. **Spell slots or mana?** Slots are 5e-accurate and mechanically richer; mana is simpler
   and more familiar from video games. Recommendation: slots.
2. **Loot persistence?** Recommendation: persist forever, with corpses decaying.
3. **Death handling?** Recommendation: death saves, then offer rewind / continue /
   permadeath per the difficulty setting.
4. **Levelling: XP or milestone?** Recommendation: XP, with milestone as a campaign flag.
5. **How much of 5e?** Recommendation: SRD subset — levels 1–8, spells to 3rd level, the
   full condition list. Say no clearly rather than approximating.
6. **Encumbrance on or off by default?** Recommendation: off; it is bookkeeping most solo
   players will not thank you for.
7. **Party size.** One PC plus how many companions? Recommendation: up to two, because the
   turn loop and the prompt budget both stay manageable.
8. **Map style.** Abstract node graph (cheap, always correct) or hand-drawn regions with
   pinned locations (prettier, needs art)? Recommendation: node graph first, art later —
   the schema is the same either way.
9. **Is the campaign fixed or generated?** The Drowned Bell is hand-authored. A generator
   ("give me a premise, get a world") is a genuinely different product and a large one.

---

## 20. Revised roadmap — SUPERSEDED

> **Part III §30 is the current roadmap.** This table predates the party, campaign and
> co-op scope and is kept only for the schema-migration list, which §30 extends.

Phases 0 and 1 are complete. Much of what Part I called phases 2 and 3 was built alongside
them — the fact ledger, retrieval, relationships, knowledge propagation, gossip, quest state
machines, deadlines, the world clock, NPC schedules, factions and travel all exist and are
tested. What remains of those phases is their *gates*, not their code.

| Phase | Scope | Gate |
|---|---|---|
| **2. Verify** | The canon test and the deadline-failure test Part I asked for. No new systems. | A 60-turn session recalls a turn-3 detail unprompted at turn 55; a quest fails by expiry with its cascade intact. |
| **3. Character** | §14 — creation, progression, equipment and derived AC, the spell subset, death saves. | A character can be made, played to level 3, killed, and recovered by rewind. |
| **4. Combat** | §15 — initiative, action economy, zones, conditions, monster and companion policy, morale. | A 3-round, 4-combatant fight with a spell, a condition and a flee, verified by hand against the SRD. |
| **5. World** | §16 — settlements, fast travel, economy, encounter tables, loot and corpse rules. | Travel across three settlements, buy and sell, survive a rolled encounter, return to find what you left. |
| **6. Client** | §17 — the whole web UI, mobile-first, plus §18 streaming. | A full session played end to end on a phone, including a rewind from the history log. |
| **7. Deploy** | Vercel plus Postgres behind the existing `PostgresStore`. | A save made locally loads identically from the hosted deployment. |

**Schema changes to make early**, because they are cheap now and painful later:

- `Location.coords: { x, y }` and region bounds — needed by the map (§17.9).
- `Settlement` as a new top-level record (§16.1).
- `Entity.pronouns`.
- `CampaignMeta.session_zero` — tone, lines, veils, difficulty.
- `Entity.xp` and the levelling fields.
- `ItemOwner` container arm made real, for packs and corpses.

Do these in one migration at the start of phase 3, not one at a time.

---

## 21. What stays true

Everything in Part II is a view over state, a rule in code, or content. None of it moves
authority to the narrator. The test at the end of every phase is still the one from §0: if
the model vanished, would the save still be a complete, correct, playable world?

---

# Part III — the game around the game

Part I built the engine. Part II specified the character, world and client systems. Part III
covers the decisions that were open, the party, and the campaign structure above quests.

**The two goals everything in Part III answers to:**

1. **It has to work on a phone.** One thumb, one column, no hover.
2. **It has to teach 5e to someone who has never played, without bastardising it.** A player
   who finishes a campaign here should be able to sit down at a real table and know what a
   saving throw is.

Those goals mostly agree with each other. Where they conflict, the second wins: this is a
D&D game, not a chat toy with dice in it.

---

## 22. Decisions, settled

Recording §19's answers so nothing is guessed at again.

| # | Decision | Answer |
|---|---|---|
| 1 | Slots or mana | **Spell slots.** 5e-accurate, taught through the UI (§23) |
| 2 | Loot persistence | **Persist forever.** Corpses become containers and decay |
| 3 | Death | **Death saves**, then rewind / revive / continue / permadeath (§26.4) |
| 4 | Levelling | **XP**, with the award table in §27 |
| 5 | How much 5e | SRD subset: **levels 1–8, spells to 3rd, full condition list** |
| 6 | Encumbrance | **Off** by default, available as a variant |
| 7 | Party size | **Up to 4**, default 3. Co-op-ready from the schema up (§25) |
| 8 | Map style | **Node graph first**, art later. Same schema either way |
| 9 | Campaign | **Hand-author one, then generate.** Structure in §26 |
| 10 | Dice and rewind | **Committed dice** — rewinding cannot reroll a check (§24) |
| 11 | Audio | **None.** No TTS, no voice. Text and UI only |

---

## 23. Teaching 5e through the interface

This is the design problem, stated properly: Baldur's Gate 3 is the best 5e tutorial ever
made, and it teaches almost entirely through **affordances** — the action bar shows you have
one Action, one Bonus Action and 9 metres of movement left, and it shows you exactly which
options each will buy. You cannot take an illegal action because illegal actions are not
offered. You learn the rules by watching the budget move.

We can do that *and* keep the free-text box, which BG3 cannot. That combination is the
whole product:

> **The buttons teach you the rules. The text box lets you exceed them.**

BG3 can only recognise what Larian coded. Our DM can adjudicate "I tie a rope to the arrow
and shoot it across the chasm" — the thing tabletop players actually love and every CRPG
loses. So the affordance bar is not training wheels we remove; it is the rules made visible,
sitting next to a box where you can try anything.

### 23.1 The affordance engine — NEW module

`src/rules/affordances.ts`, pure code:

```ts
interface Affordance {
  action: Action;              // ready to hand straight to resolve()
  label: string;               // "Attack the bonepicker"
  cost: "action" | "bonus" | "movement" | "reaction" | "free" | "time";
  detail: string;              // "1d6+3 piercing, +5 to hit vs AC 12"
  available: boolean;
  why_unavailable?: string;    // "You have already used your action"
  teaches?: string;            // one line of rules, shown on first encounter
}

function affordances(s: GameState, actorId: string): Affordance[];
```

Everything it needs already exists — the resolver knows what is legal, `modifiers.ts` knows
why a DC moved, and the item and spell systems know what you are carrying. This module
inverts the refusal logic: instead of only saying no after the fact, it enumerates yes in
advance.

**Unavailable actions are shown greyed with the reason, never hidden.** "You cannot cast
that — no 2nd-level slots remaining" teaches the resource. Hiding it teaches nothing.

### 23.2 What the player sees

- **In combat**: an action bar with Action / Bonus / Movement / Reaction as distinct pips,
  and the options each affords. Spending one visibly empties it. This single component does
  most of the teaching.
- **Out of combat**: contextual chips — the exits, the people, the things you could search —
  above the text box. Tapping one fills the box with the phrasing rather than submitting it,
  so the player learns the words and can edit them. That is how a chip bar teaches language
  instead of replacing it.
- **First-encounter tooltips**: the first time a concept appears (advantage, a saving throw,
  concentration, a short rest) show one sentence explaining it. Once each, dismissible,
  tracked in `CampaignMeta.taught: string[]`.
- **A rules glossary** reachable from any underlined term.

### 23.3 The roll card, again

The most important component in the client (Part II §17.3). BG3's roll display is the
single best thing about its onboarding: it shows the die tumbling, then the modifiers
stacking on one at a time, then the DC, then the result. The drama and the education are the
same animation.

Ours shows: the natural die, every modifier **itemised with its source**, the DC, the
outcome. `rules/modifiers.ts` already returns a reason per modifier, so this is a rendering
job, not a new system. Respect `prefers-reduced-motion` by showing the final card instantly.

---

## 24. Committed dice — SUPERSEDED by §32.1 (now one of three modes)

Rewind is a first-class feature (Part I §19). Save-scumming a failed lockpick until it
succeeds is not, and the current sequential PRNG allows a version of it: rewind, do something
unrelated to shift the stream, come back, and the check rolls differently.

**Fix: derive every roll from the situation rather than from a mutable stream.**

```
stream_key = H(campaign_seed, turn, actor_id, purpose, attempt_index)
```

where `purpose` names *what is being rolled and against what* — `stealth:npc_garret`,
`attack:mon_bonepicker:1`, `gossip`, `weather`. Each key seeds an independent generator.

The consequences are exactly the ones we want:

- **Rewinding and retrying the same check at the same turn gives the same result.** You
  cannot reroll a failure by reloading. The die was cast when the situation arose.
- **Changing your approach genuinely changes the roll.** A different skill, a different
  target, a different turn is a different `purpose`, and deserves a fresh die — because the
  fiction changed.
- **Explicit rerolls still work.** Lucky, Bardic Inspiration and the like increment
  `attempt_index`, which is a rule, not an exploit.
- **Replay stays exact and gets simpler.** The hash is pure, so `meta.rng_state` and the
  `rng_state_before/after` fields on events can be **removed entirely** — there is no
  mutable generator left to thread or restore.

This is a net simplification of the engine on top of being the anti-cheese design. Do it in
the phase-3 migration.

**Note the honest limit:** rewinding still lets a player retry with a *better idea*, which is
correct — that is what a rewind is for. What it no longer does is let them retry with the
same idea until the dice relent.

---

## 25. The party

### 25.1 Companions are people, not stat blocks

Every companion carries what an NPC carries — `personality`, `goals`, `known_fact_ids`,
relationships — plus:

- **`alignment`** (NEW): the 5e nine, used by the reaction rules below. Never used to
  constrain player choice, only to predict companion response.
- **A personal arc**: their own quest chain, gated on their approval of the party. This is
  the Baldur's Gate 3 pattern and it is the reason people remember Astarion.
- **Their own opinions of each other**, not only of the player. The relationship graph is
  already directed and n-to-n; nothing needs to change to support party members disliking
  one another.

### 25.2 Approval — reactions in code, not vibes

New module `src/rules/approval.ts`:

```ts
function reactTo(companion: Entity, event: GameEvent, s: GameState): Dims;
```

Driven by the companion's alignment, ideal, bond and flaw against what just happened —
killing a surrendering enemy, lying to a friend, giving money to the destitute, siding with
a faction they hate. Returns attitude deltas that go through the normal clamped path.

Companions **say so**. An approval shift above a threshold triggers a short line from that
companion in their own voice — one cheap `companion` model call, the role that is already
configured and unwired. This is how the player learns their party has opinions.

Sustained low approval has consequences: refusal to help, then leaving, then in extreme cases
turning on the party. All authored as triggers on the approval dimension, so a campaign can
tune how forgiving it is.

### 25.3 Recruitment and the bench

- Recruitable characters are found in play, with their own reasons for joining that the
  player has to satisfy.
- The active party is up to four, including the player character. Others wait somewhere
  they would plausibly wait — an inn, a camp — and **keep living there**: they gossip, their
  schedules run, their opinions drift. Nobody is stored in a box.
- Swapping is a scene, not a menu action, when it happens in the fiction.

**Why four is fine:** the constraint is not the engine, it is the prompt and the turn count.
Each companion costs roughly eighty tokens of context, so four is comfortable inside a 6k
budget. Combat length is the real cost — more combatants, more turns per round — which is an
argument for keeping fights small, not the party.

### 25.4 Party members are mortal

Companions take damage, roll death saves and die. The system must never quietly protect
them. When one goes down:

- The rest can reach them and stabilise or revive.
- If the party leaves them, they die, and the world learns it: witnesses, facts, faction
  reactions, their personal quest failing.
- Rewind remains available and is the honest way out of a bad fight.

---

## 26. Co-op and the split party

This is the largest single addition on the list, and the architecture takes it better than
most would, because state is global and the reducer is actor-agnostic. The hard part is not
the rules — it is that the DM has to narrate two places at once.

**Sequencing recommendation: build the schema for it now, ship solo, add co-op as its own
phase.** Retrofitting multi-actor onto a one-PC assumption is expensive; leaving four fields
unused for a while costs nothing.

### 26.1 Schema now, feature later

- `CampaignMeta.pc_id` becomes **`party_ids: Id[]`**, with `player_controlled: Id[]` naming
  who a human is currently driving. Everything that reads `pc(s)` becomes actor-scoped.
- `Entity.controller: "human" | "cpu"`, plus `controller_session` when a human holds them.
- **`Group`** (NEW): a set of party members travelling together, with its own location. The
  party is one group by default; a split makes two.

### 26.2 The split party

When groups are in different places, each group is its own scene:

- Each group gets its own **context build and its own narration call**. The context builder
  already takes a location, so this is a loop rather than a redesign.
- Each group has its own turn order; the world clock is shared, so time spent by one group
  passes for the other. That is what makes splitting a real decision rather than free
  parallelism.
- The DM is told, explicitly, what the *other* group is doing and that this group does not
  know it. Dramatic irony is a feature; letting one group act on knowledge it does not have
  is the bug the knowledge model already exists to prevent.
- Rejoining merges the groups and, importantly, **exchanges facts**: each group learns what
  the other saw, via `teach_fact`, which is exactly the mechanism gossip already uses.

### 26.3 Drop-in, drop-out

- A friend joins and takes a party member: `controller` flips to `human`. Nothing else
  changes — that character was always a full entity with their own goals.
- They leave: `controller` flips back to `cpu`, and the CPU **continues their intentions**,
  not a blank policy. The character's `goals` and current quest are what they were pursuing;
  the AI picks that up.
- The remaining player can **call them back** to the group or **direct** them, offered as a
  small set of choices rather than free text, because ordering another character around
  should feel like negotiation, not puppeteering. A companion whose approval is low may
  refuse — their actions remain their own.
- A character under CPU control on their own errand can fail, get hurt, or get into trouble
  offscreen. The ambient system (Part II) is the right place for that, and it must be allowed
  to hurt them. Nobody offscreen is invincible.

### 26.4 Death, revisited with a party

With companions present the death options become better than the solo case:

1. **Revive** — the party goes back for them. A living party member can stabilise, or carry
   the body to a temple. This is the preferred route because it is a *story*.
2. **Rewind** — free, exact, always available.
3. **Continue** — the character is gone; their quests fail, the party reacts, the world
   remembers.
4. **Permadeath for the whole save** — only if the campaign was set up that way.

---

## 27. Progression: XP and what earns it

XP over milestone, per §22. The gap was never the thresholds — it was deciding what pays.

**Levels 1–8**, SRD thresholds (300 / 900 / 2,700 / 6,500 / 14,000 / 23,000 / 34,000).

| Source | Award | Why |
|---|---|---|
| Defeating a creature | SRD XP by CR | The baseline |
| **Resolving an encounter without violence** | **The same XP as defeating it** | Non-negotiable. If talking your way past the guard pays less than killing him, the system has told the player what it wants, and it is not what we want |
| Completing a quest step | Authored, roughly one encounter of the party's level | Progress should feel like progress |
| Completing a quest | Authored, larger | |
| Discovering a significant location | 25–100 | Rewards curiosity, which is the engine's strength |
| Learning an importance-4+ fact | 25–50 | Rewards paying attention |
| Companion personal-arc beats | Authored | Keeps the party worth investing in |

XP is awarded to the whole party, split evenly, including members who were elsewhere — a
split party should not punish the half that took the quiet job.

`grant_xp` and `level_up` are Effects, so all of it is journaled and replays exactly.

---

## 28. Campaign architecture

The Critical Role structure you described — several arcs inside a campaign that tie
together, then a *new* campaign in the same world with a different party and quiet
connections, then eventually convergence — is a genuinely good model for this system,
because it plays directly to what event sourcing is good at: a world that remembers.

**Legal note, since you named it:** Exandria and Critical Role's characters and places are
their intellectual property, not open content. We take the *structure* — multi-arc campaigns,
a persistent world across parties, generational callbacks — and build original settings on
SRD foundations. The shape is the lesson; the names are theirs.

### 28.1 The hierarchy — NEW layer above quests

```
World          persistent. The map, factions, settlements, and everything
  │            previous campaigns changed. Outlives every party.
  └── Campaign one party's run through it. 3–5 Arcs. Has an overarching goal.
        └── Arc  a movement of the story. Owns quests, has a climax, plants seeds.
              └── Quest (already built)
```

**`World`** gains a **legacy ledger**: an append-only record of what each completed campaign
changed — who died, which faction rose, which town burned, which artefact is now buried
where. It is the fact ledger's older sibling and it works the same way.

**`Arc`** (NEW): id, title, status, member quest ids, a `climax_quest_id`, `themes`, and
**`seeds`** — hooks it plants that later arcs or campaigns may pick up. A seed is a small
authored object: a fact, a location, an NPC who survived, a debt unpaid.

**`Campaign`** (NEW): id, title, premise, arc ids, the starting party, and a
**`world_mutation`** — the diff it applies to the base world when chosen.

### 28.2 Choosing a campaign re-renders the world

At the start, the player picks from a few campaign options. Each carries a `world_mutation`:
locations added, altered or removed; factions repositioned; NPCs placed, aged or killed;
starting facts seeded.

This is applied as an ordinary list of Effects at turn zero, which means it is journaled,
replayable and rewindable like everything else. No special path.

### 28.3 Succession — how a world becomes lived-in

When a campaign completes, a **succession step** runs:

1. Write the legacy ledger: what this party did, permanently.
2. **Age the world** — a time skip of months or years. Settlements grow or decline, NPCs age
   or die, factions rise on the reputation the party left them with.
3. **Promote seeds**: unresolved threads become available quests or rumours in the next
   campaign.
4. Offer the next campaign, with a new party, in the changed world.

The third campaign in a world can then legitimately have the earlier parties' survivors in
it — as allies, as legends, as antagonists — because the system knows exactly what they did
and to whom. This is the payoff for keeping the causal graph, and no amount of prompt
engineering substitutes for it.

### 28.4 Authoring: hand-author one, then generate

You are not a writer, so do not hand-write four campaigns.

- **Bootstrap**: one hand-authored campaign of three arcs, to prove the shape. The Drowned
  Bell becomes its first arc.
- **Then a generator**: an offline tool that takes a premise, a tone and a length and emits
  the same validated JSON — arcs, quests, locations with coordinates, NPCs with
  personalities and secrets, factions, triggers, seeds.

The generator is the right place for a language model to write, and it is worth being
precise about why: it produces **content, not runtime truth**. Output is validated by the
referential-integrity checker (Part I §content), reviewed, and frozen as authored data. From
that moment it behaves exactly like hand-written content and the engine cannot tell the
difference. The DM at play time still gets no authority it did not have before.

Recommended generator sequence: premise → world skeleton (regions, factions, settlements) →
arc outline → quest graph with dependencies → locations and coordinates → cast with secrets
and relationships → triggers wiring it together → validate → freeze.

---

## 29. What we take from Baldur's Gate 3, and what we do differently

Worth stating plainly, because it clarifies what this thing is.

**Take:**
- The action-economy bar as a teaching device (§23).
- The roll card: die, modifiers stacking, DC, result.
- Companions with alignments, approval, personal arcs and opinions about each other.
- Environmental interaction as a real tactical layer — surfaces on zones (fire, grease,
  water, ice) with rules attached. Optional, phase 4, genuinely fun.
- Searchable containers everywhere; curiosity should pay.

**Do differently:**
- **Improvisation.** BG3 can only recognise what Larian coded; the roped arrow across the
  chasm does not work. Our DM adjudicates it. This is the single thing we can do that no
  CRPG can, and every design decision should protect it.
- **Reactivity.** BG3's branches were all pre-written. Ours are computed from state, so an
  NPC's response follows from what they actually know and how they actually feel.
- **Save-scumming.** BG3 lets you reload until the dice cooperate. We give you rewind as an
  honest, first-class feature, and committed dice so it cannot be used to launder a bad roll
  (§24).
- **Scope.** A fixed, hand-crafted world of enormous size versus a smaller world that
  remembers everything and generates more. We are the second thing.

---

## 30. Roadmap, revised again — SUPERSEDED by §37

| Phase | Scope | Gate |
|---|---|---|
| **2. Verify** | Canon test, deadline-failure test. No new systems. | A turn-3 detail recalled unprompted at turn 55; a quest fails by expiry with its cascade intact |
| **3. Character & dice** | §14 creation, progression, equipment, spell subset, death saves. **Committed dice (§24)** and the schema migration | A character made, played to level 3, killed, recovered by rewind. Rewinding cannot reroll a check |
| **4. Combat** | §15 initiative, action economy, zones, conditions, monster and companion policy, morale. **Affordance engine (§23.1)** | A 3-round, 4-combatant fight with a spell, a condition and a flee, hand-verified against the SRD. Every legal action is offered; no illegal one is |
| **5. Party** | §25 alignment, approval, recruitment, personal arcs, companion mortality | A companion approves, disapproves, threatens to leave, goes down, and is revived |
| **6. World** | Part II §16 settlements, fast travel, economy, encounters, loot and corpses | Travel three settlements, trade, survive a rolled encounter, return to find what you left |
| **7. Client** | Part II §17 whole UI, mobile-first, §18 streaming, §23.2 affordance bar, cascade inspector | A full session on a phone, including a rewind from the history log and a fight fought from the action bar |
| **8. Campaign** | §28 world/campaign/arc, succession, the generator | Complete a campaign, run succession, start a second in the same world that references the first |
| **9. Co-op** | §26 groups, split party, drop-in/drop-out | Two humans, split party, one drops out mid-quest and the CPU carries their intent |
| **10. Deploy** | Vercel plus Postgres behind `PostgresStore` | A save made locally loads identically from the hosted deployment |

**One migration, at the start of phase 3**, covering every schema change now known:

- `Location.coords: {x, y}`; region bounds
- `Settlement` as a top-level record
- `Entity.pronouns`, `Entity.alignment`, `Entity.xp`
- `CampaignMeta.session_zero` (tone, lines, veils, difficulty) and `.taught`
- `CampaignMeta.pc_id` → `party_ids` + `player_controlled`; `Entity.controller`
- `Group` as a top-level record
- `Arc`, `Campaign`, `World.legacy` records
- **Remove** `meta.rng_state` and `Event.rng_state_before/after` — committed dice make them
  dead weight
- `ItemOwner` container arm made real

Do it once, with the golden replay test as the safety net. That test exists precisely so a
migration of this size can be made without fear.


---

# Part IV — notes on feel

## 31. What makes it fun, and where it comes from

Written after building combat, because building it is when the questions got concrete.

### 31.1 Dice, revised

Committed dice (§24) were the right answer to *cheese* and the wrong answer to *fun*. A die
you can predict is not a die. So dice are now a session-zero choice:

| mode | what it is | who it is for |
|---|---|---|
| **karmic** (default) | Real rolls with a subtle streak-breaker: after a cold run the next roll is nudged up, after a hot one nudged down. Never decides a roll; only leans. Baldur's Gate 3 ships this on by default and most players never notice — they just stop feeling cursed. | Everyone, until they ask |
| **true** | A physical die. No memory. | Purists |
| **committed** | Seeded by the situation. Rewind cannot reroll. | Ironman players; anyone who found themselves reloading |

All three journal the roll, so replay stays exact. The `recent_d20s` on a character doubles
as a "luck" readout for the sheet — a small honest window into the streak-breaker.

Rewind under karmic dice *can* reroll a check. That is the tradeoff and it is stated plainly
in the UI. The mitigations are social, not mechanical: the timeline shows every rewind, and
the campaign summary counts them. BG3 does the same and it is enough.

### 31.2 What we took, and from where

- **Hit chance on every attack** — BG3, XCOM, Fire Emblem. The single most useful number a
  newcomer can see. "I took a 45% shot and it missed" is a story; "why did I miss" is a bug
  report. It is on the affordance bar and belongs on the roll card.
- **Action / Bonus / Movement / Reaction as pips** — BG3. The economy is the rule most
  newcomers never learn at a table. Showing it spend is the whole tutorial.
- **Greyed, never hidden** — Into the Breach, Slay the Spire. An option you cannot take,
  with the reason beside it, teaches more than one that disappeared.
- **Enemy intent** — Slay the Spire. Worth adding: monsters telegraph their next action
  ("the bonepicker is going to lunge at Sela"). The CPU policy is deterministic given
  state, so this is *free* — call `choosePolicyAction` for display. It makes tactics
  legible without dumbing the fight down, and it is exactly how a good DM narrates a
  monster's posture. **Recommended for the client, phase 7.**
- **Concentration shown as a held thing** — BG3 marks it on the portrait. Losing it should
  be a visible break, not a log line.
- **Ending your turn is explicit** — BG3, every tactics game. Tempting to auto-end when the
  action is spent; wrong, because bonus actions and movement are where the interesting
  decisions live. The bar makes "End turn" obvious instead.
- **Fights end themselves** — the moment a side is done, combat closes and the world
  resumes. No "are you sure". Hades taught this: keep the loop tight.
- **Choices as chips that fill the box, not submit it** — 80 Days, Sorcery!. The chip
  teaches the phrasing; the player still says it.
- **The DM voices the monster's morale** — a creature that flees at a quarter health is a
  rule (`ai_policy`, §15) and a story beat. Both. The narrator gets the flee as mechanics
  and makes it cowardice or cunning.

### 31.3 Things deliberately NOT taken

- **A grid.** Zones give reach, cover-by-position, opportunity attacks and flanking-by-zone
  at a tenth of the UI cost, and they read in prose. A grid is a phase-7 option, not a
  phase-4 requirement.
- **Auto-resolve / "skip combat".** It removes the part of 5e newcomers most need to learn.
  Rewind and morale keep fights short; that is the accessibility feature.
- **Hidden rolls.** Every die is shown. A DM who rolls behind a screen is trusted because
  they are a person; software that rolls behind a screen is suspected because it is not.

---

# Part V — where the build actually is

Parts I–IV were written before and during the build. Part V is written from the far side of
five completed phases, and it supersedes them wherever they disagree.

**Status: phases 0–4 complete and gated.** 61 source files, ~8,200 lines, 151 tests, five
gates met, both demos replaying byte-identical.

---

## 32. Changelog — what the build taught us

Things that changed because building them proved the plan wrong.

### 32.1 Dice: committed → three modes, karmic by default

§24 specified committed dice — every roll seeded by the situation, so rewind could not
reroll. Correct answer to *cheese*, wrong answer to *fun*: a die you can predict is not a
die, and rolling is a third of why people play.

Now a session-zero choice:

| mode | behaviour | default for |
|---|---|---|
| **karmic** | Real rolls with a streak-breaker. After a cold run the next die is nudged up; after a hot one, down. Never decides a roll, only leans on it. | everyone |
| **true** | A physical die. No memory. | purists |
| **committed** | Seeded by the situation. Rewind cannot reroll. | ironman |

All three journal a nonce, so replay is byte-exact in every mode. `Entity.recent_d20s`
carries the last twelve naturals, which feeds the streak-breaker and doubles as a "luck"
readout for the sheet.

**Known tradeoff, stated plainly:** under `karmic` and `true`, rewind *can* reroll a failed
check. Mitigation is social rather than mechanical — the timeline shows every rewind and the
campaign summary counts them. `committed` exists for players who want the door shut.

### 32.2 The RNG state was deleted, then partly returned

Committed dice let us delete `meta.rng_state` and the per-event `rng_state_before/after` —
a real simplification. Adding `true`/`karmic` back needed *something*, but not the old
mutable stream: events now carry an `rng_nonce`, and replay reuses it. Strictly better than
a stream pointer, because a rule that changes how many dice it draws no longer desyncs
every subsequent roll.

### 32.3 The attitude clamp only applies to untrusted sources

The ±10-per-turn clamp was written to restrain the narrator. Applied to authored content it
silently ate quest rewards — a `+20 affinity` reward delivered `+10` and nothing said so.
Now `EffectCtx.clampAttitude` is false for authored effects and true for anything from the
model.

### 32.4 `give_item` mints, `move_item` moves

Picking something up used `give_item`, which creates a fresh instance from a definition —
so the original stayed on the floor and the world quietly gained a second one on every
pickup. `move_item` now moves the object that exists.

### 32.5 Pronouns continue a fight; they never start one

"Hit it again" fell through to "the only person present" and swung at a bystander. A name
that misses is a question, never a substitution, and a pronoun only resolves against an
active combatant.

### 32.6 Combat is journaled per turn, not per exchange

Each CPU combatant's turn is its own root event. That is deliberate — rewind granularity is
per turn, and collapsing them would make "undo the goblin's crit" impossible. Batching
belongs in **presentation**, not the journal (§33.4).

### 32.7 Turn count is no longer script index

Before combat, thirty scripted actions produced thirty turns. Now the CPU takes turns too,
so `meta.turn` counts *root events*, not player inputs. Tests that assumed the old identity
were wrong, not the engine.

---

## 33. Evaluated suggestions

Each labelled with what to do about it. **CORE** means it changes the architecture and
should be built. **SUGGESTED** means take it or leave it on the merits. **BUILT** means it
already exists. **DECLINED** means we considered it and chose otherwise, with the reason.

### 33.1 Seeded roll journal — BUILT, and the proposed variant is worse

The `roll_pointer` form ("track an index into a pseudo-random sequence") is fragile in
exactly the way §32.2 describes: change how many dice any rule draws and every later roll
shifts. Our per-event nonce has the same determinism with none of the coupling. The
`committed` mode already delivers the anti-savescum behaviour the suggestion is after.

The framing to keep, though, is a good one and belongs in the UI copy:

> Rewinding does not reroll the die. It lets you change your mind. To change the outcome,
> change the approach — cast Guidance, find the key, come back with a friend.

That is `committed` mode's pitch, and it is why the mode exists even though it is not the
default.

### 33.2 Companion state schema — PARTLY BUILT; adopt the tiers and the trigger table

A single flat `approval: 45` is a **downgrade** from what exists. Relationships are already
directed edges with four dimensions — affinity, trust, fear, respect — plus tags and an
append-only history with a reason on every change. That is what lets an NPC like you and
not trust you, which is most of the interesting social space.

Three parts of the suggestion are genuinely additive and should be built in phase 5:

1. **Named tiers over the numeric spine.** `dispositionOf()` already derives a label; extend
   it to companions as `hostile / cold / wary / neutral / warming / friendly / devoted` and
   *show the tier, not the number*, in the party panel. Numbers in the debug view, tiers in
   the game. **SUGGESTED, recommended.**
2. **An explicit trigger table per companion**, rather than reaction logic that lives only
   in code: `on_kill_surrendered: { affinity: -15 }`, `on_charity: { affinity: +5 }`. Data
   an author can tune per character, evaluated by the existing trigger DSL. **CORE for
   phase 5** — it is what makes each companion feel like a different person rather than the
   same policy with a different portrait.
3. **`flee_behavior` per companion**, not just a morale threshold. "Casts invisibility and
   runs" versus "drops their weapon and begs" is characterisation doing mechanical work.
   **SUGGESTED, cheap.**

Note the suggested example had `on_charity: DECREMENT_5`, which is backwards for most
alignments — a reminder that the trigger table must be *per companion*, since the same act
is a virtue to one and a weakness to another. That asymmetry is the feature.

### 33.3 Inline mechanical tooltips — CORE for phase 7, with one architectural change

The idea is right and it is the single best approachability lever on the list: hovering
`[Sleight of Hand DC 15]` shows `+5 = Dex +3 + Proficiency +2`, and a beginner learns why
they are good at things without opening a menu.

**But the token must not come from the narrator.** `[Check|SleightOfHand|DC:15]` emitted
freely by a language model puts DCs back in the model's hands, which is the one thing this
whole architecture exists to prevent. Two layers instead:

- **Mechanics tokens are emitted by code.** The resolver already produces every number with
  its provenance — `rules/modifiers.ts` returns a reason per modifier. The roll card renders
  from that structured data. No parsing, no trust.
- **Entity links are resolved by code as a post-process.** The narrator writes plain prose.
  The client links names it recognises, using the same alias table `validate.ts` already
  uses to resolve "thorne about the bell" → `npc_thorne`. Tapping a linked name opens that
  character's card.
- Optionally, the narrator **may** emit `[[npc_thorne]]` markers to disambiguate when it
  knows what it meant. Validated like everything else: unknown ids stripped and logged. A
  hint, never an authority.

Net effect is the suggestion's player experience with none of its authority leak.

### 33.4 Aggregate enemy turns — CORE for phase 7

The right fix to a real problem: four monsters taking turns as four separate paragraphs is
agonising to read, and it is why text combat feels slow when tactical combat is not.

The split that matters, restating §32.6: **batch the narration, never the journal.** The
engine keeps one root event per combatant turn — rewind and the cascade inspector both need
that granularity. The client collects consecutive CPU turns and hands the whole exchange to
the narrator as one block, producing one cinematic beat with the roll cards beneath it:

> The three of them move at once — two circling to flank Sela while the archer finds the
> ledge.
>
> `Bonepicker → Sela · d20 14 +4 = 18 vs AC 15 · HIT 7 slashing`
> `Bonepicker 2 → moves to the water`
> `Archer → Vessa · d20 3 +5 = 8 vs AC 14 · MISS`

One narration call for the whole enemy phase instead of one per creature is also cheaper and
faster, which is the rare case where the good UI and the cheap implementation agree.

### 33.5 Action palettes, grouped and hotkeyed — SUGGESTED, recommended

The affordance engine already returns a `group` on every entry and greys the unavailable
with a reason. Grouping them into a collapsible hotbar with number keys is a client
refinement, not an engine change. Worth doing exactly as described.

The one thing to preserve: **the text box stays**. The palette is not the interface, it is
the tutorial that sits beside the interface. *The buttons teach you the rules; the text box
lets you exceed them* (§23) is the product, and a palette that replaces free text would
make this a worse BG3 instead of a better tabletop.

### 33.6 Two-column narrative / mechanics feed — BUILT in spec, confirm in phase 7

Already §17.3–17.4. The suggestion independently arriving at the same layout is a good sign.
On mobile, the two columns become one feed with the roll cards inline and collapsible —
narration is the anchor, mechanics fold under it.

---

## 34. Onboarding — the gap nobody had specified

The biggest remaining approachability hole, and it was not in any plan. A new player opens
the game today and gets a room description and a text box. Baldur's Gate 3's real
achievement is not its tooltips; it is that the first hour teaches you the whole rule set
without ever announcing that it is doing so.

**Character creation IS the tutorial.** Each step teaches exactly one concept as you use it:
ability scores teach modifiers, class teaches proficiency, background teaches where skills
come from, equipment teaches derived AC. `createCharacter` already produces all of it; the
flow just needs to explain itself as it goes.

**The first scene should be shaped, not open.** Three or four obvious affordances, one skill
check the character is good at, one NPC worth talking to, and one thing that rewards
searching. The Rusty Flagon nearly is this already.

**Teach on encounter, once each.** Built: `Affordance.teaches` plus `CampaignMeta.taught`.
Advantage, saving throws, concentration, short rests, the action economy — each explained
the first time it appears and never again.

**A first fight that is winnable and instructive.** One enemy, in a location with two zones,
so the action economy and zone movement both come up without either being lethal.

**SUGGESTED, high value:** a `/tutorial` campaign — the Flagon plus one three-zone cellar,
twenty minutes, ending at level 2. Cheap content, and it is what a new player is offered
first.

---

## 35. Fail forward — a narrator rule worth adding

Standard tabletop craft that is not yet in the DM's system prompt, and cheap to add:

> A failed check must **change the situation**, never stall it. The lock stays shut *and*
> the pick snaps off in the mechanism, and someone upstairs heard it. Never answer a failure
> with "nothing happens" — that is the one outcome a real Dungeon Master never gives.

The mechanics already support it: a failed roll is a fact the narrator can build on, and
`add_fact` plus `set_flag` are both on the narrator whitelist. This is one paragraph in
`renderSystem()` and it materially changes how failure feels.

Related: **difficulty currently does nothing.** `session_zero.difficulty` is stored and
never read. It should map to real levers — DC band shift, encounter budget, karmic strength,
and which death options are offered. **CORE for phase 5**, since it is small and it makes
session zero mean something.

---

## 36. Model routing, honestly

Two different questions get conflated here, and only one of them is real.

### 36.1 Runtime routing — real, and already built

Which model does which *job inside the game* is a genuine engineering decision, and
`config/models.json` already routes six roles independently:

| role | wants | why |
|---|---|---|
| `intent` | cheap, fast, temperature 0 | translation, not authorship |
| `narrate` | the good model | this is the product |
| `narrate_hi` | better, used sparingly | scene openings, big beats |
| `companion` | cheap | one line in a character's voice |
| `digest` | cheap | compress a finished scene, tone only |
| `ambient` | cheap | how an offscreen event looked |

The `Router` falls through providers on 429/5xx and retries with backoff. This is where
model selection actually pays, and it is done.

### 36.2 Build-time routing — weaker advice, and partly inaccurate

The suggested split rests on claims that do not hold: that Opus "writes great code blocks
but expects you to run them", and that long-horizon autonomous coding is a different model's
job. Phases 2–4 of this project were built by exactly that loop — write, typecheck, run the
suite, read the failure, fix, repeat — and the bugs in §32 were found that way rather than
by inspection.

The version of the advice that *is* true is about **workflow, not capability**:

- **Creative canon benefits from one long session.** Campaign arcs, faction motivations, the
  connective tissue between campaign one and campaign two — drift is the enemy, and drift
  comes from context boundaries, not from model choice. Generate a whole arc in one sitting.
- **Mechanical work benefits from a tight test loop**, whoever is driving. The gates exist
  so that "is this right" has an answer that is not an opinion.
- **The real split is by task shape**: anything with a passing test at the end wants
  iteration; anything judged by reading wants coherence and a single pass.

Use whichever model is in front of you for either; just match the loop to the work.

---

## 37. Roadmap, revised again

| Phase | Scope | Gate | Status |
|---|---|---|---|
| 0 | Skeleton | 30 actions, byte-identical replay | ✅ |
| 1 | LLM turn loop | 20 free-text turns, zero violations | ✅ |
| 2 | Verify | Canon test, deadline expiry | ✅ |
| 3 | Character & dice | Make → level 3 → die → rewind | ✅ |
| 4 | Combat | 4-combatant fight, spell, condition, flee | ✅ |
| **5** | **Party** — approval trigger tables (§33.2), companion lines, recruitment, personal arcs, mortality. Plus difficulty levers (§35) and the fail-forward rule. | A companion approves, disapproves, threatens to leave, goes down, is revived — and two companions react differently to the same act | next |
| 6 | World — settlements, fast travel, economy, encounters, loot | Three settlements, trade, a rolled encounter, return to find what you left | |
| 7 | Client — the whole UI, streaming, inline tooltips (§33.3), aggregate enemy phase (§33.4), action palette (§33.5), cascade inspector, map | A full session on a phone, including a rewind from the history log and a fight from the action bar | |
| 8 | Campaign — world/campaign/arc, succession, generator | Complete one, run succession, start a second that references the first | |
| 9 | Co-op — groups, split party, drop-in/out | Two humans, split party, one drops out and the AI carries their intent | |
| 10 | Deploy — Vercel + Postgres | A local save loads identically from the deployment | |

**Carried forward, unbuilt:** fighter and rogue class features (Second Wind, Sneak Attack,
Cunning Action) — the `flags.features` scaffolding exists, the mechanics do not. Level-up
still offers average HP only, never a rolled hit die. Both are small and both belong in
phase 5 or 6.

---

# Part VI — what other games did, and what to take

Written as research rather than opinion: each entry is a game that solved a problem we
have, what it actually did, and whether to take it.

---

## 38. The reference shelf

### 38.1 Tabletop — where the good ideas come from first

| Game | What it does | Take? |
|---|---|---|
| **Blades in the Dark** | **Position & effect**: a roll is not just pass/fail against a DC, it is *how exposed you are* (controlled / risky / desperate) crossed with *how much you accomplish* (limited / standard / great). Also **progress clocks** — visible segmented circles that fill as a situation develops. Also **flashbacks**: spend a resource to retroactively declare you prepared for this. | **Clocks: core.** Position/effect: adapt, don't adopt (§39.2) |
| **Powered by the Apocalypse** (Apocalypse World, Dungeon World) | The **7–9 band**. Roll 10+ you succeed, 6− you fail, **7–9 you succeed at a cost**. This single band is why PbtA games feel alive: most rolls land in the middle and the middle is where stories happen. | **Core** — the 5e-compatible version is §39.1 |
| **Ironsworn** | Built *for solo play*. **Vows** are sworn oaths that become progress tracks; the campaign hangs off what your character personally wants. Oracle tables answer questions when no DM is present. | **Vows: core** (§39.5). Oracles: we have an LLM, that is our oracle |
| **Dungeon World** | **Bonds** — mechanical relationships between characters, written as sentences. **Fronts** — the world's threats advance on their own clock whether you engage or not. | Bonds ≈ our relationship edges (built). Fronts ≈ our ambient system (built) |
| **The Alexandrian's Three Clue Rule** | Any conclusion the players must reach needs **three** independent routes to it. Players will miss two. | **Core as an authoring constraint** (§39.6) |
| **DMG variant: Success at a Cost** | Official 5e sanction for the PbtA middle band: when a check fails by 1–2, the DM may grant success with a complication. | The rules cover we need for §39.1 |

### 38.2 Video games — where the presentation ideas come from

| Game | What it does | Take? |
|---|---|---|
| **Baldur's Gate 3** | **Universal actions** — Shove, Jump, Hide, Throw, Dip standardised onto the bar, always visible, greyed when unavailable. **Karmic dice** on by default. **Inspiration** earned by acting in line with your background, spent to reroll. The dice overlay that celebrates the roll. | Universal actions **suggested**; karmic **built**; Inspiration **core** (§39.3) |
| **Citizen Sleeper** | Rolls your whole dice pool **at the start of the cycle**, face-up, and you drag numbers into action slots. Dice are a visible, allocatable resource rather than an invisible calculation. Your dice degrade as your body fails. | Not directly — it is a different resolution system. But the *principle* (show the resource before the choice) is §39.3 |
| **Disco Elysium** | Skills are **internal voices** that argue with you. Every check shows its full modifier breakdown before you commit, down to "+1 because of the hat". **Failure is frequently more interesting than success** and the writing knows it. | Modifier breakdown **built** (roll card). Failure-as-content is §39.1. Skill voices: a phase-8 flourish |
| **Slay the Spire** | **Enemy intent** — every monster shows what it will do next turn, as an icon. Removes guesswork without removing difficulty. | **Core for phase 7** — already noted in §31.2, free because our CPU policy is deterministic |
| **Into the Breach** | **Perfect information.** You see exactly what will happen if you do nothing. The game is a puzzle, not a gamble. | Its purity does not fit d20, but "telegraph consequences" is the same instinct as enemy intent |
| **Wildermyth** | Characters age, retire, and **return in later campaigns as legends or antagonists**. Relationships and history persist across runs. | Direct precedent for our succession design (§28). Validation more than a new idea |
| **Darkest Dungeon** | A **narrator who comments on your choices** in a consistent voice. Resting has a real cost. | Our DM is this. The lesson is *consistency of voice* — one reason `narrate` should stay on one model within a campaign |
| **Hades** | NPCs comment on **what you just did**, from a large pool of contextual lines. Short loops, persistent progression. | Companion barks (§39.4) |

### 38.3 Interactive fiction — where the failures are instructive

| Game | What it does | Take? |
|---|---|---|
| **Hitchhiker's Guide** (1984) | Two-word parser. If you did not guess the verb the author typed in 1984, you hit a wall. Famous for the babel fish puzzle, which is cruel by design. | **The anti-pattern.** Our intent parser exists precisely so this cannot happen. Worth keeping as the negative reference |
| **The Hobbit** (1982) | NPCs acted **autonomously in pseudo-real-time**. Sit still and Gandalf wanders off. Genuinely ahead of its time. | Our ambient system (built). Validation |
| **Hadean Lands** | **`GO TO <known room>`** pathfinds you through explored geography instead of making you retype NORTH, EAST, NORTH. Also `RECALL` for known recipes. | **Core** (§39.7) — we already have the graph |
| **80 Days** | A **ticking clock** as the central tension, and choices as chips that never hide the prose | Clock built; chips are §39.4 |
| **Roadwarden / Sorcery!** | Peripheral UI anchors — mini-map, inventory, time — so a wall of prose never leaves you lost | §17 layout. Confirmed |

---

## 39. What to build, in order of value

### 39.1 Degrees of success — CORE

**The single biggest fun upgrade available**, and it is cheap.

5e as written is binary: you beat the DC or you do not. PbtA's insight is that the
interesting band is the middle, and the DMG's *Success at a Cost* variant gives us the rules
cover to have one without touching the d20 math.

```
total >= dc + 5      critical success   — you get more than you asked for
total >= dc          success
total >= dc - 2      SUCCESS AT A COST  — you get it, and something goes wrong
total <  dc - 2      failure            — and it must still change the situation (§35)
```

Add `degree` to `Roll`, computed in `rules/checks.ts`. The narrator receives it in the
mechanics block and is told what each band means. Nothing about authority changes: code
still decides, the model still only describes.

Why it matters: "you failed to pick the lock" is a dead end that makes the player type
something else. "The lock opens, but your pick snaps off in it and someone upstairs heard"
is a scene. Most rolls will land in the middle band, so most rolls become interesting.

**Not for attack rolls.** Combat stays clean hit/miss — 5e's attack math is load-bearing and
a "graze" band would quietly rewrite every monster's threat. Skill checks only.

### 39.2 Position and effect — ADAPT, do not adopt

Blades' position/effect is excellent and it is *a different game*. Grafting a second axis
onto every d20 check would be the kind of bastardising we said we would not do.

What to take instead is the **stakes preview**: before a risky check the affordance bar
already knows the DC and the modifiers, so it can say what a failure would cost. One line,
drawn from the location's `danger_level` and the action, shown on the chip. That is the
useful 80% of "position" without a second resolution system.

### 39.3 Inspiration — CORE

Straight 5e RAW, and it is the answer to "I rolled a 3 and now I feel bad".

- Earn a point when you act in line with your **personality trait, ideal, bond or flaw** —
  which we already store, and which the narrator is already reading.
- Spend it to **reroll after seeing the result**. Hold at most one (RAW), or a small party
  pool (BG3-style) if playtesting says one is too stingy.
- New effect `grant_inspiration` / `spend_inspiration`; new roll purpose with
  `attempt_index + 1`, which the committed-dice design already handles correctly.

This also fixes the karmic-dice tension honestly: a player who fails and wants another shot
has a *legitimate* mechanism, so reaching for rewind is a choice rather than the only option.

### 39.4 Suggested actions — CORE, and this is your idea, sharpened

Three or four chips beneath the prose. The distinction that makes it work:

| | Affordance bar | Suggestion chips |
|---|---|---|
| Answers | "What **can** I do?" | "What is **interesting** now?" |
| Source | Code, exhaustive | **Ranked by code, phrased by the narrator** |
| Count | Everything legal | 3–4 |
| Behaviour | Executes | **Fills the text box, does not submit** |

The ranking is the part that must be code, and it is a small scoring function:

```
+3  newly available this turn (an exit just revealed, an item just found)
+3  advances an active quest's current step
+2  a lead the player has but has not followed
+2  an NPC present has something they want to say (unfired on_first_talk)
+2  the player has not tried this verb yet this scene
+1  the character is good at it (their best skills)
-2  already done this scene
```

Take the top four, hand them to the narrator, and ask it to phrase each in the player's
voice — *"Ask Thorne about the ledger"*, not *"skill_check persuasion medium npc_thorne"*.
`Narration.suggested_actions` already exists on the contract and the CLI already prints
whatever the model invents; this replaces invention with ranking.

Chips fill the box rather than submitting because that is what teaches phrasing. Tap
"Ask Thorne about the ledger", see it appear in the box, edit it to "ask Thorne who he owes
money to" — and now the player knows they could have typed that.

### 39.5 A personal vow — CORE for phase 8, and the missing stake

The largest gap after onboarding, and no plan has named it: **the player has no personal
reason to care.** Arcs and quests are things the world wants. Ironsworn's answer is the
**vow**: at session zero the character swears something they personally want — find my
brother, pay the debt, burn the Hand to the ground — and it becomes a progress track that
the whole campaign hangs off.

Cheap given what exists: a vow is a `Quest` with `giver_entity_id: null`, a progress track
instead of discrete steps, and a place in session zero. The DM is told what it is and weaves
toward it. It turns "here are some quests" into "here is why you left home".

### 39.6 The three-clue rule — CORE as an authoring constraint

Any conclusion the player must reach needs **three independent routes**. They will miss two.
This is the difference between a mystery and a wall.

Enforceable in the content validator we already have: for each quest step, count the
distinct paths that can complete it (triggers, leads, facts that point at it). Warn under
three. That turns a design principle into a lint rule, which is where principles survive.

Especially important here because our DM *can* improvise a fourth route — but only if the
authored world gave it something to improvise from.

### 39.7 Go-to pathfinding — CORE for phase 7

Hadean Lands' fix. Tapping a discovered location on the map should walk you there through
the graph, spending the real travel time and rolling any encounters on the way, without
making the player retype "up, up, in".

Breadth-first over discovered locations only, emitting the sequence of `move_entity` and
`advance_time` effects as one journaled action. §16.2 already specified fast travel; this is
the same machinery with a pathfinder in front of it.

### 39.8 Items that grant verbs — SUGGESTED, strongly

Google's crowbar example, and it is good. An item in the pack should **inject affordances**
rather than waiting to be named:

- Crowbar → `Pry open the door (Athletics, advantage from the crowbar)`
- Rope → `Climb down (Athletics)` on any location flagged `climbable`
- Thieves' tools → `Pick the lock (Sleight of Hand)` on a locked exit
- Lantern → removes the dim-light penalty, and says so on the chip

This is the fix for the Hitchhiker's failure mode: the player never has to guess that the
game modelled their crowbar. Implementation is a `grants` array on `ItemDef` read by the
affordance engine.

### 39.9 Universal actions — SUGGESTED, with a rules caveat

Shove, Hide, Help, Throw, always on the bar, greyed with a reason. Good for teaching the
action economy by repetition.

**The caveat worth a decision:** BG3 makes Shove a *bonus* action, which is **not** 5e — in
the book it is an attack you give up. BG3 chose approachability over the rules and it
noticeably changes combat. Recommendation: **follow the book**, because "do not bastardise
D&D" was the explicit goal, and make the action economy visible enough (§23) that the
strictness reads as clarity rather than friction.

### 39.10 Scene structure — SUGGESTED, phase 7

`world.scene_id` exists and nothing reads it. A good DM varies rhythm: tension, release,
travel, downtime. Marking scene boundaries would let the client pace itself — a divider in
the feed, a digest written at the boundary, ambient beats only between scenes rather than
mid-conversation, and a natural place to offer a save.

---

## 40. Two things to decide

**Where suggestions come from when the model is unavailable.** The ranking is code, so the
chips still work with the mock DM — they just read as `Search here` rather than
*"Something behind the altar does not match the rest of the wall."* Acceptable, and it means
the feature degrades rather than disappears.

**How much Inspiration to grant.** RAW is one, held at a time, and it is stingy enough that
many tables forget it exists. BG3 gives four slots and refills them often. Recommendation:
start at RAW-plus-one (hold two), and let session-zero difficulty move it — `story` grants
three, `ironman` grants one.

---

# Part VII — the systems added since Part VI

Kept as a running changelog because the spec is the handoff. Everything here is built,
tested and gated unless marked otherwise.

**Status: 229 tests, 79 source files, ~12,400 lines. Replay byte-identical.**

---

## 41. Conversation — the largest system that was missing

`talk` used to be a single action that set a flag. But talking to someone is not an action,
it is a **state you are in**, and a D&D game where NPCs are lore-dispensers rather than
people is missing most of what makes a table worth sitting at.

### 41.1 Topics assemble themselves

The design decision worth defending: **topics are derived from state, never authored as a
tree.** A topic exists because a fact exists, or a lead points at someone, or this person
knows something you do not. An author writes facts and NPCs; the conversation assembles
itself, and it grows as the campaign does without anyone writing a branch.

| Source | Becomes |
|---|---|
| A fact they hold that you do not | *ask about the innkeeper's brother* |
| A quest they give, or a lead naming them | *ask about the missing caravan* |
| Anyone or anywhere you both know of | *ask about the Drowned Gate* |
| Themselves | always available, and how most conversations start |
| Being in a faction, or having a schedule | *ask what people are saying* |

Dialogue trees do not scale — every branch is written by hand and the combinatorics beat
you by the third act. This does the opposite: content authored for other reasons becomes
conversational surface for free.

### 41.2 Trust gates what is possible, not what is likely — SUPERSEDED by §48

> **This section is wrong, and §48 reverses it.** Kept in place because the argument
> against it is worth reading beside it: at a real table you can always reach for the dice.

**The most important rule in the system.** A man who does not trust you does not *fail a
Persuasion check* about his daughter — he changes the subject, and **no roll is offered**,
because none would help.

That distinction is the whole reason trust is worth earning. If every closed door were a
higher DC, trust would be a modifier; because some doors do not open to dice at all, it is
a relationship.

Closed topics are shown greyed with the reason, like every other unavailable thing (§23):
*"Thorne will not talk about that with you yet."*

### 41.3 They have an agenda too

`agendaOf()` hands the narrator what this person wants out of the conversation, drawn from
their goal, their flaw, and how they feel about you. A DM told only what an NPC *knows*
writes a vending machine; one told what they *want* writes a person.

### 41.4 Friction

Pressing the same subject raises friction. Past a limit they end the conversation. Walking
out of the room ends it too, because that is how it works everywhere else.

### 41.5 The DM is told what they are hiding — and told not to say it

The tempting fix for secrets is to withhold them from the prompt. That is wrong: **an NPC
changing the subject only reads as evasion if the writer knows what is being evaded.**

So the NPC block splits their knowledge in two:

```
Knows and would say: …
KNOWS BUT WILL NOT TELL YOU: Thorne owes the Ashen Hand a debt…
→ Deflect if asked. Let it show that there is something. Do not say it.
```

and the system prompt carries the rule directly: *knowing something is not permission to
say it.* The player's own CANON block never contains it either way.

---

## 42. Clarifying questions — asking is not a turn

Half of playing D&D is *"wait, what's in the room?"*, *"how badly hurt is it?"*, *"can I
reach him from here?"* — and none of that is an action. A player who has to spend a turn to
find out what their options are is playing a worse game, and this was the single biggest
thing the engine was getting wrong.

Questions now:

- **cost no time, spend no action, produce no event.** Nothing is journaled, the turn
  counter does not move, and a rewind cannot land inside one.
- **are answered from state, instantly, with no model call.** "Who is here" should not take
  four seconds.
- **are filtered by what the player could know.** The knowledge model already decides what
  an NPC knows; it decides what the player is told too.

Nine kinds: surroundings, who, reach, condition, know, carrying, doing, time, options.

**Wounds are described, not counted.** Enemies read as *bloodied* or *barely standing*; your
own party gives exact numbers, because you can see your friends. A DM does not say
"thirteen."

The classifier is deliberately conservative — *"look behind the altar"* stays an action.
Mistaking an action for a question is free; mistaking a question for an action silently
costs a turn.

---

## 43. Free text works in a fight

The gate had been refusing `look`, `talk` and `skill_check` in combat, which switched off
the one thing we can do that Baldur's Gate cannot, exactly where it matters most.

What genuinely cannot happen mid-fight is now a short list: **rest, shop, travel, stroll
out.** Everything else works:

- **An improvised skill check costs your action**, same as swinging. Kick the table, tumble
  past, shout them down.
- **Speaking is free.** A few words in a round, as at a table.
- **Grabbing something off the floor is free** — 5e's one object interaction.

### 43.1 The evaluator

`preview(state, action)` dry-runs anything: legality, what it spends, the odds, and the
consequences beyond the action itself — rolling nothing and changing nothing.

It asks **the real resolver** whether something is legal, so the preview can never disagree
with the outcome about what is allowed. There is no second rules engine, which is the only
way that guarantee holds.

```
kick the table into its legs
  ATHLETICS · YOUR ACTION                    45%
  d20 · str +0 · vs DC 15
  spends your action — you will not swing this turn
```

---

## 44. Corrections to earlier systems

### 44.1 `known_by` is the truth; `secret` is a separate axis

The two were conflated. `factsKnownToPc` returned every *non-secret* fact whether or not the
player had ever learned it — so an authored rumour held only by the scholar leaked into the
player's canon, and worse, could not be *learned from her*, because the engine already
thought it known.

Now `known_by` is the whole test. `secret` governs only two things: whether a fact spreads
by gossip, and whether someone will share it under social pressure.

### 44.2 Trust thresholds split

`willShareSecrets` required trust > −30 — the mere *absence* of distrust. That had
innkeepers confiding in anyone who had not yet wronged them.

- **`HOSTILE_FLOOR` (−30)** — below this they stop engaging at all.
- **`SECRET_TRUST` (+25)** — a secret has to be *earned*.

### 44.3 The roll card itemises its modifiers

The component called "the most important in the client" three times in this spec was
shipping `modifiers +6`. The reasons had always existed in the modifier layer; they never
reached the `Roll`. Now: `int +2 · expertise +4`, and situational modifiers carry their own
reason (`the light is poor −2`).

Found by building the preview, which is the argument for building previews.

### 44.4 Map visibility has three tiers

`discovered` gated everything, so a world an adventurer grew up in showed as three rooms.

- **`landmark`** — always drawn. Towns, keeps, the shrine everyone knows about.
- **`discoverable`** — absent until found. Dungeons, hideouts, the room behind the altar.

Then `known` / `seen` / `visited` layer on top. A landmark you have never walked is drawn
hollow; what you have not found is not drawn at all, so the map cannot leak the shape of
the world.

### 44.5 A dead narrator cost the whole turn

Step 5 of the turn — narration — was the one step that can fail for reasons outside the
engine, and an exception there threw away the already-resolved turn. Which is worse than it
sounds: the dice had *already rolled*, so retrying under `karmic` or `true` would roll a
**different number** for a check the player had watched resolve.

Now a provider failure returns the turn without prose, kind `mechanics_only`. The world
moved, the journal is written, the roll card stands in for the paragraph. This is the one
rule paying for itself: **prose is decoration, and losing it must never cost a turn.**

### 44.6 Inventory importance

Items carry `quest` / `magic` / `valuable` / `mundane`, so a quest item is not lost between
a rope and a torch.

---

## 45. The serving contract — `src/server/contract.ts`

No HTTP server: that is implementation and it wants a test loop. What is specified is the
part that is expensive to get wrong on paper.

### 45.1 Mechanics first, prose streamed

The dice resolve in microseconds; the narration takes seconds. A player should never wait
on the narrator to learn whether they hit. One POST returns a stream:

```
intent    → what the parser understood
mechanics → the roll card, BEFORE a word is written    ← this is the frame that matters
state     → bars and pips move
prose     → …streaming…
done      → chips, version, rejects
```

### 45.2 Optimistic concurrency on the journal

Event sourcing already gives a version for free: **the journal's length.** Two tabs at
version 40 both submit; the first commits at 41 and the second is refused with
`version_conflict` carrying 41.

Refused, not merged — two interleaved turns is a corrupted world and there is no correct
automatic resolution. The client re-fetches, shows the player what happened, and lets them
decide.

### 45.3 The server owns state

The client holds view models, never `GameState`. It cannot compute an outcome, so it cannot
disagree with one — the same reason the narrator does not hold state.

### 45.4 Cost accounting

Tokens are the one resource a runaway loop spends without anyone noticing until the bill.
Every call records to a ledger; a save past its ceiling stops calling the narrator and falls
back to mechanics-only turns rather than silently costing money. Plus a turn timeout and a
turns-per-minute ceiling.

### 45.5 Migration policy

Saves outlive schemas, and event sourcing makes this unusually cheap: **a save that cannot
be migrated in place can be rebuilt by replaying its journal.** Added fields get a Zod
default and old saves just load. A migration that cannot be expressed as a replay is a
design smell — it means state drifted out of the journal.

---

## 46. Still open — and who should take it — SUPERSEDED by §54

### 46.1 Worth building before the client

| | Why |
|---|---|
| **Companions do not speak** | Approval tables carry a `line` per rule; the `companion` model role is configured and unwired. Highest value per line of code in the whole list |
| **Inspiration has no spend verb** | The effect exists; nothing offers "reroll that" |
| **Recruitment is data-only** | `recruitable` and `recruit_condition` are on Garret; no action joins anyone |
| **Shops have no stock** | `stockOf` reads `cont_<merchant_id>`; no campaign creates one |

### 46.2 For the client (Fable)

Everything in §17 and §33, plus two additions from this round:

- **Speaker portraits.** Sprites for whoever is talking, above the dialogue. The data is
  there — `sceneModel.present` and `conversationModel.with` both carry name, descriptor and
  disposition. A portrait per NPC plus a disposition tint would do most of the work, and it
  is the cheapest way to make a wall of prose feel like a conversation. **Worth deciding
  early**, because it changes how much vertical space the feed gets on a phone.
- **The conversation panel.** `screen().conversation` gives who, their disposition, every
  topic with its open/closed state and reason, and the friction. Closed topics shown greyed
  with the reason is the same pattern as the action bar, and it teaches the same lesson:
  trust is a thing you spend actions on.

### 46.3 Deliberately not built

- **NPC-to-NPC relationships driving offscreen drama.** The graph supports it; nothing
  reads it. A real feature, and a large one — better after the client exists to show it.
- **Reputation preceding you into a new town.** Faction rep exists; settlement rep exists;
  nothing propagates between them on arrival.
- **Conversations with more than one person at once.** A crowd is a different system.

---

## 47. What Fable can figure out alone, and what it should not have to

Worth stating, because the split is not obvious.

**Safe to leave to a test loop:** the client's components, the Postgres adapter (there is an
interface and tests), balance tuning, the generator's stage loop, deployment scripts. All of
these have a passing test or a rendering check at the end.

**Should not be re-derived:** anything where a wrong guess is expensive to undo —

- *What a turn is over a network* (§45.1). Getting this wrong means the client waits on the
  narrator to learn whether it hit, and that is a rewrite, not a tweak.
- *Concurrency semantics* (§45.2). "Merge two turns" is a plausible-sounding idea that
  corrupts worlds quietly.
- *Where authority lives.* Every temptation to let the narrator emit a number, a DC, or a
  topic id is a temptation to undo the thing that makes this work.
- *Trust gating what is possible rather than what is likely* (§41.2). A reasonable engineer
  would implement closed topics as a higher DC, and the game would be worse in a way that is
  hard to name afterwards.

The rule of thumb: **if it has a passing test at the end, it is a loop; if it is judged by
reading, it wants one coherent pass.**

---

# Part VIII — the four gaps, and a design walked back

**Status: 245 tests, 82 source files. Replay byte-identical.**

Part VII §46.3 listed four things as deliberately not built. They are built now. One of
them turned out to require reversing a decision Part VII had defended at length, which is
recorded here rather than quietly edited out of §41.

---

## 48. Trust was gating the wrong thing

§41.2 said, with some confidence, that **trust gates what is *possible*, not what is
*likely*** — that a man who does not trust you offers no roll at all, because none would
help. The reasoning was that if every closed door opens to a good enough roll, trust is
just a modifier.

That is wrong, and the counter-argument is the stronger one: **at a real table the d20 is
always available.** You can always try. What the DM controls is what trying costs and what
it might get you — not whether you are permitted to reach for the dice. A game that answers
*"you may not roll"* where a DM would say *"make it a 17"* is the worse game, and it is
worse in the specific way this project exists to avoid: it refuses to engage.

Access is now three levels, and only the third is a wall.

| | What it means | When |
|---|---|---|
| **open** | They just tell you. No roll. | Friends, and anything ordinary |
| **guarded** | A check, at a DC their trust moved | Almost everything else |
| **sealed** | No total buys it — **but it names its key** | Rare, and authored |

### 48.1 Trust is a DC, and it says so by name

`trustDcShift` is capped at ±6 — deliberately stronger than affinity's ±3, because **liking
you colours a conversation and trusting you decides one.** It is expressed as a DC delta
rather than a bonus to the roll, which is the honest place for it: what changed is the
difficulty of the ask, not the character's silver tongue. It reaches the roll card by name:

```
ask about the ledger
  PERSUASION                                       40%
  d20 · cha +1 · vs DC 17
  he barely knows you +3 · too many ears for a clean lie +2
```

The cap matters in both directions. A stranger can still be talked round on a good roll; a
friend can still refuse on a bad one. Neither outcome is ever foreclosed by a number.

### 48.2 A seal must name its key

Some things really are not for sale at any total — a man will not name the people he owes
money to because you rolled well. But **a closed door that says only "no" is a wall, and a
closed door that says "not until his brother is out of the Ashen Hand's book" is a quest
hook.** Only the second kind is allowed, and the schema enforces it: `Fact.seal` cannot
exist without a non-empty `opens_when`. You cannot author a refusal without authoring the
thing that lifts it.

### 48.3 Rolling at a sealed door is never wasted

The rule that makes the whole design hold together:

> **A critical at a sealed topic does not open it. It gets you the key.**

They let something show — and what shows is what *would* open it. Mechanically the player
gets a lead rather than the fact. That is frequently the more interesting outcome, it is
what a good DM improvises anyway, and it means **the die is never dead**: a 20 always does
something, it just does not always do the thing you pointed it at. Which is also true at a
table.

---

## 49. Four bands, re-cut

The bands were right in shape and wrong in width. `success_at_cost` covered a *two-point*
near-miss, which is 10% of the range — a middle band that thin makes a pass/fail game
wearing four labels.

| Roll vs DC | Band | What the narrator must do |
|---|---|---|
| **miss by 5+** | FAILURE | It failed, and the situation got worse. Never "nothing happens" |
| **miss by 1–4** | SUCCESS AT A COST | They get it, *and* something goes wrong |
| **meet, to +4** | SUCCESS | Clean |
| **beat by 5+** | CRITICAL | More than they asked for |

Four points wide, so the near-miss band is where most rolls land — which is the PbtA insight
and the reason the middle of the range is worth having at all.

**Difficulty owns the width**, which is the best use the levers have found yet:

| | `story` | `normal` | `hard` | `ironman` |
|---|---|---|---|---|
| near-miss band | 6 | 4 | 2 | **0** |

At `ironman` the band closes entirely and every check is a clean pass or fail. That is what
those players ask for, and what everyone else would find joyless.

### 49.1 A natural 20 moves one band — a deliberate break from RAW

5e grants nothing for a natural 20 on an ability check. We grant one band, in both
directions: **a 20 upgrades, a 1 downgrades.**

This is the same principle as §48.3, and the reason is the same: a d20 should never be dead.
Rolling a 20 against a wall you cannot climb should still buy the best outcome available —
*you get up there, and now you are stuck* rather than *no*. Because it moves exactly **one**
step, it cannot manufacture a clean success out of a hopeless total. A 20 on a −5 against
DC 25 is still a failure; a 20 on a near-miss is a success at a cost.

---

## 50. The rest of the room

A conversation is one-to-one — which is what a tabletop and Baldur's Gate 3 both actually
do, for the same reason: five people answering at once is unreadable as prose and unplayable
on a phone. What neither of them does is let the other four stand there like furniture.

**They interject.** One speaker, everyone else can put an oar in.

An interjection is **never mechanical**. It changes no state and rolls no dice. It is a
narration cue: code decides who has *standing* to speak and what it is about, the DM writes
the line. Four causes, ranked:

| Cause | They speak because |
|---|---|
| `implicated` | They, or their faction, are the subject |
| `knows_better` | They know something bearing on it that you do not |
| `protective` | They are fond of whoever is being pressed |
| `strong_feeling` | They love or hate you enough to weigh in |

Capped at two. A room should not chorus.

### 50.1 A crowd is one thing, not fifteen things

The wrong way to build a busy tavern is fifteen entities with fifteen relationship edges.
The right way is what a DM does: **name the two or three who matter and treat the rest as a
single body with a single mood.** The crowd is not an entity — no HP, no inventory, no
opinions of its own. It is a reading of the room, derived on demand from who is in it and
how the town feels about you.

The DM is told explicitly: *treat them as ONE presence — a murmur, a turned head — never as
separate speakers.*

### 50.2 Doing it in public costs something

The cheapest way to make a room matter, and it uses machinery that already existed:

- **Intimidation is harder in front of an audience** (+2, +4 in a crowd) — nobody folds
  where their neighbours can see them fold. The most intuitive rule in the file.
- **Deception is harder** (+2/+3) — every extra ear is another chance someone knows better.
- **Persuasion barely moves** (+1 in a crowd).

Each arrives as a named modifier with its reason, so it lands on the roll card in the
player's own terms rather than as an invisible thumb on the scale. Two people alone in a
room is a conversation, not an audience, and gets nothing.

---

## 51. Reputation arrives before you do

Faction reputation existed. Settlement reputation existed. **Neither reached the other**, so
a party could burn the Ashen Hand's warehouse, ride two days to the next town where the Hand
collects tolls, and be met with a shrug. Consequence stopped at the town line, which is the
opposite of the promise this engine makes.

When you meet someone for the first time they now start where their faction's books, their
town's general feeling, and your notoriety put them — not at zero.

Two rules keep it honest:

1. **It applies once, on first meeting.** After that the relationship is the record of what
   you two actually did, and reputation never overwrites lived experience. A man who has
   learned to like you does not un-like you because a faction number moved.
2. **Hearsay is capped at ±35.** It never moves someone as far as meeting you does.

A faction member gets *half* the faction's standing — a footsoldier of an order you crossed
dislikes you; he does not hate you the way the order's ledger does.

One deliberate limitation: the ledger does not record whether a deed was *admirable*, and
code must not guess. So notoriety raises fear, never affection — whether being known is good
for you is a judgement, and judgements belong in authored data.

---

## 52. Scenes, so the story has chapters

`world.scene_id` had existed since phase 0 and exactly one rule read it. Nothing ever
advanced it, so every campaign was one scene four hundred turns long.

That is a pacing bug, and pacing is most of what separates a good DM from a competent one.
The engine cannot write rhythm, but it can mark where the beats fall — and a great deal
falls out of the boundaries for free: a divider in the feed, the only cheap place to write a
digest, ambient beats *between* scenes rather than mid-conversation, the honest place to
offer a save, and "once per scene" becoming a real budget.

A scene ends on: **arriving somewhere meaningfully else, a fight finishing, a long rest, or
six hours passing.** Two guards keep it from chopping the story into confetti:

- **Room to room is not a scene change.** The unit is the settlement, or the region outside
  one. Otherwise you get a divider every time someone opens a door.
- **A scene shorter than three turns cannot end.**

A boundary is decided by code, never the narrator — a model asked *"did a scene just end?"*
says yes far too often, because yes is more interesting. And it is written as a
`scene_break` **event**, not a quiet mutation, so it is journaled, rewindable, and visible in
the cascade inspector like everything else.

---

## 53. People act on how they feel about each other

The relationship graph has always been directed and many-to-many — Mira can distrust Thorne
without Thorne knowing it — and until now **precisely nothing read the edges that did not
involve the player.** Every NPC's inner life ran exclusively through you, and a world where
nobody has a quarrel you are not part of has one real person in it.

Two things now happen offscreen, both derived from edges an author already wrote:

- **Malice.** Someone who despises another and knows something damaging passes it on. The
  listener's opinion of the subject shifts, with the reason recorded — *"what Garret said
  about them"*.
- **Loyalty.** Someone devoted to another goes to them when they are hurt.

Bounded at **two per tick** and a 25% chance per day per edge — a world, not a soap opera.
The player hears about either only if they could plausibly have heard, through the same
witness rules as everything else.

---

## 54. What is left — SUPERSEDED by Part IX

The four from §46.3 are done. What remains unbuilt is unchanged and small:

- **Companions do not speak.** Still the highest value per line of code in the project.
- **Inspiration has no spend verb.**
- **Recruitment is data-only.**
- **Shops have no stock.**

And the client, which is all of phase 7 and the reason the view models exist.

---

# Part IX — the last four, and the infrastructure

**Status: 257 tests, 84 source files. Replay byte-identical.**

The four gaps listed in §54 are closed, and the project has the plumbing a second person
would need to run it. Nothing in this part changes a design decision; it finishes ones
already made.

---

## 55. Companions speak

Listed three separate times as *"the highest value per line of code in the project"*, and
left undone each time. Approval rules carried an authored `line` per situation, reactions
fired on every witnessed event, attitudes moved — and none of it ever reached the player,
who found out by opening a menu. **A companion who never speaks is a stat block with a
name.**

A reaction big enough to be `vocal` now emits a `dialogue` event carrying the authored line.

The split is the usual one, and it matters here more than usual:

- **The reaction is truth** — it happens in the reducer, deterministically, from authored
  data. It works with the mock DM, offline, at zero cost, and it replays exactly.
- **The voice is decoration** — the narrator is separately handed *who reacted, which way,
  and to what*, so it can put the same beat in that character's register instead of the
  author's fallback quip. It may rephrase. It may not change whether they approved.

Which way a reaction leans is computed (`signOf`) and handed over explicitly, because a
model given a bare line and no valence will eventually write an approving remark as a
rebuke.

---

## 56. Inspiration is spent — for advantage, not a reroll

RAW spends Inspiration to **reroll** a d20 after seeing it, and every earlier draft of this
spec said so. It is spent **before** the roll here, for advantage. Two reasons, both
specific to this being a text game rather than a table:

**1. It fits the one UX thesis.** Everything else in this game shows you the odds before you
commit — the evaluator prices what you typed, the affordance bar shows a hit chance. A
post-hoc reroll is a mechanic for a game that *hides* the odds until you have rolled.
Advantage is the version you can price: **45% → 70%, on the card, before you spend
anything.** The decision gets better information rather than less.

**2. A post-hoc reroll is a rewind wearing a hat.** Dice roll during resolution and are
baked into the event, so undoing one means rewinding the turn and re-resolving it. That
machinery exists and is called rewind. Quietly building a second one under a nicer name
would make the honest feature look like the cheat and the cheat look like a rule.

The gamble survives: you spend a finite resource and advantage can still miss.

---

## 57. Recruitment, and the one place trust really is a gate

`recruitable` and `recruit_condition` were authored on an NPC and no action read them.
There is now a `recruit` verb. Three things stand between asking and a yes:

| Gate | Why |
|---|---|
| `recruitable` | Not everyone is a candidate |
| `recruit_condition` — an authored flag | **The author decides what earning someone looks like.** A favour, a secret, a debt settled. Code must never guess at what would persuade a person |
| `RECRUIT_TRUST` (35) | They have to actually trust you |

That last one is the deliberate exception to §48. Everything else in a conversation became a
DC — but **no roll talks somebody into risking their life beside you.** That is a
relationship; you either built it or you did not. It earns the exception precisely because
it is the only one.

Joining makes them a `companion` in fact, not just a name in a list: approval rules, morale
and the party panel all key off `kind`. Party is capped at four including the player.

---

## 58. Shops have stock

`stockOf` read a container that no campaign created, so every merchant was an empty shelf.
The inn now holds real item *instances* — two healing draughts, a rope, a lantern, a
crowbar. Buying the last rope means **there is no rope**, which is the whole point of
modelling stock rather than offering a menu. Prices already moved with how the merchant
feels about you; now there is something to buy.

---

## 59. Infrastructure

The engine ran; the *project* was missing the parts a second person needs.

- **`.env` loads automatically.** Every CLI script runs through
  `node --env-file-if-exists=.env`. Without this, using a live provider meant exporting keys
  by hand in every shell — friction enough that nobody ever tries the real thing.
- **`.env.example`**, committed, explaining that no keys is a *supported* mode rather than a
  broken one: MockLLM is deterministic, offline, free, and what the whole suite runs on.
- **`.gitignore`** covers `.env` and saves.
- **`npm run check`** — typecheck plus tests, one command.
- **CI** (`.github/workflows/ci.yml`) runs typecheck, the suite, and — the one that matters —
  **the byte-identical replay check**. If a change takes determinism out of the reducer,
  that job is what catches it and nothing else will.

`config/models.json` still ships `REPLACE_ME` for every model id, deliberately: free tiers
and model names move faster than code does. The factory detects it and falls back to the
mock with an explanatory message rather than sending the string `REPLACE_ME` to an API.

### 59.1 Not done, and it is not mine to do

**The project is not under version control.** There is a `.gitignore` and no `.git`. Every
byte of this work is one bad `rm` from gone, and there is no bisect, no blame, no branch,
and no way to see what a change did. It is the single largest remaining risk to the project
and it is thirty seconds of work — but committing is the author's call, not the scaffolder's.

---

# Part X — where you came from

**Status: 265 tests, 85 source files. Replay byte-identical.**

Backgrounds existed as a bundle of proficiencies and a starting purse — all 5e strictly asks
of them, and all they were doing here. But *"I grew up a thief"* or *"I was born to a great
house"* is not a skill list. It is the first thing anyone in the world learns about you, and
at a table it changes every room you walk into.

Two mechanisms, deliberately different in kind.

---

## 60. Standing — what your past does *to* you

People react before you have spoken, keyed off **what sort of person they are**. A noble is
welcome in a hall and resented in a tenement; an outlaw is the reverse, and both are right.

NPCs carry **social tags** from a closed vocabulary short enough to hold in your head:
`criminal`, `lawful`, `commoner`, `noble`, `clergy`, `scholar`, `soldier`, `wild`,
`merchant`. Each background has a table saying how each sort reads it.

| Criminal meets… | Reaction |
|---|---|
| a fence | **+12 trust** — *they can tell you have done time in the same trade* |
| a guard | **−12 trust** — *you carry yourself like someone with something to hide* |
| a merchant | **−6 trust, +6 fear** — *they are counting their stock while you talk* |

This feeds the arrival system from §51, so it lands the same way faction and town reputation
do: **once, on first meeting, capped, and always with its reason attached.** What you did
with someone afterwards always outranks how they first read you.

**Untagged NPCs stay neutral.** Backgrounds are opt-in for an author — tag the people whose
reaction is interesting and leave the rest alone.

---

## 61. Insight — what your past lets you *do*

The other half, and the more interesting one. A line only you have standing to say, in the
bracketed style the genre already taught everyone:

```
[CRIMINAL] speak the cant
[NOBLE]    pull rank
[OUTLANDER] talk about the country
```

An insight is **not a better Persuasion check.** It is a door that exists for you and does
not exist for anyone else at the table. An outlaw talking to a fence has something to work
with that a paladin simply does not, and that asymmetry is the entire point of asking where
somebody came from.

### 61.1 It pays out through the ordinary path

What an insight buys is **trust** — which then moves every DC in the conversation through
the normal machinery (§48). No special-case bonus that only backgrounds get. You have not
been handed the answer; you have established that you are worth talking to.

### 61.2 Some of them cost

`pull rank` on a farmhand works — **+10 trust, −12 affinity.** He will do what you ask and
he will not forget that you made him. A background that is pure upside is a stat bonus with
a costume on.

### 61.3 Once per person

Spent via a relationship tag. The moment of recognition is the point; one you can repeat is
a button, not a beat.

### 61.4 The DM is told the intent, never the mechanic

A background line only reads as *earned* if the narrator knows what the player is actually
doing. So the prompt carries intent rather than a label:

> If they play "speak the cant" — *Use the trade's own idiom to establish you are one of
> them, without saying so outright.*

Plus what this NPC reads as socially. The words stay the model's; the standing to say them
is code's.

---

## 62. The catalogue

Eight backgrounds, each with mechanics *and* a social reading — the three the design brief
named explicitly, plus five that fill out the space:

| | Grew up… |
|---|---|
| **Criminal** | light-fingered. Knows which doors are watched and who to pay |
| **Noble** | to a great house. Doors open, and so do resentments |
| **Outlander** | outside the walls. Towns are the strange country, not the wild |
| **Urchin** | in the gutters of a city. Knows every way in and out |
| **Acolyte** | in a temple. The words come without thinking |
| **Sage** | reading. Most rooms find it useless, a few find it priceless |
| **Soldier** | serving. Knows what an order costs whoever carries it |
| **Folk Hero** | ordinary, then did something. They have not forgotten |

A test asserts **every playable background has a social profile**, so adding one to the SRD
table without giving it a social reading fails the suite rather than shipping a background
that nobody in the world reacts to.

---

## 63. What this is waiting on

The tables are written against a world that does not exist yet. Every reaction row and every
insight is a claim about a setting — *"they place your family before you finish your name"*
assumes a place with houses and a memory of them.

Fable should expect to **rewrite these rows for the world it builds**, not treat them as
fixed rules. What should survive is the shape: standing is authored on both sides and matched
by code, an insight pays out in trust rather than in a special bonus, and the DM is handed an
intent rather than a mechanic.

---

# Part XI — classes, and features that do something

**Status: 285 tests, 87 source files. Replay byte-identical.**

Two things closed the character system, and one of them turned out to be a prerequisite for
the other.

---

## 64. A class feature was a string

`features: { 1: ["Second Wind"] }` — enough to print on a sheet, and enough to fool a
reader of this repo into thinking fighters could catch their breath. They could not. The
engine supported two classes and **neither one's signature ability did anything.**

The fix follows the trigger DSL's shape for the trigger DSL's reason: **a closed tagged
union of mechanical shapes, evaluated by code, authored as data.** A new class becomes a
data entry rather than a new branch in the combat resolver — which is the only thing that
makes ten classes tractable.

| Shape | Implements | Handled in |
|---|---|---|
| `heal_self` | Second Wind | `turn.ts` |
| `heal_pool` | Lay on Hands | `turn.ts` |
| `extra_action` | Action Surge | `turn.ts` + `grant_action` |
| `bonus_action_unlocks` | Cunning Action | `combatActions.ts` |
| `sneak_damage` | Sneak Attack | `combatActions.ts` |
| `rage` | Rage | `combatActions.ts` + `effects.ts` |
| `half_proficiency` | Jack of All Trades | `checks.ts` |
| `inspiration_die` | Bardic Inspiration | `turn.ts` |
| `extra_attack` | Extra Attack | `turn.ts` |
| `narrative` | **nothing, and says so** | — |

That last row is the honest half. A feature marked `narrative` is **not secretly working**.
It reaches the DM in the prompt and the player on their sheet, it changes no number, and it
is discoverable by reading the data rather than by noticing an absence in a combat log.

### 64.1 Three that were worth getting exactly right

**Sneak Attack** needs a finesse or ranged weapon, once per *turn*, and either advantage
**or an ally beside the target while you lack disadvantage**. That second clause is the one
that gets dropped, and it is the one that makes a rogue want a friend in the fight. In
zone-based combat "beside" means *in the target's zone*. The once-per-turn gate resets in
`next_turn`, not on a rest — missing that is how a rogue quietly triples their damage.

**Cunning Action** declares which actions move to the bonus pip rather than being special-
cased in three places. The affordance bar reads the declaration too, so the rogue's Dash
shows as **bonus · Cunning Action** instead of silently costing something different from
what the bar says.

**Extra Attack** resolves both swings in **one action and one event**. A player who has to
press attack twice for one action has been taught the economy wrong. A target that drops on
the first swing stops the sequence.

### 64.2 Passives are not buttons

Sneak Attack, Extra Attack and Jack of All Trades are not offered on the bar and are refused
as verbs. Putting them there would teach the player to hunt for a button that does not
exist. Only things you *activate* appear — and a spent one stays visible, greyed, with what
brings it back.

---

## 65. Rolled hit points

`levelUpPlan` had always accepted a rolled die and nothing ever passed one, because there
was no level-up **action** — levelling existed only as an effect the tests called directly.
There is one now: it rolls the class hit die at resolution, bakes it onto the event, and
shows it on the roll card. Committed dice make it exploit-proof for free, since rewinding
and levelling again gives back the same die.

---

## 66. Ten classes

| | Hit die | Caster | Signature, and whether it works |
|---|---|---|---|
| **Fighter** | d10 | — | Second Wind ✓ · Action Surge ✓ · Extra Attack ✓ |
| **Rogue** | d8 | — | Sneak Attack ✓ · Cunning Action ✓ |
| **Barbarian** | d12 | — | Rage ✓ (damage *and* resistance) |
| **Paladin** | d10 | half | Lay on Hands ✓ · Divine Smite — declared, not yet wired |
| **Ranger** | d10 | half | Extra Attack ✓ · Natural Explorer *narrative* |
| **Bard** | d8 | full | Bardic Inspiration ✓ · Jack of All Trades ✓ |
| **Cleric** | d8 | full | Channel Divinity *narrative* |
| **Wizard** | d6 | full | Arcane Recovery — declared, not yet wired |
| **Druid** | d8 | full | Wild Shape *narrative* — see below |
| **Warlock** | d8 | **pact** | Pact Magic *narrative* — see below |

Two are deliberately left as `narrative` rather than half-built:

- **Wild Shape.** Becoming a different stat block is its own system — a second entity that
  the reducer swaps in, with its own HP pool that the druid falls back out of. It touches
  damage, death saves, inventory and initiative. It deserves a design pass, not a flag.
- **Pact Magic.** Warlock slots are few, always at maximum level, and recharge on a **short**
  rest — a different recharge rule threaded through the slot system. `caster: "pact"` is
  recorded on the class so nothing has to guess later, and the rest resolver does not yet
  read it.

A test asserts every mechanical feature validates against the schema, so a malformed entry
fails the suite rather than being silently skipped at runtime.

---

## 67. For Fable

Adding a class should now be **data only**. If it needs a new branch in a resolver, that is
the signal a new shape belongs in the union — add the shape, name where it is handled, and
the next three classes get it free.

The two deferred systems above are real design work, not gaps to be filled in passing.
Wild Shape in particular should not be attempted as "swap the stat block and hope"; it needs
a decision about what happens to concentration, inventory and death while transformed.

---

# Part XII — serving, generating, and two determinism bugs

**Status: 348 tests, 91 source files. Replay byte-identical.**

Phase 8 is complete. What was written in this part: the serving layer the contract described,
streaming narration, the generator loop, the succession CLI — and two determinism bugs the
last two of those flushed out.

---

## 68. The narrator streams, and prose is the only thing that waits

The contract (§45.1) said mechanics go out before a word is written. The implementation
needed the model to hand prose over as it arrives, and it needed to do that **without giving
up whole-document validation** — the moment a client acts on a half-parsed answer, the model
is holding state again.

The answer is a tap on one field. `narration` is the first key in the schema, so a small
reader watches the raw stream, finds that string, and decodes its characters as they land.
Everything else — facts, proposals, chips — arrives whole and is validated whole, exactly as
before. One call, no extra cost, and a `stream()` that resolves to precisely what `complete()`
would have returned.

That equivalence is load-bearing: the streaming path and the non-streaming path share the
replay tests, so there is nothing for them to disagree about. A provider that ignores
`stream: true` degrades to one `onText` at the end and nobody notices but the clock.

---

## 69. The service, and the three things it owns

`GameService` implements the contract free of any HTTP framework, so a test drives it as
easily as a socket does. It owns three things the engine deliberately does not:

**The lock.** One turn at a time per save. Two tabs, or one device that double-tapped: the
second waits, finds the version moved, and is refused. Different saves proceed in parallel.

**The version.** The journal's length, which was already the truth and is now also the API's.

**The order.** Mechanics are committed to disk *and sent* before the narrator is called. The
test for this does not race the clock — it kills the narrator outright and checks the world
moved anyway.

Around those: a transcript (`feed.jsonl`, which is **not** the journal — the journal replays
the world, the feed remembers the conversation), a cost ledger with a ceiling that falls back
to mechanics-only turns rather than quietly spending money, and a per-save turn-rate guard.

`src/server/http.ts` is plain `node:http`. Nine routes and one stream do not need a
dependency, and a dependency there would be the first thing to rot. A version conflict is a
**409 before the stream opens**, so a client handles it with its ordinary error path instead
of a stream that ends after one frame.

### 69.1 A save is content plus three decisions

Which campaign, which session-zero agreement, and who the player is. Those decisions are
recorded once in `creation.json` and replayed by `applyCreation` — because the journal
replays *from the starting world*, and a save whose starting world cannot be reconstructed
cannot be rebuilt. `rebuild` and `/rewind` both go through the same function as creation:
one transformation, two callers, nothing to disagree about.

---

## 70. The generator loop

`generate.ts` had the stages, prompts, schemas and lint. This is the thing that runs them,
and the staging is the point: each stage sees the **frozen** output of the last as text it
cannot edit, so a later stage can only add. Ask for a whole campaign in one call and the
third quest references a town the second never built.

Two rules the loop enforces:

- **Nothing is written until validation passes.** A half-written campaign directory is worse
  than none, because it looks loadable.
- **A wrong reference is an error, not something to repair.** An earlier draft quietly moved
  a player standing in a nonexistent room to the nearest real one. That hides the exact class
  of failure the staged pipeline exists to surface, so it now only fills in a *blank*.

Generated output is ordinary authored JSON in the same layout `loadCampaign` reads. The test
generates a campaign from a scripted author and then **plays it** — moves between its rooms,
renders its screen — because "it validates" and "it is a game" are different claims.

---

## 71. Succession, and the gate earning its keep

`planSuccession` was pure and tested since phase 8; `npm run succeed` runs it. One plan, one
journaled event, and a snapshot taken first so it is undoable.

The first version of that CLI wrote the legacy ledger, the campaign's status, the arcs and
the promoted seeds **beside the journal**. It worked. It also failed `npm run rebuild` within
a minute, which is exactly what that gate is for — everything a succession changes is now an
effect (`add_legacy`, `set_campaign_status`, `set_arc_status`, `promote_seed`), so a
generation-skip replays and rewinds like any other turn.

---

## 72. Two bugs worth naming

**`known_by: []` meant "the player knows it".** The `add_fact` effect fell back to the PC
when the list was empty, which made a fact *nobody* knows impossible to write — and that is
precisely what a succession seed is. A thread the next party already knows about is not a
hook, it is a briefing. Every caller already passed `known_by` explicitly and no authored
content relied on the fallback, so the field is now taken literally.

**Clocks fired in object order.** `advance_time` iterated `Object.values(s.clocks)`.
Authored content lists clocks in the order somebody wrote them; a save writes them
key-sorted. When one tick finishes *two* clocks, their consequences fire in a different
sequence on replay than they did live — which renumbers every fact minted afterwards and
fails the rebuild gate.

Four hundred ordinary turns never found it. A twelve-year time skip found it immediately,
which is the argument for having a feature that moves the clock further than gameplay ever
does.

---

## 73. What is left

**Phase 7, the client.** Every view model, the whole API, and a static-file server that
serves `web/dist` are waiting for it. That is the only substantial piece of the original
roadmap still unbuilt.

Beyond it: phases 9 (co-op) and 10 (deploy), both outside the "through phase 8" scope, and
the three small carried-forward items in §54 — Wild Shape, Pact Magic's short-rest slots, and
the split-party loop.
