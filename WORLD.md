# Cinderhold

The world, the story, and what is still open.

---

## How to use this document

`SPEC.md` is the engine — architecture, rules, why things are built the way they are.
`HANDOFF.md` is the build state — what exists, what is next, what will bite you.
**This file is the world.** Fiction, factions, the shape of the first campaign, and an
honest list of what has been decided versus what is still up for grabs.

**If you are joining the project:** read §1–§6 for the world, then §8 to see where you can
contribute without treading on settled ground.

**If you are a future session picking this up:** this file plus `SPEC.md` and `HANDOFF.md`
are the complete handoff. §9 says exactly where things stand.

---

## 1. The premise

**The Meridian Syndicate did not fight the war. It supplied it.**

Two empires spent a generation trying to destroy each other, and both bought their magic
from the same people. When they finally bled out, the supplier was the only institution left
standing — and it now governs by owning the thing everyone needs, without ever having taken
a throne.

That one move is the spine of the setting. It explains why the Syndicate rules without a
crown, why the local councils sign whatever they are handed, why the loyalists of both dead
empires are bitter remnants rather than armies, and — the part that matters most — **why
there are lawless places at all.** A power that governs through supply only governs where it
supplies. The ungoverned towns are not a separate region on the map. They are the
Syndicate's shadow.

---

## 2. The three powers

| | Position on magic | Their good | Their rot |
|---|---|---|---|
| **The Arcanate**<br>*(remnant)* | A discipline. Learned, licensed, taught, improved. | **They democratised it.** Before the Arcanate, magic was hereditary and feudal — they made it learnable by anyone who could pass an exam. Genuinely liberating. | Making it learnable made it *ownable*. Once it was ownable it could be bought, and the Syndicate bought it. They built the lock and handed over the key. |
| **The Radiant Accord**<br>*(remnant)* | A grace. Given to whoever it is given to. Arcane study is theft dressed as scholarship. | **They never sold anyone.** Their healers healed for free. The only power that did not treat people as supply. | "Called" means somebody decides who is called, and that somebody was a hereditary priesthood. Their compassion was rationed by birth. |
| **The Meridian Syndicate** | Supply. | **It works.** Lamps stay lit. A farmer buys a healing draught who would have died waiting for a priest to be moved by grace. | It is priced. |

### The grievances are asymmetric, on purpose

This is the load-bearing detail. The two remnants cannot ally *even against a common enemy*:

- **The Arcanate wants the Syndicate taken over.** They invented the licensing system; they
  believe they would run it properly.
- **The Accord wants it torn down.** The thing being sold in those machines was never
  anyone's to sell.

So helping one costs you with the other, and because reputation travels ahead of you, the
cost arrives before you do.

### Nobody is monolithic

Each power has internal wings that want different things. An NPC belongs to one, and the DM
is told which — because a DM told only the banner plays the banner.

| Faction | Wing | Wants |
|---|---|---|
| Meridian Syndicate | **Charter** | Legitimacy — a seat, a flag, a law they wrote themselves |
| | **Assay** | Supply *is* legitimacy; anyone who says otherwise has never run a lamp |
| Arcanate Remnant | **Restorers** | The Arcanate restored, and the patents with it |
| | **Pensioners** | Nothing grand — the pension they were promised, paid |
| Radiant Accord | **Shepherds** | Get the gifted out before the Syndicate contracts them |
| | **Kindlers** | The machines broken, whatever it costs the people running them |

---

## 3. The map, in three layers

| | Who holds it | What it feels like |
|---|---|---|
| **Syndicate cities** | The Syndicate, through price and contract. A council exists and signs what it is told. | Orderly. Expensive. |
| **Loyalist strongholds** | Remnants of one empire or the other. Fewer every year. | Suspicious, proud, poor. |
| **The gaps** | Whoever is nearest — a smuggler ring, a strongman, a harbour compact. | Free, and free means whatever the strongest person present decides. |

**"No law" is never a vacuum.** Somebody always fills it. The gaps are *informally*
governed, and that is where the merchant-republic flavour lives: compacts, debt networks,
families. A blank space on the map is not content; an informally governed one is.

### The price of magic tells you where you are

The Syndicate's grip sets what supply costs, and the shape is deliberate:

- **Uncontested monopoly** — expensive. A monopoly prices like a monopoly.
- **No Syndicate presence at all** — more expensive still. Scarcity is its own tax.
- **Contested** — cheapest. Competition is the only thing that has ever lowered a price.

So **the cheapest towns are the dangerous ones.** A player can read the political map
through a shop counter without anyone explaining it.

---

## 4. The peoples

Placed by what industrialisation *did* to them, not by temperament.

| | Where they sit | Their internal argument |
|---|---|---|
| **Human** | Both empires. The war was a human war; everyone else was conscripted or sold to it. | Which side, and whether that still matters |
| **Dwarf** | **They built it.** Industrial magic needs metallurgy, machining, tolerances. The Syndicate did not beat the dwarves — it hired them. | Complicity. The craft guilds are split between those who took the contracts and those who would not |
| **Elf / wood folk** | Their magic was *ambient*, drawn from living land. Extraction is killing the source. Not noble stewards — a people watching their power supply die. | Fight, flee, or sell extraction rights. An elf who signed is a more interesting character than one who did not |
| **Halfling** | **The gaps.** Never worth conquering, so never governed. The compacts and harbour councils are theirs. | Whether to stay ungoverned now that ungoverned means undefended |

> **Engine note:** only these four exist mechanically today. Adding more is data, not code —
> see `src/content/srd/data.ts`.

---

## 5. Magic, and what it costs to be a caster

Magic is becoming machine-hybrid. Someone who casts *without apparatus* is three things at
once: a competitor who does not need to buy, a resource that can be contracted, and living
evidence that the old way worked. They are hunted, courted and mythologised simultaneously.

**The Syndicate does not care what you can do. It cares where you got it.**

| | How they are read |
|---|---|
| **Wizard** | Trained outside the licensing. Unlicensed, therefore criminal. |
| **Cleric / Paladin** | A rival *institution*, not a rival supplier. A political problem, handled politically. |
| **Druid / Ranger** | Drawing on the land being strip-mined. An enemy by geology. |
| **Warlock** | The nightmare. An unauditable supply line to something that cannot be bought, regulated or cut off. |
| **Bard, Rogue, Fighter, Barbarian** | Beneath notice — which is its own kind of freedom. |

Class choice is therefore a **political fact**, read differently in every town.

---

## 6. Campaign one

Scope is **one to five years**, not generations. Generational play is campaign two.

### The prologue

Solo, young adulthood, in a **Syndicate-jurisdiction village on the edge of Accord loyalist
country** — so all three layers of the map are within a few days' travel and the first city
is a real destination.

Starting where everyone already knows you is deliberate: it is the best possible showcase
for the relationship system, and it is what makes it land later when you walk into a
stranger's town and your reputation decides for you before you speak.

### The tragedy

Half the village destroyed. The player's family among the dead — and **one of them missing.**

That missing person reappears later, in a new role. Mechanically they are a **sealed fact**
from turn one: the truth exists in the ledger, nobody reachable knows it, and it carries a
named key that says what would open it. The secret is kept by the *world*, not by the DM's
memory, so it cannot drift.

Ruined rather than razed — a place you can return to and find worse is a clock that needs no
explaining.

### The party

- **The player character** starts as a regular person. Fighter, rogue and barbarian never
  cast; ranger and paladin get no spells until level 2. So *"magic comes later, if you go
  deeper"* needs no special-casing — it is how 5e already works.
- **The childhood friend** turns out to be a **warlock**, and has to learn to control it.
  This makes your first companion a liability with a number on it: travelling with an
  unauditable caster through Syndicate territory is a real risk, and the game can price it.
  Nobody taught them, because nobody could.

### The arc shape

Local grievance → the first city → the politics → the thing underneath. Three to five arcs.

---

## 7. What is coming

**Extraction has a bottom, and something is under it.**

Not a dragon that happens to wake up — the thing stirs *because* of the world's central
activity. That earns it, and it sets up the late turn: to fight it you may need the
Syndicate's infrastructure. The institution you spent three arcs dismantling may be the only
thing that can build a defence.

Two threads planted now, paid off later:

- **Reincarnation.** Somebody in a loyalist stronghold claims their commander is the same
  person who led them eighty years ago. Nobody can prove it. A sealed fact in campaign one;
  a mechanic in campaign two.
- **The friend's patron.** If you want it: whatever is talking to them is what is under the
  extraction. That ties their arc to the ending instead of running beside it.

---

## 8. Settled, and open

### Settled — please build on these rather than relitigating

- The premise: the supplier won because it supplied both sides
- The three powers, their wings, and the asymmetry of the two remnants' grievances
- The three-layer map, and that the gaps are *caused by* the Syndicate's reach
- The four peoples and their positions
- Casters are political; the Syndicate cares about provenance, not capability
- The prologue: solo, Syndicate village on Accord's edge, half destroyed, one family member missing
- First companion: childhood friend, warlock, learning control
- Scope of campaign one: 1–5 years
- **Tertiary groups are not peer factions.** Thieves, assassins, mercenaries, resistance
  cells and buyers-of-magic are *service layers* that appear inside a town's politics —
  every town has someone who moves goods and someone who moves people, and who they answer
  to is what the faction matrix decides. Keeping the matrix at four rows is what keeps it
  legible.

### Open — good places to contribute

Most of the earlier open questions are now answered in content — read
`content/campaign/wickmoor/` rather than this list. What remains genuinely open:

- **What is under the extraction.** Seeded, unwritten.
- **Arc two.** Saveri refuses; three things can move her, and all three are written into her
  `dm_notes`. Which one the story takes is unwritten.
- **Bryn.** Taken alive by people who had the wrong child. Where she surfaces, and as what.
- **The Cut, and Kettle's four streets.** A whole ungoverned quarter with one person holding
  it together and no quests in it yet.
- **Whether Bel is right.** She wants the assay ledger burned. It lists every unlicensed
  caster reported in forty miles. She is not wrong about what it is.

---

## 9. Where the build actually is

**Playable today, in a terminal, offline and free:**

```bash
npm run seed -- drowned_bell my_save
npm run play -- my_save --mock
```

**Playable in a browser**, on a phone, with turns that stream:

```bash
npm run serve                # :8787 — open it and pick a save
npm run serve -- --mock      # same, with no model and no cost
```

One process, one port, no build step: `web/dist/index.html` is served by the same server
that answers the API.

**Playing from somewhere else** — a phone, a friend's laptop — needs no deployment, only a
tunnel back to the machine running `npm run serve`:

```bash
GAME_SECRET=pick-something npm run serve
cloudflared tunnel --url http://localhost:8787
```

The tunnel prints an `https://…trycloudflare.com` address. Open it anywhere, paste the
secret once, and play. Set `GAME_SECRET` before exposing anything: without it the tunnel is
an open door to every save on the machine.

**Point it at a real Dungeon Master** (the mock is a structural stand-in and a dull writer):

```bash
cp .env.example .env         # add GEMINI_API_KEY or OPENROUTER_API_KEY
npm run models               # what your key can actually reach
npm run models -- --write    # fill config/models.json from that
```

**Play the prologue:**

```bash
npm run seed -- wickmoor wick
npm run play -- wick --mock
```

**What exists to play**

| | |
|---|---|
| **Prologue — Wickmoor** | The forge, the green, the bakehouse, the moot hall, the river. The day turns when you go fishing. |
| **Arc one — Assay Row** | Harrowmoot: the tollgate, the Row, the Fetterlock, the Pensioners' Hall, the Cut. A search that ends in a refusal. |

Thirteen places, twenty people, four quests, two settlements with their own politics — and
the lamp oil is cheaper in Harrowmoot than in Wickmoor, which is the faction matrix telling
you something nobody had to write down.

**What is not there yet:**

1. **Arc two onward.** Saveri refuses, and what happens after that refusal is unwritten.
2. **The web client is a first cut.** Scene header, streamed prose, roll cards, the action
   palette, the character sheet, character creation, and recovery from a version conflict —
   all working. Not yet: the map, the timeline, rewind, combat's zone view, and the
   companion panel. Every one of those has a tested view model behind it already.
3. **Five generator stages are missing** — items, relationships, facts, wiring, and a cast
   that includes a companion with an approval table. Until those exist, generated campaigns
   load and can be walked through but have no objects, no opinions and nothing developing.

**Two paths to something you can actually play as Cinderhold:**

- **Hand-author the prologue** (no blockers, works today). The spec's own advice is *author
  one, then generate* — and nothing has been hand-built in this world yet for a generator
  to imitate.
- **Finish the generator stages first**, then generate. Bigger unlock, but aiming at a
  target nobody has hit by hand.

### Also open, and not world content

- **The "continuous session zero" feature.** The player appends a suggestion mid-campaign;
  the DM weaves it in; the player never takes the wheel. Suggestions would go into the
  prompt as soft guidance like tone and lines/veils already do, **cannot emit effects**, and
  anything that becomes true does so through the normal validated path — so it lands in the
  fact ledger properly or not at all. Roughly one field and one prompt block. Not built.

---

## 10. Keeping ideas implementable

The engine has one rule: **code owns truth, the LLM owns voice.** A world idea stays
buildable if it can be expressed as *data* the engine already understands:

| An idea like… | Lands as |
|---|---|
| "This town is Syndicate, but the Accord shelters people there" | `Settlement.presence` — the faction matrix |
| "He will not talk about his debts until his brother is free" | A `seal` on a fact, with its key named |
| "The war is going badly for them this winter" | A clock, ticking in months |
| "People here can tell you came up rough" | Background standing plus the NPC's social tags |
| "Prices are terrible in the capital" | Falls out of Syndicate strength; nothing to author |
| "The front moved and this town changed hands" | A `set_presence` effect, journaled like any turn |

If an idea needs the DM to *remember* something rather than the world to *hold* it, it will
drift by turn fifty. That is the test worth applying to a new idea.

---

## 11. Working together on this

CI runs on every pull request — typecheck, the full test suite, and a byte-identical replay
check. A change that breaks the world fails before it merges.

| Changing… | Where | Needs |
|---|---|---|
| World, story, fiction | `WORLD.md` | Nothing. Open a PR and argue in the diff |
| A campaign's content | `content/campaign/<name>/*.json` | Must pass `npm run check` |
| Engine, rules, systems | `src/` | A test, and `npm run check` green |

```bash
git checkout -b your-idea
# ...
npm run check      # typecheck + the full suite
git push -u origin your-idea
```

For world edits specifically: **prefer adding to §8 "Open" over editing §8 "Settled."** If
something settled turns out to be wrong, say so in the PR rather than quietly changing it —
most of those decisions have a reason recorded in `SPEC.md` Part XIII.
