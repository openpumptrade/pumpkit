import "dotenv/config";
import express from "express";
import { PublicKey } from "@solana/web3.js";
import { createContext, uploadIpfs, buildLaunchTxs, relaySigned, fetchTransaction, balanceDelta, loadCurve, lamportsOf } from "../src/index.js";

/// The PUMPDRAW / THE KITCHEN launch, server side: the browser generates the MINT keypair and sends only its
/// pubkey; we pin metadata, build [fee → treasury, create_v2 (creator = user), dev buy] UNSIGNED, the browser
/// verifies the bytes with pumpkit/pumpfun/verify before the wallet signs, and we only relay + prove the fee on
/// chain. The server holds no private key. (`npm i express` to run this example.)
const ctx = createContext();
const TREASURY = process.env.TREASURY_ADDRESS;
const FEE = lamportsOf(Number(process.env.LAUNCH_FEE_SOL || 0.02));
const app = express().use(express.json({ limit: "5mb" }));

app.post("/api/launch/prepare", async (req, res) => {
  try {
    const { wallet, mint, name, symbol, description, image, devBuySol = 0, twitter, telegram, website } = req.body;
    new PublicKey(wallet); new PublicKey(mint);
    const imageBuffer = Buffer.from(String(image).replace(/^data:image\/\w+;base64,/, ""), "base64");
    const { metadataUri } = await uploadIpfs({ name, symbol, description, imageBuffer, twitter, telegram, website });
    const built = await buildLaunchTxs(ctx, { user: wallet, mint, name, symbol, uri: metadataUri, devBuyLamports: lamportsOf(Number(devBuySol)), feeLamports: Number(FEE), treasury: TREASURY });
    res.json({ txs: built.base64, lastValidBlockHeight: built.lastValidBlockHeight, expect: { treasury: TREASURY, feeLamports: Number(FEE), mint, creator: wallet, name, symbol, devBuyLamports: lamportsOf(Number(devBuySol)).toString(), slippagePct: ctx.slippagePct } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/launch/submit", async (req, res) => {
  try {
    const { txs, lastValidBlockHeight, mint, creator } = req.body;
    const r1 = await relaySigned(ctx, txs[0], lastValidBlockHeight);
    if (!r1.ok) return res.status(400).json({ error: r1.error, signature: r1.sig, pending: r1.pending });
    const tx = await fetchTransaction(ctx, r1.sig);
    const feeOk = tx && balanceDelta(tx, TREASURY) >= Number(FEE);
    const creatorOk = (await loadCurve(ctx, mint).catch(() => null))?.creator === creator;
    let devBuy = null;
    if (txs[1]) devBuy = await relaySigned(ctx, txs[1], lastValidBlockHeight);
    res.json({ status: feeOk ? "live" : "failed", signature: r1.sig, feeOk, creatorOk, devBuy });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.listen(process.env.PORT || 4000, () => console.log("launch server on", process.env.PORT || 4000));
