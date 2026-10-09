// GENERATED FILE - a byte-for-byte copy of the engine module www/js/core/clock.js for the SDK package.
// Edit the source under www/js and regenerate the mirror; a drift guard reddens on any difference.
// Everything below this header is identical to the source.

// Demo sim-clock.
//
// Idea: real time is compressed by the speed multiplier. speed=60 means one
// real second equals one sim-minute. All swap timings live in sim-time,
// so the demo can be shown fast, while at speed=1 it runs at real pace
// (20-40 minutes per swap, as in the litepaper).
//
// swap.realStart    - Date.now() at the moment the swap was created
// swap.simStartWall - the demo's wall time at that same moment (for UTC display)
// simElapsed(swap) = (Date.now() - realStart) * speed

export function nowReal() {
  return Date.now();
}

export function simElapsed(swap, now = nowReal()) {
  return Math.max(0, (now - swap.realStart) * swap.speed);
}

// The demo's wall time at the moment when simMs of sim-time has passed since the swap started.
export function simWall(swap, simMs) {
  return swap.simStartWall + simMs;
}



// Rescale the base point when the speed changes: sim-progress is preserved,
// after that the swap runs at the new speed.
export function rescaleStart(swap, newSpeed, now = nowReal()) {
  const elapsed = simElapsed(swap, now);
  swap.speed = newSpeed;
  swap.realStart = now - elapsed / newSpeed;
  return swap;
}

