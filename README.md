# Solo D&D Engine

A single-player 5e campaign where the state is a database and the Dungeon Master is only a voice.

Built to [`SPEC.md`](./SPEC.md). The world it is being built for is [`WORLD.md`](./WORLD.md). **The engine and the server are complete: 361 tests, byte-identical replay.**
What remains is the client — see [`HANDOFF.md`](./HANDOFF.md).

Built so far: schemas, store, reducer, trigger DSL, the full LLM turn loop, a living world,
unlimited rewind, three dice modes, character creation and progression, death saves,
computed AC, the affordance engine that teaches the rules, 5e combat (initiative, the action
economy, zones, opportunity attacks, the full condition list, spells with concentration, CPU
policies and morale), conversation with topics derived from state, clarifying questions that
cost no turn, an action evaluator, companions who react out loud, backgrounds the world
reacts to, reputation that travels
ahead of you, scenes, and a world that keeps moving while you are elsewhere.

---

## The one rule

> **Code owns truth. The LLM owns voice.**

The reducer contains no randomness, no clock and no I/O. Dice are rolled during *resolution*
and baked into the event as concrete numbers. The narrator's accepted output is journaled as
its own event. So a save replays exactly — even though a language model helped write it.

If the LLM disappeared mid-campaign, the save file would still be a complete, correct,
playable world.

## Try it

No API key needed. The mock DM is deterministic, offline and free, and the entire test
suite runs on it.

```bash
npm install
npm run demo1                # 20 turns of free text through the whole pipeline
npm run play -- demo1 --mock # play it yourself
npm run check                # typecheck + 361 tests
npm run serve -- --mock      # or play it over HTTP on :8787
```

To use a real model, copy the env template and fill in
[`config/models.json`](./config/README.md):

```bash
cp .env.example .env             # then add GEMINI_API_KEY or OPENROUTER_API_KEY
npm run demo1 -- --live
```

Every script loads `.env` automatically. With no keys the router falls back to the mock and
says so, rather than failing — that is a supported mode, not a degraded one.

Other commands:

```bash
npm run seed                 # fresh save from content/campaign/drowned_bell
npm run demo                 # phase-0 script: structured commands, no LLM
npm run rebuild -- demo      # replay a journal and prove the world is byte-identical
npm run inspect -- demo1     # read a world without playing it
```

## How a turn works

```
player text
  → [1] intent     LLM    free text → a structured proposal (never an outcome)
  → [2] resolve    CODE   legality, DC lookup, seeded dice, costs   ← all randomness
  → [3] reduce     CODE   event → state, cascading through the trigger DSL
  → [4] context    CODE   deterministic, budgeted prompt assembly
  → [5] narrate    LLM    prose, plus soft proposals
  → [6] commit     CODE   whitelist validation → a second journaled event
```

Steps 2, 3, 4 and 6 are pure functions. That is where the correctness lives, and it is why
the engine is fully testable without a model in the loop.

## In-game commands

Say what you do in your own words. Slash commands are out-of-world — they cost no time,
write nothing, and never reach the model.

```
/actions                           what you can do right now, with the arithmetic
/look /sheet /inv /quests /who     information
/timeline                          every turn so far
/rewind <turn>                     return to any earlier turn
/branches                          timelines set aside by a rewind
```

## The parts worth knowing about

**Event sourcing.** `journal.jsonl` is append-only and complete; every other save file is a
cache rebuildable from it. `npm run rebuild` proves it on demand.

**Failure is a scene, not a wall.** A check is graded into four bands, not two: beat the DC
by 5 for more than you asked, meet it for a clean success, miss by 1–2 for **success at a
cost** — you get what you reached for *and* something goes wrong — and miss by more for a
failure that must still change the situation. Most rolls land in the middle band, which is
where stories happen. Attack rolls stay clean hit/miss.

**Suggestion chips are ranked by code and phrased by the narrator.** The affordance bar
answers "what can I do"; three or four chips answer "what is interesting now". Code scores
them on what just became possible, what advances a quest, what a lead points at, and what
you have not tried this scene. The model only turns the winners into something a person
would say — and tapping one fills the text box rather than submitting it, because that is
what teaches phrasing.

**Dice are a session-zero choice.** `karmic` (default, Baldur's Gate 3's approach): real
dice with a subtle streak-breaker, so five failures in a row is rarer than a fair die makes
it — it leans on a roll, never decides one. `true`: a physical die. `committed`: seeded by
the situation, so a rewind cannot reroll a check. Every mode journals the roll, so replay
is exact in all three.

**Rewind is free, unlimited and non-destructive.** Because the journal is append-only and
the reducer is pure, "the world at turn N" is just the fold of the first N events. There is
no depth limit — turn 3 is as reachable from turn 400 as turn 399 is — and nothing is ever
destroyed: events dropped by a rewind are archived to `branches/`, so the rewind itself can
be undone.

**The fact ledger, not a summary.** A summary compresses everything and so degrades
everything. This compresses nothing; it declines to show facts that are not relevant right
now. Walk back into the inn at turn 400 and every fact ever recorded about that innkeeper
returns verbatim. Each fact carries `known_by` and each event carries `witnesses`, so an NPC
cannot mention a murder they never saw and nobody told them about.

**No conversation history.** Every narration call is stateless and rebuilt from state. The
model cannot misremember something it is handed fresh each turn, which makes drift
structurally impossible rather than merely unlikely.

**Relationships are split deliberately.** The numeric `dims` (affinity, trust, fear,
respect) are written by code and drive *mechanics* — social DC shifts, whether a secret is
shared, merchant pricing. The free-text `opinion` is written by the LLM and drives *voice*
only.

**The world moves without you.** When time passes, NPCs pursue goals, factions with a
grievance act on it, rumours travel, feelings cool toward neutral, and the weather turns.
Code decides *what* happened, from goals and schedules and faction state; the model is only
ever asked how it looked, and only for beats the player could actually perceive.

**Everything the narrator says is checked.** `src/llm/validate.ts` is the only door into
state. It resolves loose names to ids, refuses engine-only effects, clamps attitude swings
to ±10 a turn, caps how far the clock may move, and drops anything naming something that
does not exist. Refusals go to `rejects.jsonl` — the best debugging signal in the system,
because it shows exactly where the model is reaching past its authority.

## Layout

```
src/schema/     Zod — types, runtime validation and the LLM's JSON Schema, from one source
src/rules/      dice, checks, modifiers, social consequences   ← the only place dice are rolled
src/state/      StateStore interface, JsonFileStore, selectors
src/engine/     conditions, effects, triggers, knowledge, reduce, turn, ambient, rollback
src/context/    fact retrieval and budgeted prompt assembly
src/llm/        client, mock, OpenAI-compatible adapter, router, intent, validate
src/view/       view models — the whole contract a client consumes
src/cli/        seed, play, demo, demo1, rebuild, inspect
content/campaign/drowned_bell/    the starter campaign
config/         model routing; no model id is hardcoded in src/
tests/          361 tests, including every phase gate
saves/          gitignored
```

## Rules content

SRD 5.1 / 5.2 content is Creative Commons and belongs in `content/srd/`. Named published
adventures, Forgotten Realms proper nouns and non-SRD monsters do not. The Drowned Bell is
original content.
