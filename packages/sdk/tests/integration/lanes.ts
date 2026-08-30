/** BAND_E2E_LANE registry for live integration scripts. Single lane ("core") today. */
export type Lane = "core";

const KNOWN_LANES: readonly Lane[] = ["core"];

/** Unset or "all" runs everything; a specific lane name runs only itself. */
export function shouldRunLane(lane: Lane): boolean {
  const requested = process.env.BAND_E2E_LANE;
  if (!requested || requested === "all") {
    return true;
  }

  if (!(KNOWN_LANES as readonly string[]).includes(requested)) {
    console.log(
      `lanes BAND_E2E_LANE=${requested} is not a known lane (${KNOWN_LANES.join(", ")}) — skipping lane "${lane}"`,
    );
    return false;
  }

  if (requested !== lane) {
    console.log(`lanes BAND_E2E_LANE=${requested} does not match lane "${lane}" — skipping`);
    return false;
  }

  return true;
}
