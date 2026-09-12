/**
 * The phase-1 acceptance script: twenty turns of ordinary free text.
 *
 * Written the way a player actually types — abbreviations, an ambiguous line, a request
 * for something not implemented, and a couple of nonsense entries — because a turn loop
 * that only survives well-formed input has not been tested.
 */
export const DEMO_FREE_TEXT: string[] = [
  "what are my surroundings?",                       // 1  a question — costs no turn
  "who is here?",                                    // 2  also free
  "look around",                                     // 3
  "talk to thorne about the bell",                   // 2
  "ask him about the ashen hand",                    // 3
  "investigate the ledger on the bar",               // 4
  "go out",                                          // 5
  "search the mud",                                  // 6
  "grab the key",                                    // 7
  "talk to mira about the inscription",              // 8
  "flurb the wibbet",                                // 9  nonsense → clarify
  "head down toward the shrine",                     // 10 an athletics check; may fail
  "try the path down again",                         // 11 players retry, so the script does
  "look",                                            // 12
  "speak to garret about the stair",                 // 13
  "cast fireball at the guard",                      // 14 not implemented → honest refusal
  "search behind the altar",                         // 15 reveals the stair
  "go down",                                         // 16
  "attack the bonepicker",                           // 17 starts the fight
  "end my turn",                                     // 18
  "hit it again",                                    // 19 no name given; only one target
  "end turn",                                        // 20
  "hit it again",                                    // 21 refused harmlessly if it is dead
  "end turn",                                        // 22
  "take the bell",                                   // 23
  "rest for the night",                              // 24
];
