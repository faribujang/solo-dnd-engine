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
