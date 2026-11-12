// Authoritative case file for "The Last Signal".
// Server-side only: the solution and witness fact sheets never reach the browser
// except through the permission layer (see game.js).

export const CASE_ID = "last-signal";

export const CASE_INFO = {
  id: CASE_ID,
  title: "The Last Signal",
  location: "Blackridge Research Station",
  premise:
    "At 21:12 the station loses its lights for ninety seconds. When power returns, the Aster, a valuable portable mineral scanner, is missing from Laboratory 04. Three people had access, and each gives an alibi.",
  sessionMinutes: "20-30",
};

export const SUSPECTS = [
  { id: "mara", name: "Dr. Mara Vale", position: "Lead researcher", alibi: "On the west gantry from 21:08 to 21:18" },
  { id: "theo", name: "Theo Marsh", position: "Records archivist", alibi: "Signing the custody ledger at reception" },
  { id: "nina", name: "Nina Cole", position: "Station director", alibi: "Outside the station, waiting for a jammed gate to open" },
];

export const ROLES = {
  systems: {
    id: "systems",
    title: "Systems analyst",
    responsibility: "Examine digital activity",
    intro: "You review badge readers, terminals and network logs for Blackridge.",
    clueIds: ["C1", "C2"],
  },
  records: {
    id: "records",
    title: "Records specialist",
    responsibility: "Inspect paperwork and records",
    intro: "You review work orders, ledgers and signed paperwork for Blackridge.",
    clueIds: ["C3", "C4"],
  },
  field: {
    id: "field",
    title: "Field investigator",
    responsibility: "Follow physical evidence",
    intro: "You examine physical items and camera footage from around the station.",
    clueIds: ["C5", "C6"],
  },
};

export const ROLE_ORDER = ["systems", "records", "field"];

// Every clue: unique ID, title, source type, timestamp, owner role, text.
export const CLUES = [
  {
    id: "C1",
    title: "Freight reader log",
    sourceType: "Digital log",
    timestamp: "21:13",
    ownerRole: "systems",
    text:
      "Badge reader FR-2 recorded Mara Vale's assigned badge opening the laboratory freight corridor at 21:13. A badge scan alone does not identify who was carrying the badge.",
  },
  {
    id: "C2",
    title: "Remote lighting-test request",
    sourceType: "System request",
    timestamp: "21:12",
    ownerRole: "systems",
    text:
      "The remote lighting-test request that triggered the blackout originated from terminal F2, located at the freight dock.",
  },
  {
    id: "C3",
    title: "Signed work order",
    sourceType: "Paperwork",
    timestamp: "Filed 17:40",
    ownerRole: "records",
    text:
      "Work order WO-5531 requests a station lighting test. Requested by: Dr. Mara Vale. The authorization field is blank; no supervisor approved the test.",
  },
  {
    id: "C4",
    title: "Reception custody ledger",
    sourceType: "Ledger + footage",
    timestamp: "21:05-21:20",
    ownerRole: "records",
    text:
      "Theo Marsh signed the custody ledger at reception at 21:06 and again at 21:19. Reception footage corroborates he stayed at the desk throughout.",
  },
  {
    id: "C5",
    title: "Recovered courier case",
    sourceType: "Physical evidence",
    timestamp: "Found 23:30",
    ownerRole: "field",
    text:
      "The Aster prototype was found inside a courier case in a locker reserved under Mara Vale's project account. The courier label names Mara Vale as sender.",
  },
  {
    id: "C6",
    title: "East gate camera record",
    sourceType: "Camera footage",
    timestamp: "21:05-21:20",
    ownerRole: "field",
    text:
      "East gate camera footage shows Nina Cole outside the jammed gate from 21:05 until 21:19, when the gate cleared.",
  },
];

export const CLUE_BY_ID = Object.fromEntries(CLUES.map((c) => [c.id, c]));

// Witness fact sheets. Each witness gets ONLY their own facts. Never the solution.
// kind: observed | belief | unknown
export const WITNESSES = {
  jules: {
    id: "jules",
    name: "Jules Hart",
    title: "Security officer",
    voice:
      "Terse, professional, a little tired from the night shift. Speaks in short sentences. Careful to say what he saw versus what he assumes.",
    facts: [
      { kind: "observed", text: "Around 21:10 I saw a staff member pushing a courier case on a cart toward the freight dock. I could not see the face. The corridor lights were dim." },
      { kind: "observed", text: "Nina Cole was at the east gate when I passed it at about 21:08. The gate was jammed and she was waiting." },
      { kind: "observed", text: "When the lights went out at 21:12 I was in the security office. They came back about ninety seconds later." },
      { kind: "belief", text: "I think the person with the cart was wearing a dark jacket, but I'm not certain, and a jacket colour proves nothing." },
      { kind: "unknown", text: "I did not see who opened the freight corridor, and I do not know who operated any terminal." },
      { kind: "unknown", text: "I have no information about work orders, ledgers, or who requested the lighting test." },
    ],
  },
  ivo: {
    id: "ivo",
    name: "Ivo Bell",
    title: "Maintenance engineer",
    voice:
      "Practical and precise, likes numbers. Slightly pedantic about procedure. Explains things like a technician.",
    facts: [
      { kind: "observed", text: "Terminal F2 is physically located at the freight dock. It cannot be operated from the west gantry." },
      { kind: "observed", text: "The west gantry and the freight dock are a six-minute walk apart." },
      { kind: "observed", text: "A lighting test must be triggered from a terminal and normally requires a signed authorization before maintenance runs it." },
      { kind: "belief", text: "I believe a test run without authorization would be a serious breach of procedure." },
      { kind: "unknown", text: "I do not know who triggered the test on the night, and I do not know where any particular person was." },
      { kind: "unknown", text: "I have no information about badge assignments, ledgers, or the courier case." },
    ],
  },
};

// Author-only. Used by the reveal. Never sent to witnesses or archive.
export const SOLUTION = {
  culprit: "mara",
  summary:
    "Dr. Mara Vale requested the unauthorized lighting test, triggered it from the freight dock while claiming to be on the west gantry, and shipped the Aster out under her own project account.",
  timeline: [
    { time: "17:40", event: "Work order WO-5531 filed by Mara requesting a lighting test. Authorization left blank.", clueIds: ["C3"] },
    { time: "21:05-21:19", event: "Nina is outside the east gate and Theo is at reception. Independent records corroborate both.", clueIds: ["C4", "C6"] },
    { time: "21:10", event: "Security sees a courier case on a cart moving toward the freight dock.", clueIds: [] },
    { time: "21:12", event: "Lighting test is triggered from terminal F2 at the freight dock. The station goes dark for ninety seconds.", clueIds: ["C2"] },
    { time: "21:13", event: "Mara's assigned badge opens the freight corridor.", clueIds: ["C1"] },
    { time: "23:30", event: "The Aster is recovered in a courier case in a locker under Mara's project account, with her named as sender.", clueIds: ["C5"] },
  ],
  evidenceStrength: [
    { clueId: "C2", strength: "strong", note: "F2 is at the freight dock, six minutes from the west gantry. Mara could not have triggered it from her claimed alibi location." },
    { clueId: "C5", strength: "strong", note: "Locker and courier label tie the shipment to Mara's project account." },
    { clueId: "C3", strength: "supporting", note: "Shows Mara requested the test, and that nobody authorized it." },
    { clueId: "C4", strength: "exonerating", note: "Independent ledger and footage clear Theo." },
    { clueId: "C6", strength: "exonerating", note: "Camera footage clears Nina." },
    { clueId: "C1", strength: "weak", note: "A badge scan alone does not identify who carried the badge. Suggestive, not proof." },
  ],
  weakEvidenceNote:
    "Weak evidence: a badge assignment shows whose badge was used, not who used it, and a jacket colour proves nothing. The case rests on location (F2 vs the gantry), the courier label and locker, and the exonerating records for the other two suspects.",
};
