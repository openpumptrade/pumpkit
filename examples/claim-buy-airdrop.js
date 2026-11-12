import "dotenv/config";
import { createContext, keypairFromSecret, claimBuyAirdropRound, nextSkipStreaks } from "../src/index.js";

/// TUNGBANK-style: claim creator fees of MINT → buy REWARD_MINT → airdrop it to MINT's holders pro rata.
/// REWARD_MINT=So111...112 (or unset) pays SOL directly. Run once (cron / Railway scheduler) or wrap in createScheduler.
const ctx = createContext();
const wallet = keypairFromSecret(process.env.PRIVATE_KEY);
let skipStreaks = new Map(); // persist this per (wallet, rewardMint) in your DB

const r = await claimBuyAirdropRound(ctx, {
  wallet, mint: process.env.MINT, rewardMint: process.env.REWARD_MINT, dryRun: process.env.DRY_RUN !== "false",
  snapshotOpts: { maxHolders: 4000 },
  airdropOpts: { skipStreaks, ataRentThresholdSol: 0.002, ataSkipGraceCycles: 10, onProgress: (p) => console.log(`  batch ${p.batch}/${p.batches} · paid ${p.paid}`) },
  ledger: { afterAirdrop: (d) => { skipStreaks = nextSkipStreaks(skipStreaks, d.outcomes); } },
});
console.log(r.note, r.txs);
process.exit(0);
