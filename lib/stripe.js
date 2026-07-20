'use strict';

/**
 * Stripe integration for monthly training subscriptions.
 *
 * Configuration (all via environment — never hard-coded):
 *   STRIPE_SECRET_KEY      – sk_test_… or sk_live_…  (required to enable billing)
 *   STRIPE_PRICE_ID        – the recurring (monthly) Price to subscribe clients to
 *   STRIPE_WEBHOOK_SECRET  – whsec_…  signing secret for the webhook endpoint
 *   PUBLIC_BASE_URL        – e.g. https://ekttraining.com  (for success/cancel redirects)
 *
 * If STRIPE_SECRET_KEY is unset, isConfigured() returns false and the booking
 * page shows a "payments not set up yet" message instead of crashing.
 */

const secretKey = process.env.STRIPE_SECRET_KEY || '';
const PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const BASE_URL = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

let stripe = null;
if (secretKey) {
  try {
    // Lazy require so the app still boots if the dependency isn't installed yet.
    const Stripe = require('stripe');
    stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' });
  } catch (err) {
    console.error('[stripe] failed to initialise:', err.message);
    stripe = null;
  }
}

/** Billing is usable only when both a secret key and a price are configured. */
function isConfigured() {
  return Boolean(stripe && PRICE_ID);
}

function client() {
  if (!stripe) throw new Error('Stripe is not configured.');
  return stripe;
}

/** Find or create the Stripe customer for a client, returning the customer id. */
async function ensureCustomer({ email, name, existingId }) {
  if (existingId) return existingId;
  const customer = await client().customers.create({ email, name: name || undefined });
  return customer.id;
}

/**
 * Create a hosted Checkout Session for a monthly subscription.
 * Returns the URL to redirect the client to.
 */
async function createCheckoutSession({ customerId, clientId }) {
  const session = await client().checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    client_reference_id: String(clientId),
    allow_promotion_codes: true,
    success_url: `${BASE_URL}/booking?checkout=success`,
    cancel_url: `${BASE_URL}/booking?checkout=cancelled`,
  });
  return session.url;
}

/** Create a Billing Portal session so a client can manage/cancel their subscription. */
async function createPortalSession({ customerId }) {
  const session = await client().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${BASE_URL}/booking`,
  });
  return session.url;
}

/** Verify a webhook payload's signature and return the parsed event (throws on failure). */
function constructEvent(rawBody, signature) {
  if (!WEBHOOK_SECRET) throw new Error('Webhook secret not configured.');
  return client().webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
}

/** Look up the current status + period end for a subscription id. */
async function getSubscription(subscriptionId) {
  return client().subscriptions.retrieve(subscriptionId);
}

module.exports = {
  isConfigured,
  hasWebhookSecret: () => Boolean(WEBHOOK_SECRET),
  ensureCustomer,
  createCheckoutSession,
  createPortalSession,
  constructEvent,
  getSubscription,
  PRICE_ID,
};
