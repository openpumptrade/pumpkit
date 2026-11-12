import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import {
  createContext, pumpGlobals, taxConfig, mintInfo, mintProgramId, totalSupply, loadCurve, isGraduated, fetchCoinInfo, fetchMarkets,
  getUsdPrice, WSOL_MINT, PUMP_MINT, creatorVaultBalances, readSharingConfig, sharedFeesWaiting, estimateCurveBuy, topHolders, simulateCreate, newWallet,
  encryptSecret, decryptSecret, proRata, verify, buildLaunchTxs, SYMBOL_MAX_BYTES, lamportsOf,
} from "../src/index.js";

/// Read-only smoke test against mainnet: no keys, nothing moves. `node scripts/smoke.js [mint]`
// PUMPFOLIO — a real pump.fun coin of ours with an on-chain fee-sharing split (90/10), so every read path lights up.
// $PUMP itself is NOT a bonding-curve coin (isGraduated → null), which is also worth seeing: pass it as argv[2].
const mint = process.argv[2] || "BsgT63YAr4bM9BwdnMLXVrVmpTPrGiAJWXhqRzU35TQE";
const ctx = createContext();
const step = async (name, fn) => { const t = Date.now(); try { const r = await fn(); console.log(`✓ ${name} (${Date.now() - t} ms)`, typeof r === "string" ? r : ""); return r; } catch (e) { console.log(`✗ ${name}: ${e.message.split("\n")[0]}`); return null; } };

const { global } = await step("pumpGlobals", () => pumpGlobals(ctx));
await step("taxConfig", async () => JSON.stringify(await taxConfig(ctx)));
await step("mintInfo", async () => { const m = await mintInfo(ctx, mint); return `${m.symbol} · ${m.is2022 ? "Token-2022" : "SPL"} · ${m.decimals} dec · hook ${m.transferHook}`; });
await step("mintProgramId cached", async () => (await mintProgramId(ctx, mint)).toBase58());
await step("totalSupply", async () => String((await totalSupply(ctx, mint)).ui));
await step("isGraduated", async () => String(await isGraduated(ctx, mint)));
const curve = await step("loadCurve", async () => { const c = await loadCurve(ctx, mint); return `creator ${c.creator.slice(0, 6)}… complete ${c.complete} tax ${c.taxBps}`; });
await step("fetchCoinInfo (DexScreener fallback)", async () => { const c = await fetchCoinInfo(ctx, mint); return `${c.symbol} $${c.price_usd} via ${c.source}`; });
await step("fetchMarkets", async () => JSON.stringify((await fetchMarkets(ctx, [mint]))[mint]));
await step("getUsdPrice SOL", async () => String(await getUsdPrice(ctx, WSOL_MINT)));
await step("creatorVaultBalances (random wallet → 0)", async () => String((await creatorVaultBalances(ctx, { creator: Keypair.generate().publicKey })).sol));
await step("readSharingConfig", async () => JSON.stringify(await readSharingConfig(ctx, mint)));
await step("sharedFeesWaiting", async () => `${await sharedFeesWaiting(ctx, mint)} SOL`);
await step("PUMP_MINT is not a curve coin (isGraduated → null)", async () => String(await isGraduated(ctx, PUMP_MINT)));
await step("estimateCurveBuy (null when graduated)", async () => JSON.stringify(await estimateCurveBuy(ctx, { mint, quoteAmountRaw: 10_000_000n }), (_, v) => (typeof v === "bigint" ? v.toString() : v)));
await step("topHolders", async () => `${(await topHolders(ctx, { mint, limit: 5 })).length} wallets`);
// a free simulation still needs a FUNDED payer (a random key → AccountNotFound): pump.fun's own fee recipient is public and loaded
const payer = global?.feeRecipient || Keypair.generate().publicKey;
await step(`simulateCreate (${SYMBOL_MAX_BYTES}-byte ticker ok)`, async () => { const r = await simulateCreate(ctx, { name: "pumpkit test", symbol: "A".repeat(SYMBOL_MAX_BYTES), payer }); return `ok=${r.ok} ${r.error || ""} ${r.units} CU ${r.bytes}b`; });
await step("simulateCreate (14-byte ticker refused)", async () => { try { await simulateCreate(ctx, { name: "x", symbol: "A".repeat(14), payer }); return "NOT refused"; } catch (e) { return `refused locally: ${e.message}`; } });
await step("buildLaunchTxs (trustless, unsigned) + verify", async () => {
  const user = Keypair.generate().publicKey, m = Keypair.generate().publicKey, treasury = Keypair.generate().publicKey;
  const b = await buildLaunchTxs(ctx, { user, mint: m, name: "pumpkit", symbol: "PKIT", uri: "https://x/y.json", devBuyLamports: lamportsOf(0.05), feeLamports: 20_000_000, treasury });
  const checks = await verify.verifyLaunch(ctx.connection, b.txs, "", { wallet: user.toBase58(), mint: m.toBase58(), treasury: treasury.toBase58(), feeLamports: 20_000_000, name: "pumpkit", symbol: "PKIT", devBuyLamports: lamportsOf(0.05), slippagePct: ctx.slippagePct });
  return `${b.txs.length} tx (split ${b.split}) · checks: ${checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.label}`).join(" · ")}`;
});
await step("encrypt/decrypt secret", () => { const key = "ab".repeat(32); const w = newWallet(); const enc = encryptSecret(w.secret, key); return decryptSecret(enc, key) === w.secret ? "roundtrip ok" : "MISMATCH"; });
await step("proRata", () => { const s = proRata([{ wallet: "a", raw: 300n }, { wallet: "b", raw: 100n }], 1_000_000n); return `${s[0].amountRaw}/${s[1].amountRaw}`; });
console.log("done");
process.exit(0);
