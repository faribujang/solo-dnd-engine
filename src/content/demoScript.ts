import type { Action } from "../engine/turn.js";

/**
 * The phase-0 acceptance script: thirty actions through The Drowned Bell.
 *
 * It is written to exercise the machinery rather than to be a good time — every trigger
 * type in the campaign, both quests, a death, an item pickup that unlocks an exit, a
 * failure-tolerant path, and enough elapsed time to move the world clock into a new day.
 */
export const DEMO_SCRIPT: Action[] = [
  { type: "look" },                                                           // 1
  { type: "talk", target_id: "npc_thorne", topic: "the bell" },               // 2  quest 1 step 1
  { type: "skill_check", skill: "investigation", band: "medium", tag: "read_ledger" }, // 3  quest 2
  { type: "skill_check", skill: "perception", band: "easy", tag: "listen" },  // 4
  { type: "move", dir: "out" },                                               // 5  → the lane
  { type: "look" },                                                           // 6
  { type: "skill_check", skill: "perception", band: "easy", tag: "search" },  // 7
  { type: "take", item_instance_id: "item_inst_key" },                        // 8  world trigger
  { type: "talk", target_id: "npc_mira", topic: "the inscription" },          // 9
  { type: "skill_check", skill: "persuasion", band: "medium", target_id: "npc_mira" }, // 10
  { type: "move", dir: "down" },                                              // 11 → the gate
  { type: "look" },                                                           // 12 location trigger
  { type: "talk", target_id: "npc_garret", topic: "the stair" },              // 13
  { type: "skill_check", skill: "investigation", band: "medium", tag: "search" }, // 14 lever
  { type: "skill_check", skill: "stealth", band: "medium", target_id: "npc_garret" }, // 15 dim light
  { type: "move", dir: "down" },                                              // 16 → the crypt
  { type: "look" },                                                           // 17
  // Combat: an attack starts the fight, each turn is ended explicitly, and the CPU acts in
  // between. Extra attack/end pairs are refused harmlessly once the bonepicker is dead.
  { type: "attack", target_id: "mon_bonepicker" },                            // 18 initiative
  { type: "end_turn" },                                                       // 19
  { type: "attack", target_id: "mon_bonepicker" },                            // 20
  { type: "end_turn" },                                                       // 21
  { type: "attack", target_id: "mon_bonepicker" },                            // 22
  { type: "end_turn" },                                                       // 23
  { type: "attack", target_id: "mon_bonepicker" },                            // 24
  { type: "end_turn" },                                                       // 25
  { type: "attack", target_id: "mon_bonepicker" },                            // 26
  { type: "end_turn" },                                                       // 27
  { type: "skill_check", skill: "perception", band: "medium", tag: "listen" }, // 28 dark → disadv
  { type: "take", item_instance_id: "item_inst_bell" },                       // 29 quest 1 done
  { type: "rest", kind: "short" },                                            // 24
  { type: "move", dir: "up" },                                                // 25 → the gate
  { type: "move", dir: "up" },                                                // 26 → the lane
  { type: "wait", minutes: 240 },                                             // 27 gossip + night
  { type: "move", dir: "in" },                                                // 28 → the Flagon
  { type: "talk", target_id: "npc_thorne", topic: "the last column" },        // 29
  { type: "rest", kind: "long" },                                             // 30 clock past deadline
];
