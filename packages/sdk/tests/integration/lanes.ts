/**
 * Minimal BAND_E2E_LANE registry for live integration scripts.
 *
 * band-sdk-python needed many lanes (`Lane.CORE`/`CREWAI`/`BACKENDS`/...)
 * because conflicting per-framework Python dependency trees forced separate
 * venvs. TS's adapters coexist fine in one node_modules, so there is no
 * forcing function for more than one lane yet — this starts with just
 * "core" (band-sdk-core-driven behavior: retry, participant roster,
 * redelivery), structured so a later ticket (e.g. a TS adapter-capability
 * matrix) can add lanes here without reworking this mechanism.
 */
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
