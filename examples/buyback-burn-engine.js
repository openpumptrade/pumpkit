import "dotenv/config";
import { createContext, keypairFromSecret, createScheduler, buybackBurnRound } from "../src/index.js";

/// A minimal BLAST-style engine: every 10 min, claim creator fees → one buy of MINT → burn the delta.
/// Persist `burnOwedRaw` / `carrySol` in your DB between rounds (here: memory) so a crash never loses track.
const ctx = createContext();
const wallet = keypairFromSecret(process.env.PRIVATE_KEY);
const MINT = process.env.MINT;
const DRY = process.env.DRY_RUN !== "false";
const state = { burnOwedRaw: 0n, carrySol: 0 };

const scheduler = createScheduler({
  intervalSec: Number(process.env.CYCLE_INTERVAL_SEC || 600),
  run: async (cycle) => {
    console.log(`⚙ cycle #${cycle}`);
    const r = await buybackBurnRound(ctx, {
      wallet, mint: MINT, dryRun: DRY, burnOwedRaw: state.burnOwedRaw, carrySol: state.carrySol,
      ledger: {
        afterBuy: ({ boughtRaw, sig }) => { state.burnOwedRaw += boughtRaw; console.log("  bought", boughtRaw.toString(), sig); },
        afterBurn: ({ burnedRaw, sig }) => { state.burnOwedRaw -= burnedRaw; console.log("  burned", burnedRaw.toString(), sig); },
      },
    });
    console.log(" ", r.note);
  },
});
console.log(`engine on ${MINT} · ${DRY ? "DRY RUN" : "LIVE"} · next ${new Date(scheduler.start() * 1000).toISOString()}`);
