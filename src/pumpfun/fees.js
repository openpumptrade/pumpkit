import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { LAMPORTS, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK, canonicalPumpPoolPda, feeSharingConfigPda, pk, sleep } from "../context.js";
import { sendTx } from "../tx.js";
import { SOL_QUOTE } from "./curve.js";

/// Creator fees: what is waiting in the vaults, claiming it, and the on-chain fee-sharing split.

function vaultPdas(creatorPk) {
  const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creatorPk.toBuffer()], PUMP_PROGRAM_ID);
  const [ammVaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), creatorPk.toBuffer()], PUMP_AMM_PROGRAM_ID);
  return { creatorVault, ammVaultAuth };
}

/// Unclaimed creator fees for `creator` in the quote asset — bonding-curve vault + PumpSwap vault, raw units.
export async function creatorVaultBalances(ctx, { creator, quote = SOL_QUOTE }) {
  const creatorPk = pk(creator);
  if (quote.isSol) {
    const total = BigInt((await ctx.online.getCreatorVaultBalanceBothPrograms(creatorPk)).toString());
    return { bonding: total, amm: 0n, total, sol: Number(total) / LAMPORTS };
  }
  const quoteMint = pk(quote.mint);
  const { creatorVault, ammVaultAuth } = vaultPdas(creatorPk);
  const read = async (owner) => { try { return BigInt((await ctx.connection.getTokenAccountBalance(getAssociatedTokenAddressSync(quoteMint, owner, true, quote.tokenProgram))).value.amount); } catch { return 0n; } };
  const [bonding, amm] = await Promise.all([read(creatorVault), read(ammVaultAuth)]);
  return { bonding, amm, total: bonding + amm, sol: null };
}

/// Instructions that move every unclaimed creator fee into the creator's wallet (SOL) / quote ATA (custom pair).
export async function claimInstructions(ctx, { creator, quote = SOL_QUOTE, feePayer }) {
  const creatorPk = pk(creator);
  const payer = feePayer ? pk(feePayer) : creatorPk;
  if (quote.isSol) return ctx.online.collectCoinCreatorFeeInstructions(creatorPk, payer);
  const quoteMint = pk(quote.mint);
  const ata = getAssociatedTokenAddressSync(quoteMint, creatorPk, false, quote.tokenProgram);
  const claimable = await creatorVaultBalances(ctx, { creator, quote });
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(payer, ata, creatorPk, quoteMint, quote.tokenProgram)];
  if (claimable.total > 0n) ixs.push(...(await ctx.online.collectCoinCreatorFeeV2Instructions(creatorPk, quoteMint, quote.tokenProgram, payer)));
  return ixs;
}

/// Claim the creator fees of `wallet` (the coin's creator). Returns the tx and how much SOL actually landed.
export async function claimCreatorFees(ctx, { wallet, quote = SOL_QUOTE, minLamports = 0n, mint = null }) {
  const me = wallet.publicKey;
  const claimable = await creatorVaultBalances(ctx, { creator: me, quote });
  // + the pool bucket of `mint` (v2 pools), swept in the same transaction when the wallet is that pool's coin creator
  const sw = mint && quote.isSol ? await sweepCreatorFeeIx(ctx, { payer: me, mint }).catch(() => null) : null;
  const bucket = sw && sw.pool.coinCreator.equals(me) ? await poolCreatorFeeBucket(ctx, mint).catch(() => 0n) : 0n;
  claimable.bucket = bucket; claimable.total += bucket;
  if (claimable.total <= BigInt(minLamports)) return { sig: "", claimedRaw: 0n, claimable };
  const instructions = await claimInstructions(ctx, { creator: me, quote });
  if (bucket > 0n) instructions.unshift(sw.ix);
  if (!instructions.length) return { sig: "", claimedRaw: 0n, claimable };
  const before = quote.isSol ? await ctx.connection.getBalance(me) : null;
  const sig = await sendTx(ctx, { instructions, payer: me, signers: [wallet], computeUnits: 200_000 });
  let claimedRaw = claimable.total;
  if (quote.isSol) { await sleep(1000); claimedRaw = BigInt(Math.max(0, (await ctx.connection.getBalance(me)) - before)); }
  return { sig, claimedRaw, claimable };
}

/// pump-amm `sweep_creator_fee` (newer than our pinned SDK, built raw from its IDL): moves the pool's accrued
/// `creatorFees` bucket into the coin creator's AMM vault. Permissionless. The programs refuse to change a coin
/// creator / its fee shares while the bucket is nonzero (6081 CreatorFeesNotSwept), so it goes FIRST in the
/// fee-sharing transaction.
export async function sweepCreatorFeeIx(ctx, { payer, mint }) {
  const poolKey = canonicalPumpPoolPda(pk(mint));
  const pool = await ctx.amm.fetchPool(poolKey).catch(() => null);
  if (!pool) return null;                                   // still on the curve: nothing to sweep
  const quote = pool.quoteMint, tokenProgram = TOKEN_PROGRAM_ID;
  if (!quote.equals(NATIVE_MINT)) throw new Error("sweepCreatorFeeIx: SOL-quoted pools only");
  const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMP_AMM_PROGRAM_ID);
  const [recipient] = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), pool.coinCreator.toBuffer()], PUMP_AMM_PROGRAM_ID);
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_AMM_PROGRAM_ID);
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: globalConfig, isSigner: false, isWritable: false },
    { pubkey: poolKey, isSigner: false, isWritable: true },
    { pubkey: quote, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: pool.poolQuoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: false },
    { pubkey: getAssociatedTokenAddressSync(quote, recipient, true, tokenProgram), isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return { ix: new TransactionInstruction({ programId: PUMP_AMM_PROGRAM_ID, keys, data: Buffer.from([32, 246, 191, 52, 8, 201, 73, 186]) }), pool, poolKey };
}


/// The pool's accrued creator-fee bucket (`Pool.creatorFees`, u64 at byte 279 since the v2 pools — newer than our
/// pinned SDK's decoder). Raw quote units; 0n when the coin has no pool yet.
export async function poolCreatorFeeBucket(ctx, mint) {
  const info = await ctx.connection.getAccountInfo(canonicalPumpPoolPda(pk(mint)));
  if (!info || info.data.length < 287) return 0n;
  return info.data.readBigUInt64LE(279);
}
// ---------------------------------------------------------------- fee sharing (immutable splits)
/// Instructions that write the fee split on chain, once: create the sharing config for `mint` (payer = the
/// coin's creator) and set the final shareholders. pump.fun locks the config after `updateFeeShares`, so
/// nobody — not even the creator — can ever point the fees anywhere else. shareBps must add up to 10000.
export async function feeSharingInstructions(ctx, { mint, creator, shareholders, pool = null, claimFirst = false, prepend = [] }) {
  const mintPk = pk(mint), creatorPk = pk(creator);
  const total = shareholders.reduce((s, x) => s + x.shareBps, 0);
  if (total !== 10_000) throw new Error(`shareBps add up to ${total} — must be 10000`);
  // a graduated coin's pool refuses to change coin creator while fees sit in the creator's AMM vault
  // (CreatorFeesNotSwept) — and fees land there on every swap, so claim in the SAME transaction
  const claimIxs = claimFirst ? await claimInstructions(ctx, { creator: creatorPk }) : [];
  // `pool` = the canonical PumpSwap pool once the coin graduated (its coin_creator is read from there), null on a curve
  const createIx = await ctx.sdk.createFeeSharingConfig({ creator: creatorPk, mint: mintPk, pool: pool ? pk(pool) : null });
  const updateIx = await ctx.sdk.updateFeeShares({ authority: creatorPk, mint: mintPk, currentShareholders: [creatorPk], newShareholders: shareholders.map((s) => ({ address: pk(s.address), shareBps: s.shareBps })) });
  // graduated coin: the program now wants the canonical pool as the last remaining account (newer SDKs add it)
  if (pool) updateIx.keys.push({ pubkey: pk(pool), isSigner: false, isWritable: false });
  return { instructions: [...prepend, ...claimIxs, createIx, updateIx], sharingConfig: feeSharingConfigPda(mintPk).toBase58() };
}

export async function writeFeeSharing(ctx, { wallet, mint, shareholders, pool = null, claimFirst = false, prepend = [] }) {
  const { instructions, sharingConfig } = await feeSharingInstructions(ctx, { mint, creator: wallet.publicKey, shareholders, pool, claimFirst, prepend });
  const sig = await sendTx(ctx, { instructions, payer: wallet.publicKey, signers: [wallet], computeUnits: 400_000 });
  return { sig, sharingConfig };
}

/// The on-chain sharing config of a coin, or null when it still has a plain creator.
export async function readSharingConfig(ctx, mint) {
  const pda = feeSharingConfigPda(pk(mint));
  const info = await ctx.connection.getAccountInfo(pda);
  if (!info) return null;
  const cfg = PUMP_SDK.decodeSharingConfig(info);
  return { address: pda.toBase58(), version: Number(cfg.version ?? 0), admin: cfg.admin?.toBase58?.() || "", adminRevoked: Boolean(cfg.adminRevoked), editable: Number(cfg.version ?? 0) >= 2 && !cfg.adminRevoked, shareholders: (cfg.shareholders || []).map((s) => ({ address: s.address.toBase58(), shareBps: Number(s.shareBps?.toString?.() ?? s.shareBps) })) };
}

/// Fees waiting in a fee-sharing coin's vaults (curve + PumpSwap), in SOL.
export async function sharedFeesWaiting(ctx, mint) {
  const bn = await ctx.online.getCreatorVaultBalanceBothPrograms(feeSharingConfigPda(pk(mint)));
  const bucket = await poolCreatorFeeBucket(ctx, mint).catch(() => 0n);
  return (Number(bn.toString()) + Number(bucket)) / LAMPORTS;
}

/// Permissionless: move every fee in the vaults to the shareholders. Any funded wallet can pay for it.
export async function distributeSharedFees(ctx, { mint, wallet }) {
  const me = wallet.publicKey;
  const before = await ctx.connection.getBalance(me);
  const { instructions } = await ctx.online.buildDistributeCreatorFeesInstructions(pk(mint), { payer: me });
  // v2 pools park creator fees in the pool itself until swept — sweep first (permissionless) so the distribution
  // carries them; without it the bucket just grows (6.3 SOL sat there unclaimed on $SLINGFOLIO before we noticed)
  const sw = await sweepCreatorFeeIx(ctx, { payer: me, mint }).catch(() => null);
  if (sw) instructions.unshift(sw.ix);
  const sig = await sendTx(ctx, { instructions, payer: me, signers: [wallet], computeUnits: 400_000 });
  await sleep(1200);
  const after = await ctx.connection.getBalance(me);
  return { sig, gainedSol: Math.max(0, (after - before) / LAMPORTS) };
}
