import { describe, expect, it } from "vitest";
import { splitCompound } from "../../src/llm/intent.js";

/**
 * "Thank Severi and go to the Fetterlock" is two instructions. The game played the first
 * and silently dropped the second, so the player typed it again having already said it.
 *
 * The split has to be narrow: a wrong one costs a turn and teaches the player that the
 * parser guesses. Everything here is a case that actually appeared in a playthrough, or
 * a case that would have been cut wrongly by a looser rule.
 */
describe("two instructions in one line", () => {
  it("splits where the player plainly started a new command", () => {
    expect(splitCompound("thank severi and go to the fetterlock"))
      .toEqual(["thank severi", "go to the fetterlock"]);
    expect(splitCompound("ask Teal about the crane then follow her down"))
      .toEqual(["ask Teal about the crane", "follow her down"]);
    expect(splitCompound("search the drain, then listen at the grate"))
      .toEqual(["search the drain", "listen at the grate"]);
  });

  it("leaves a single instruction alone, however many 'and's it contains", () => {
    // The killer case: a looser rule cuts this in half and then hunts for a cheese.
    expect(splitCompound("take the bread and cheese")).toBeNull();
    expect(splitCompound("draw the axe and buckler")).toBeNull();
    expect(splitCompound("tell him about the smoke and the riders")).toBeNull();
  });

  it("never splits a question", () => {
    expect(splitCompound("where is jory and what is he doing?")).toBeNull();
  });

  it("ignores a fragment too short to be a command", () => {
    expect(splitCompound("go and see")).toBeNull();
  });
});
