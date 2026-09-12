import { JsonFileStore } from "../state/jsonFileStore.js";
import { dispositionOf } from "../rules/social.js";
import { entitiesAt, factsKnownToPc, hourOfDay, timeOfDayLabel } from "../state/selectors.js";

/**
 * Read a save without playing it.
 *   npm run inspect -- [save-id] [facts|rels|quests|world|all]
 *
 * Mostly useful for answering "why does the world think that", which in a system built on
 * cascading triggers is the question you ask most often.
 */
const saveId = process.argv[2] ?? "drowned_bell";
const section = process.argv[3] ?? "all";

const store = new JsonFileStore("saves");
if (!(await store.exists(saveId))) {
  const all = await store.listCampaigns();
  console.error(`No save "${saveId}".${all.length ? ` Have: ${all.map((c) => c.id).join(", ")}` : ""}`);
  process.exit(1);
}

const s = await store.load(saveId);
const show = (name: string) => section === "all" || section === name;

console.log(`\n${s.meta.title}  ·  turn ${s.meta.turn}  ·  day ${Math.floor(s.world.world_minute / 1440) + 1}, ${String(hourOfDay(s)).padStart(2, "0")}:${String(s.world.world_minute % 60).padStart(2, "0")} (${timeOfDayLabel(s)})`);

if (show("world")) {
  console.log(`\n── World ──`);
  console.log(`  weather: ${s.world.weather.current}`);
  console.log(`  flags:   ${Object.entries(s.world.flags).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ") || "none"}`);
  for (const f of Object.values(s.world.factions)) {
    console.log(`  faction ${f.name}: rep ${f.rep_with_pc}, members ${f.member_ids.join(", ")}`);
  }
  console.log(`  triggers fired: ${s.world.fired_trigger_ids.length}`);
  for (const t of s.world.fired_trigger_ids) console.log(`    · ${t}`);
}

if (show("quests")) {
  console.log(`\n── Quests ──`);
  for (const q of Object.values(s.quests)) {
    console.log(`  [${q.status}] ${q.title}  (${q.visibility})`);
    for (const st of q.steps) {
      const mark = st.status === "complete" ? "✓" : st.status === "active" ? "▸" : "·";
      console.log(`    ${mark} ${st.id}: ${st.desc}`);
    }
    for (const l of q.leads) console.log(`    lead: ${l.text}`);
  }
}

if (show("rels")) {
  console.log(`\n── Relationships ──`);
  for (const key of Object.keys(s.relationships).sort()) {
    const r = s.relationships[key]!;
    const subj = s.entities[r.subject]?.name ?? r.subject;
    const obj = s.entities[r.object]?.name ?? r.object;
    console.log(`  ${subj} → ${obj}: ${dispositionOf(r.dims.affinity)}  aff ${r.dims.affinity} trust ${r.dims.trust} fear ${r.dims.fear} respect ${r.dims.respect}`);
    if (r.opinion) console.log(`    "${r.opinion}"`);
    for (const h of r.history.slice(-3)) {
      console.log(`    t${h.turn}: ${JSON.stringify(h.dims)} — ${h.reason}`);
    }
  }
}

if (show("facts")) {
  console.log(`\n── Fact ledger (${s.facts.length} total, ${factsKnownToPc(s).length} known to you) ──`);
  for (const f of s.facts) {
    const knowers = f.known_by.map((k) => s.entities[k]?.name ?? k).join(", ");
    console.log(`  [${f.importance}]${f.secret ? " SECRET" : ""} ${f.text}`);
    console.log(`      known by: ${knowers || "nobody"}`);
  }
}

if (show("all")) {
  console.log(`\n── Cast ──`);
  for (const locId of Object.keys(s.locations).sort()) {
    const here = entitiesAt(s, locId);
    if (!here.length) continue;
    console.log(`  ${s.locations[locId]!.name}: ${here.map((e) => `${e.name}${e.alive ? "" : " (dead)"} ${e.hp.current}/${e.hp.max}`).join(", ")}`);
  }
}

console.log();
