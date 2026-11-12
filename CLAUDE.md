# pumpkit — notes for Claude Code sessions

This is the shared toolkit behind our pump.fun / Solana launches. Projects copy `src/` (or depend on the repo)
instead of re-implementing claims, buys, burns, airdrops and launches. Read `README.md` for the module map.

## Conventions
- Plain ESM JS, no build, no TypeScript. One module per concern under `src/`, pump.fun-specific ones under `src/pumpfun/`.
- Every function takes `ctx` (from `createContext`) first, then an options object. No module reads `process.env`
  or holds global config — that is the whole point of the extraction.
- Amounts are `bigint` raw units at the boundary (`amountRaw`, `lamports`); SOL floats only in logs/notes.
- Nothing DB-specific: tools return per-wallet outcomes / deltas and the caller persists them. `engine.js` exposes
  `ledger.after*` hooks for crash-safe bookkeeping instead of writing rows.
- No `burnAll` / `sellAll` / `sweep everything` helpers for tokens. Measure before/after (`buyMeasured`) and act on the delta.
- Keep the gotchas list in `README.md` current; each one cost real money or a production incident.

## Testing
- `npm run check` — every module imports.
- `npm run smoke` — read-only mainnet checks, no keys (uses PUMPFOLIO `BsgT…5TQE`, a coin with a fee-sharing config).
  publicnode refuses "indexed" RPC calls (getTokenSupply, getTokenLargestAccounts, getProgramAccounts) → those go
  through `ctx.snapshotConnection` (SNAPSHOT_RPC_URL). `.env` is gitignored; copy `.env.example`.
- Anything that signs is tested by hand with `bin/pumpkit.js … --yes` on a throwaway wallet and tiny amounts.

## This repo is public
Only tools, examples and gotchas live here. No internal reports, project lists or lessons: those are kept elsewhere
and nothing from them is copied in.

## When a production engine fixes a bug in a copied function
Port the fix here first, then to the other copies. Note it in the README gotchas if it is a new class of bug.
