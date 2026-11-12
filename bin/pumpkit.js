#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import {
  createContext, keypairFromSecret, getSolBalance, LAMPORTS, PUMP_DECIMALS, WSOL_MINT, lamportsOf,
  mintInfo, tokenBalanceRaw, totalSupply, mintProgramId,
  creatorVaultBalances, claimCreatorFees, readSharingConfig, sharedFeesWaiting, distributeSharedFees, writeFeeSharing,
  buyMeasured, sellAny, burnTokens, transferTokens, sendSol,
  snapshotHolders, topHolders, airdropTokens, airdropSol,
  fetchCoinInfo, loadCurve, isGraduated, getUsdPrice, simulateCreate, uploadIpfs, createCoin,
} from "../src/index.js";

/// pumpkit CLI — the tools from a terminal, for ops and for testing a wallet/coin by hand.
/// Signing commands read PRIVATE_KEY from .env. Amounts in SOL / UI tokens unless the flag says raw.

const [cmd, ...rest] = process.argv.slice(2);
const args = {}; const pos = [];
for (let i = 0; i < rest.length; i++) { const a = rest[i]; if (a.startsWith("--")) { const k = a.slice(2); const v = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true"; args[k] = v; } else pos.push(a); }
const ctx = createContext();
const wallet = () => { if (!process.env.PRIVATE_KEY) throw new Error("PRIVATE_KEY missing in .env"); return keypairFromSecret(process.env.PRIVATE_KEY); };
const yes = () => { if (args.yes !== "true") throw new Error("this moves funds — add --yes"); };
const out = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

const commands = {
  async balance([address]) {
    const a = address || wallet().publicKey.toBase58();
    const o = { address: a, sol: await getSolBalance(ctx, a) };
    if (args.mint) { const info = await mintInfo(ctx, args.mint); o.token = { mint: args.mint, symbol: info.symbol, ui: Number(await tokenBalanceRaw(ctx, { owner: a, mint: args.mint, programId: info.programId })) / 10 ** info.decimals }; }
    out(o);
  },
  async info([mint]) {
    const [m, coin, curve, grad] = await Promise.all([mintInfo(ctx, mint), fetchCoinInfo(ctx, mint).catch((e) => ({ error: e.message })), loadCurve(ctx, mint).catch(() => null), isGraduated(ctx, mint)]);
    out({ ...m, supply: (await totalSupply(ctx, mint)).ui, graduated: grad, creator: curve?.creator, taxBps: curve?.taxBps, market: coin, sharing: await readSharingConfig(ctx, mint).catch(() => null) });
  },
  async price([mint]) { out({ mint, usd: await getUsdPrice(ctx, mint), solUsd: await getUsdPrice(ctx, WSOL_MINT) }); },
  async fees([creator]) {
    const c = creator || wallet().publicKey.toBase58();
    const v = await creatorVaultBalances(ctx, { creator: c });
    out({ creator: c, unclaimedSol: v.sol, sharing: args.mint ? { waitingSol: await sharedFeesWaiting(ctx, args.mint), config: await readSharingConfig(ctx, args.mint) } : undefined });
  },
  async claim() { yes(); const r = await claimCreatorFees(ctx, { wallet: wallet() }); out({ sig: r.sig, claimedSol: Number(r.claimedRaw) / LAMPORTS }); },
  async distribute([mint]) { yes(); out(await distributeSharedFees(ctx, { mint, wallet: wallet() })); },
  async "fee-split"([mint, ...pairs]) {
    yes();
    const shareholders = pairs.map((p) => { const [address, bps] = p.split(":"); return { address, shareBps: Number(bps) }; });
    out(await writeFeeSharing(ctx, { wallet: wallet(), mint, shareholders }));
  },
  async buy([mint, sol]) { yes(); const r = await buyMeasured(ctx, { wallet: wallet(), mint, lamports: lamportsOf(Number(sol)) }); out({ sig: r.sig, venue: r.venue, spentSol: r.spentLamports / LAMPORTS, bought: Number(r.boughtRaw) / 10 ** (Number(args.decimals) || PUMP_DECIMALS) }); },
  async sell([mint, amount]) { yes(); const d = Number(args.decimals) || PUMP_DECIMALS; out(await sellAny(ctx, { wallet: wallet(), mint, tokenAmountRaw: BigInt(Math.floor(Number(amount) * 10 ** d)) })); },
  async burn([mint, amount]) { yes(); const d = Number(args.decimals) || PUMP_DECIMALS; out(await burnTokens(ctx, { wallet: wallet(), mint, amountRaw: BigInt(Math.floor(Number(amount) * 10 ** d)), decimals: d })); },
  async transfer([mint, to, amount]) { yes(); const d = Number(args.decimals) || PUMP_DECIMALS; out(await transferTokens(ctx, { wallet: wallet(), mint, to, amountRaw: BigInt(Math.floor(Number(amount) * 10 ** d)), decimals: d })); },
  async "send-sol"([to, sol]) { yes(); out({ sig: await sendSol(ctx, { wallet: wallet(), to, lamports: lamportsOf(Number(sol)) }) }); },
  async holders([mint]) {
    const exclude = (args.exclude || "").split(",").filter(Boolean);
    const s = await snapshotHolders(ctx, { mint, exclude, minRaw: BigInt(Math.floor(Number(args.min || 0) * 1e6)), maxHolders: Number(args.limit || Infinity) });
    out({ holders: s.holders.length, accounts: s.accounts, eligible: Number(s.eligibleRaw) / 1e6, top: s.holders.slice(0, Number(args.top || 20)).map((h) => ({ wallet: h.wallet, ui: Number(h.raw) / 1e6 })) });
  },
  async top([mint]) { out(await topHolders(ctx, { mint, limit: Number(args.limit || 20) })); },
  /// airdrop <holdersOfMint> --reward <mint> --amount <ui> | --sol <sol>
  async airdrop([holdersOf]) {
    yes();
    const w = wallet();
    const snap = await snapshotHolders(ctx, { mint: holdersOf, exclude: [w.publicKey.toBase58(), ...(args.exclude || "").split(",").filter(Boolean)], maxHolders: Number(args.limit || 4000) });
    if (args.sol) return out(await airdropSol(ctx, { wallet: w, lamports: lamportsOf(Number(args.sol)), holders: snap.holders, eligibleRaw: snap.eligibleRaw }));
    const info = await mintInfo(ctx, args.reward);
    const r = await airdropTokens(ctx, { wallet: w, mint: args.reward, amountRaw: BigInt(Math.floor(Number(args.amount) * 10 ** info.decimals)), holders: snap.holders, eligibleRaw: snap.eligibleRaw, decimals: info.decimals, programId: info.programId, transferHook: info.transferHook, valueSol: Number(args.value || 0) });
    out({ paid: r.paid, skipped: r.skipped, failed: r.failed, txs: r.txs });
  },
  async "simulate-create"([name, symbol]) { out(await simulateCreate(ctx, { name, symbol, payer: args.payer || wallet().publicKey })); },
  /// create <name> <symbol> --image ./x.png [--description ..] [--twitter ..] [--telegram ..] [--website ..] [--dev-buy 0.1] [--dev-to <wallet>]
  async create([name, symbol]) {
    yes();
    const w = wallet();
    const { metadataUri } = await uploadIpfs({ name, symbol, description: args.description, imageBuffer: readFileSync(args.image), twitter: args.twitter, telegram: args.telegram, website: args.website });
    out(await createCoin(ctx, { wallet: w, name, symbol, uri: metadataUri, devBuyLamports: lamportsOf(Number(args["dev-buy"] || 0)), devBuyTo: args["dev-to"] }));
  },
  async program([mint]) { out({ mint, program: (await mintProgramId(ctx, mint)).toBase58() }); },
};

if (!cmd || !commands[cmd]) {
  console.log(`pumpkit <command> [args] [--flags]\n\nread-only:\n  balance [address] [--mint M]      info <mint>        price <mint>      program <mint>\n  fees [creator] [--mint M]         holders <mint> [--exclude a,b --min 1000 --limit 4000 --top 20]\n  top <mint> [--limit 20]           simulate-create <name> <symbol> [--payer P]\n\nsigning (PRIVATE_KEY in .env, --yes required):\n  claim                             distribute <mint>  fee-split <mint> <addr:bps> <addr:bps>\n  buy <mint> <sol>                  sell <mint> <ui> [--decimals 6]      burn <mint> <ui>\n  transfer <mint> <to> <ui>         send-sol <to> <sol>\n  airdrop <holdersOfMint> (--reward <mint> --amount <ui> [--value <sol>] | --sol <sol>) [--exclude a,b --limit 4000]\n  create <name> <symbol> --image x.png [--description ..] [--dev-buy 0.1 --dev-to <wallet>]`);
  process.exit(cmd ? 1 : 0);
}
commands[cmd](pos).then(() => process.exit(0)).catch((e) => { console.error("error:", e.message); process.exit(1); });
