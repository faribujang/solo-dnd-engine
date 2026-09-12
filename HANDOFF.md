# Handoff — what is built, and what is yours

Written for the next builder. Phases 0–8 have their **design-coherent half** done: schemas,
rules, engine, view models, content, and gates. What remains is the half that wants an
iterate-until-green loop — rendering, tuning, and deployment.

**State:** 265 tests, typecheck clean, both demos replaying byte-identically.
`SPEC.md` is the full specification; this is the map of what to pick up.

---

## The one rule, still

> **Code owns truth. The LLM owns voice.**

Nothing below relaxes it. If a change would let the narrator write a number, it is the
wrong change — there is almost always a version where code decides and the model describes.

The test at the end of every phase is the same: **if the model vanished, would the save
still be a complete, correct, playable world?**

---

## What is built

### Rules (`src/rules/`)

| Module | What it owns |
|---|---|
| `rng` | Three dice modes: `karmic` (default, streak-breaker), `true`, `committed`. `seedFor` for committed, `freshNonce` for the others |
| `dice` | d20 with advantage and karma, damage with crit doubling |
| `checks` | Band→DC, skill/save modifiers, **`degreeOf`** — four bands, including success-at-a-cost |
| `modifiers` | Situational modifiers, each with a *reason* string. This is what the roll card renders |
| `equipment` | **AC is computed, never stored.** `computeAC` returns its parts |
| `character` | Creation from the SRD subset, `levelUpPlan` |
| `progression` | XP thresholds, awards. Non-violent resolution pays the same as killing |
| `conditions` | The full SRD list, each with real mechanical flags |
| `social` | Disposition, DC shifts, **`trustDcShift`** (±6 — trust decides where affinity only colours), prices |
| `reputation` | What they heard about you before you arrived. Applies once, capped at ±35 |
| `backgrounds` | **Where you came from.** Standing (how each sort of person reads your past) and insights (lines only you can say). SPEC Part X |
| `approval` | **Per-companion reaction tables.** `situationsIn` reads events; the table is authored |
| `inspiration` | Earn by playing your character, spend to reroll |
| `difficulty` | Real levers: DC shift, karma strength, inspiration cap, death options, encounter budget |
| `economy` | Prices, haggling, real shop stock |
| `affordances` | **The action bar.** Enumerates *yes* in advance, greys *no* with the reason |
| `suggest` | **The chips.** Ranked by code, phrased by the narrator |
| `preview` | **The evaluator.** Dry-runs an action through the *real* resolver: legality, cost, odds, consequences — rolling nothing, changing nothing |

### Engine (`src/engine/`)

`conversation` (topics assembled from state; open / guarded / sealed access),
`bystanders` (interjections, crowds as one presence, the cost of an audience),
`scenes` (where one scene ends and the next begins),
`questions` (asking the DM costs no turn), `reduce` (pure, cycle-guarded), `effects` (~35 effects, the only way state changes),
`triggers`, `knowledge`, `turn` (the only place dice are rolled), `combat` + `combatActions`
(initiative, economy, zones, opportunity attacks, spells, morale), `ambient` (the living
world), `pathfind` (fast travel), `encounters`, `rollback` (unlimited, non-destructive),
`succession` (legacy, world aging, seed promotion), `llmTurn`, `session`.

### View models (`src/view/`) — **your contract**

`screen(state)` returns everything a UI needs, already computed and already explained.
No component should reach into `GameState`.

- `rollCard(roll)` — natural die, modifiers, DC, degree
- `palette(state)` — grouped affordances + action-economy pips + rules lines not yet shown
- `mapModel(state)` — nodes with coordinates, edges, fog of war, pins, travel times
- `partyModel(state)` — companions with **tiers, not numbers**, plus reaction history
- `sheetModel(state)` — AC as its computation, skills, slots, inspiration, purse
- `questModel` / `vowModel` — quests, leads, clocks, progress tracks (never `dm_notes`)
- `sceneModel` / `combatModel` — the room; initiative with **enemy intent**
- `timelineModel(state, journal)` — **the cascade inspector**
- `conversationModel` — who, their disposition, every topic with open/closed **and the reason**
- `linkText(state, prose)` — entity linking as a post-process, no markup from the model

### The serving contract (`src/server/contract.ts`) — types only, no implementation

Three decisions that are expensive to get wrong and cheap to state:

1. **Mechanics first, prose streamed.** The `mechanics` frame — the roll card — goes out
   *before* the narrator writes a word. The player never waits on prose to learn if they hit.
2. **Optimistic concurrency on the journal's length.** Two tabs submitting at version 40:
   one commits, the other is refused with `version_conflict`. **Refused, not merged** — two
   interleaved turns is a corrupted world, and there is no correct automatic resolution.
3. **The server owns state.** The client holds view models and never `GameState`, so it
   cannot compute an outcome and therefore cannot disagree with one.

Plus a cost ledger (a runaway loop spends tokens silently), and a migration policy that
falls back to replaying the journal.

---

## What is yours

### Phase 7 — the client

Everything above is a data structure waiting for a component. The engine work is done; this
is rendering, and it is the largest remaining piece.

1. **Narrative feed with streaming.** Put `narration` first in the schema and incrementally
   parse, so prose appears as it arrives. One call, no extra cost. `linkText` gives you the
   spans; render `ref` as tappable.
2. **The roll card.** The most important component. Die, modifiers itemised by source, DC,
   outcome. Respect `prefers-reduced-motion` by showing the final card instantly.
3. **The action palette.** `palette()` is grouped and hotkey-ready. Show pips going out.
   **Never hide an unavailable action** — the reason is the lesson.
4. **The suggestion chips.** `out.suggestedActions`, 3–4 of them. **Tapping fills the text
   box; it does not submit.** That is what teaches phrasing, and it is the whole reason the
   feature exists.
5. **The aggregate enemy phase.** Collect consecutive CPU turns and narrate them as one
   beat with roll cards beneath. **Batch the narration, never the journal** — rewind
   granularity is per turn and the cascade inspector needs it.
6. **The map.** `mapModel` gives coordinates, edges and pins. Pan and zoom, tap to travel.
7. **The history log + cascade inspector.** `timelineModel` already has the chain.
8. **The conversation panel.** `screen().conversation`. Closed topics greyed *with the
   reason* — same pattern as the action bar, same lesson: trust is earned, and it opens
   doors no roll would.
9. **Speaker portraits.** A sprite for whoever is talking, above the dialogue.
   `sceneModel.present` and `conversationModel.with` already carry name, descriptor and
   disposition — a portrait plus a disposition tint would do most of the work. **Decide
   this early**: it changes how much vertical space the feed gets on a phone.
10. **Mobile first.** One column, bottom tab bar, feed always one tap away.

### Phase 8 — content

- `src/content/generate.ts` has the pipeline, stage prompts, stage schemas, and the lint
  (referential integrity + the three-clue rule). **The generator loop itself is unwritten:**
  run the stages, validate, freeze.
- `planSuccession` is done and tested. The **CLI that runs it** is not.
- One hand-authored campaign of three arcs, to prove the shape before generating more.

### Carried forward — small, known, unbuilt

- **Fighter and rogue class features** — Second Wind, Sneak Attack, Cunning Action.
  `flags.features` scaffolding exists; mechanics do not.
- **Rolled hit dice on level-up.** `levelUpPlan` accepts a die; nothing offers the roll.
All four of the long-standing small gaps are now **done** — see SPEC Part IX:

- **Companions speak.** A vocal reaction emits a `dialogue` event carrying the authored
  line, deterministically, with no model involved. The narrator is separately told who
  reacted and which way, so it can voice the same beat in character.
- **Inspiration is spent for advantage**, declared before the roll. Deliberately not RAW's
  reroll — SPEC §56 has the reasoning, worth reading before "fixing" it.
- **Recruitment** has a verb, an authored condition flag, and a trust floor of 35.
- **Shops have stock** — real item instances in `cont_<merchant_id>`.
- **Split party.** `Group` exists and `travelEffects` respects it; the loop is single-group.

---

## What to decide yourself, and what not to re-derive

Most of what is left is safe to iterate on until it is green: components, the Postgres
adapter, balance tuning, the generator loop, deployment. They all end in a passing test or
a rendering you can look at.

Four things are not, because a reasonable guess is wrong in a way that is expensive to undo:

- **What a turn is over the network.** Streaming prose before mechanics means the player
  waits on the narrator to learn whether they hit. That is a rewrite, not a tweak.
- **Concurrency.** "Merge the two turns" sounds sensible and corrupts worlds quietly.
- **Where authority lives.** Every temptation to let the narrator emit a number, a DC or a
  topic id is a temptation to undo the thing that makes the whole design work.
- **Trust is a DC, not a gate** (SPEC §48). An earlier version closed topics outright below
  a trust threshold; that was wrong, because at a table you can always reach for the dice.
  Three levels — open, guarded (a check at a trust-shifted DC), sealed. A seal cannot exist
  without naming what would lift it, and a critical at one yields **the key, never the
  secret**. Do not re-collapse this into "high DC" or into "no roll offered"; it is both,
  and which one applies is the design.

---

## Things that will bite you

**`meta.turn` counts root events, not player inputs.** The CPU takes turns too.

**Refusals cost nothing.** A refused action writes no event and advances no turn. Any test
counting turns against a script length is wrong.

**The narrator's accepted effects are journaled as their own root event.** That is what
keeps replay exact across a non-deterministic model. Do not "optimise" it away.

**Batching combat narration must not batch the journal.** Stated twice because it is the
easy mistake.

**`give_item` mints; `move_item` moves.** Picking something up is always `move_item`.

**`known_by` is the whole test for what the player knows.** `secret` is a *separate* axis —
it governs gossip and social pressure, not visibility. A fact nobody has told the player is
unknown whether or not it is secret.

**Confiding needs `SECRET_TRUST` (+25), not merely `HOSTILE_FLOOR` (−30).** The floor is
where someone stops talking to you at all. A stranger who does not distrust you is still a
stranger.

**A narration failure must not discard the turn.** Mechanics resolve before the narrator is
called; if the call throws, return `kind: "mechanics_only"` with the state you already have.
Rethrowing would reroll dice the player has already watched land.

**A natural 20 moves one band, not to the top band.** Deliberate, and not RAW. Same for a
natural 1 downward. A d20 should never be dead, but one step cannot rescue a hopeless total.

**A scene break is an event, not a mutation.** `scene_break` is journaled so a rewind puts
the scene back and the timeline can draw its divider. Room-to-room never breaks a scene —
the unit is the settlement or the region.

**Reputation applies once, on first meeting.** An existing relationship edge means you have
met, and what you did together outranks anything anyone said about you elsewhere.

**Interjections are narration cues with no mechanical effect.** Code decides who has
standing to speak; the DM writes the line. If one ever changes state, something is wrong.

**A companion's reaction is truth; their wording is not.** The reducer emits the line
deterministically from authored data. The narrator may rephrase it, never reverse it.

**Inspiration is advantage, not a reroll.** Deliberate — read SPEC §56 before changing it.
A post-hoc reroll is rewind under another name, and this game prices every other decision
before you commit.

**Recruitment is the one place trust is a gate rather than a DC.** No roll talks somebody
into risking their life beside you. It earns the exception because it is the only one.

**A clarifying question is not a turn.** No event, no clock, no model call, and a rewind can
never land inside one. If you find yourself journaling one, something is wrong.

**Map visibility has two independent axes.** `landmark` vs `discoverable` is *authored* —
whether the place is drawn at all before you find it. `known`/`seen`/`visited` is *earned*.
A world the character grew up in should be mostly landmarks.

**Attitude clamps apply only to untrusted sources.** Authored content is exempt —
`EffectCtx.clampAttitude`.

**Dice mode changes test determinism.** Suites asserting exact replay pin
`session_zero.dice = "committed"`.

---

## Running it

```bash
cp .env.example .env          # optional — no keys means MockLLM, which is fully supported
npm run check                 # typecheck + 257 tests
npm run play -- demo1 --mock  # play it in a terminal
```

Every CLI script loads `.env` automatically. `config/models.json` ships `REPLACE_ME` model
ids on purpose (model names move faster than code); the factory detects that and falls back
to the mock rather than calling an API with a placeholder.

**The project has no git repository yet.** There is a `.gitignore` and a CI workflow waiting
in `.github/workflows/`, but nothing is committed — no history, no bisect, no branches.
Worth fixing before anything else.

---

## Verify before and after

```bash
npm test                     # 265
npx tsc --noEmit
npm run demo && npm run rebuild -- demo    # byte-identical
npm run demo1                              # 20 free-text turns, replays exactly
npm run play -- demo1 --mock               # play it
```

If `rebuild` stops reporting byte-identical, something has taken determinism out of the
reducer. That is the alarm worth stopping for.
