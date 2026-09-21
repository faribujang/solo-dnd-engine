import { describe, expect, it } from "vitest";
import { looksLikeAnAction } from "../../src/rules/suggest.js";

/**
 * A chip is a button that claims to be a next move. When the narrator drifts it writes
 * recaps instead — a sentence about what somebody said two days ago, in another town —
 * and the player taps it expecting an action. The phrasing is checked, not trusted.
 */
describe("what may appear on a suggestion chip", () => {
  const ok = [
    "Ask Teal who pays the cutters",
    "Search the winch house",
    "Draw the axe and step into the lane",
    "Press Bel about the night load",
    "Follow the runner down the slips",
  ];
  const no = [
    // The one that shipped, and the shape of the problem.
    "Sibby said the smoke is coming off the green, not the fields. That means houses",
    "Sibby said the smoke is off the green",
    "You have a bow and twenty arrows",
    "There is a guard on the tollhouse door",
    "It seems the cutters answer to a clerk",
    "Teal looks like she is about to run",
    '"Not for you, I don\'t"',
    "Remember what Cotter told you about the Accord",
    "The crane sits past the second sluice and the winch house is somewhere below it, past the drains",
  ];

  for (const t of ok) it(`keeps: ${t}`, () => expect(looksLikeAnAction(t)).toBe(true));
  for (const t of no) it(`drops: ${t.slice(0, 44)}`, () => expect(looksLikeAnAction(t)).toBe(false));
});

import { groupOf, suggest } from "../../src/rules/suggest.js";
import { tinyWorld } from "../helpers/world.js";

/**
 * Four different ways to talk to four different people is still a receiving line. The
 * per-action penalty never noticed, because none of them was the same action twice.
 */
describe("variety across kinds of thing, not just actions", () => {
  it("sorts actions into the kind a player would recognise", () => {
    expect(groupOf({ action: { type: "talk" } })).toBe("talking");
    expect(groupOf({ action: { type: "interact" } })).toBe("handling");
    expect(groupOf({ action: { type: "travel" } })).toBe("moving");
    expect(groupOf({ action: { type: "attack" } })).toBe("fighting");
  });

  it("pushes the bar away from a kind the last few turns were all made of", () => {
    const s = tinyWorld();
    const plain = suggest(s, { limit: 4 });
    const afterTalking = suggest(s, { limit: 4, recentGroups: ["talking", "talking", "talking"] });

    const talkingIn = (list: ReturnType<typeof suggest>) =>
      list.filter((x) => groupOf(x.affordance as { action: { type: string } }) === "talking").length;

    // Not a ban — a thumb on the scale. It must never come out heavier than before.
    expect(talkingIn(afterTalking)).toBeLessThanOrEqual(talkingIn(plain));
  });
});
