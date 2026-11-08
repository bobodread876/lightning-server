// LNURL-pay callback (LUD-06). Invoices come from phoenixd over its HTTP API.
//
// Environment:
//   PHOENIXD_URL       base URL of the phoenixd API, e.g. https://phoenixd.example.com
//   PHOENIXD_PASSWORD  phoenixd's http-password-limited-access (can create invoices and
//                      read incoming payments, cannot pay or move funds)
//   DOMAIN, META, NOSTR_PRIVATE_KEY as before.

import { getEventHash, getSignature, finishEvent, relayInit } from 'nostr-tools';
import crypto from 'crypto';
import 'websocket-polyfill';
import { NextResponse } from 'next/server';

const relays = [
  "wss://relay.damus.io",
  "wss://nostr.mutinywallet.com",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://nostr.fmt.wiz.biz",
  "wss://relay.nostr.bg",
  "wss://nostr.oxtr.dev",
];

const ZAP_TIMEOUT = 300000; // wait up to 5 minutes for a zap to be paid
const ZAP_POLL = 2000;      // poll phoenixd every 2 seconds
const DEFAULT_PRIVATE_KEY = "6be6e45ea4eb02d3cc9cda30771281ceb92aa8b972bbea50243d269919979b1e";
const NOSTR_PRIVATE_KEY = process.env.NOSTR_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function phoenixd(path, options = {}) {
  const base = (process.env.PHOENIXD_URL || '').replace(/\/$/, '');
  const password = process.env.PHOENIXD_PASSWORD || '';
  if (!base || !password)
    throw new Error('PHOENIXD_URL and PHOENIXD_PASSWORD must be set');
  const auth = 'Basic ' + Buffer.from(`:${password}`).toString('base64');
  return fetch(`${base}${path}`, {
    ...options,
    headers: { Authorization: auth, ...(options.headers || {}) },
    signal: AbortSignal.timeout(15000),
  });
}

// Ask phoenixd for a BOLT11 invoice. amountMsat is what the wallet sent (LUD-06 is in
// millisats); phoenixd takes whole sats, so round up and never go below 1 sat.
async function createInvoice({ amountMsat, descriptionHash, externalId }) {
  const amountSat = Math.max(1, Math.ceil(amountMsat / 1000));
  const body = new URLSearchParams({ amountSat: String(amountSat), descriptionHash, externalId });
  const res = await phoenixd('/createinvoice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok)
    throw new Error(`phoenixd createinvoice returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (!data.serialized || !data.paymentHash)
    throw new Error(`phoenixd createinvoice returned no invoice: ${JSON.stringify(data).slice(0, 200)}`);
  return { bolt11: data.serialized, paymentHash: data.paymentHash };
}

// True once phoenixd has received the payment.
async function isPaid(paymentHash) {
  const res = await phoenixd(`/payments/incoming/${paymentHash}`);
  if (!res.ok) return false;
  const p = await res.json();
  return Boolean(p.isPaid || p.completedAt || (Number(p.receivedSat) > 0));
}

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function zapReceipt(data) {
  const note = JSON.parse(data.description);
  const e = note.tags.find(tag => tag[0] === 'e')?.[1];
  const p = note.tags.find(tag => tag[0] === 'p')?.[1];
  if (!p) return;

  let zap = {
    content: '',
    kind: 9735,
    pubkey: note.pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["bolt11", data.bolt11],
      ["description", data.description],
      ["p", p],
    ]
  };
  if (e) zap.tags.push(["e", e]);
  zap.id = getEventHash(zap);
  zap.sig = getSignature(zap, NOSTR_PRIVATE_KEY);
  const signedEvent = finishEvent(zap, NOSTR_PRIVATE_KEY);

  let isPublished = false;
  for (let relayUrl of relays) {
    try {
      let relay = relayInit(relayUrl);
      await relay.connect();
      await relay.publish(signedEvent);
      console.log(`Published zap receipt to ${relayUrl}`);
      isPublished = true;
      relay.close();
    } catch (error) {
      console.error(`Failed to publish to ${relayUrl}:`, error?.message || error);
    }
  }
  if (!isPublished) console.log('Could not publish the zap receipt to any relay.');
}

// Poll phoenixd until the zap invoice is paid, then publish the receipt.
async function checkZap(bolt11, paymentHash, zap) {
  const started = Date.now();
  console.log('Zap invoice created. Waiting for payment...');
  while (true) {
    await pause(ZAP_POLL);
    try {
      if (await isPaid(paymentHash)) break;
    } catch (error) {
      console.error('Error checking zap payment:', error?.message || error);
    }
    if (Date.now() - started > ZAP_TIMEOUT) {
      console.log('Zap not paid in time.');
      return false;
    }
  }
  await zapReceipt({ bolt11, description: zap });
  console.log('Nostr zap receipt published.');
  return true;
}

function lnurlError(reason, status = 200) {
  // LUD-06: errors are { status: "ERROR", reason }
  return NextResponse.json({ status: 'ERROR', reason }, { status, headers });
}

export async function GET(req, { params }) {
  const startTime = Date.now();
  console.log('Welcome to getInvoice.js');

  const url = new URL(req.url);
  const amountParam = url.searchParams.get('amount');
  if (amountParam === null || amountParam.trim() === '')
    return lnurlError('No amount was provided.');
  const amount = Number(amountParam);
  if (!Number.isFinite(amount) || amount < 1000)
    return lnurlError('Invalid amount provided.');

  const user = (params.user || 'none').toLowerCase();
  const address = `${user}@${process.env.DOMAIN}`;
  const zap = url.searchParams.get('nostr');

  try {
    // Nostr zap: the description hash commits to the zap request
    if (zap) {
      const { bolt11, paymentHash } = await createInvoice({
        amountMsat: amount,
        descriptionHash: sha256(zap),
        externalId: `zap:${user}`,
      });
      console.log(`Created a zap invoice for ${address} in ${Date.now() - startTime} ms.`);
      checkZap(bolt11, paymentHash, zap); // runs on, not awaited
      return NextResponse.json({ pr: bolt11, routes: [] }, { headers });
    }

    // Plain Lightning address payment: hash the same metadata lnurlp served
    const meta = process.env.META || `Pay to ${address}`;
    const metadata = JSON.stringify([["text/plain", meta], ["text/identifier", address]]);
    const comment = (url.searchParams.get('comment') || '').slice(0, 32);
    const { bolt11 } = await createInvoice({
      amountMsat: amount,
      descriptionHash: sha256(metadata),
      externalId: comment ? `${address} | ${comment}` : address,
    });
    console.log(`Created an invoice for ${address} in ${Date.now() - startTime} ms.`);
    return NextResponse.json({ pr: bolt11, routes: [] }, { headers });
  } catch (error) {
    console.error('Invoice creation failed:', error?.message || error);
    return lnurlError('Could not create an invoice right now. Please try again.');
  }
}
