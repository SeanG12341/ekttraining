'use strict';

/**
 * Transactional email via Resend for the site's contact / booking form.
 *
 * Configuration (all via environment):
 *   RESEND_API_KEY  – your Resend API key (required to actually send)
 *   CONTACT_FROM    – verified "from" address, e.g. "EKT Training <hello@yourdomain.com>"
 *                     Until your domain is verified in Resend you can use the
 *                     sandbox sender "onboarding@resend.dev" (it can only deliver
 *                     to your own Resend account email).
 *   CONTACT_TO      – where enquiries are delivered (the site owner's inbox)
 */

const { Resend } = require('resend');

const apiKey = process.env.RESEND_API_KEY || '';
const FROM = process.env.CONTACT_FROM || 'EKT Training <onboarding@resend.dev>';
const TO = process.env.CONTACT_TO || 'sgivvin@gmail.com';

const resend = apiKey ? new Resend(apiKey) : null;

function isConfigured() {
  return Boolean(resend);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Send a contact-form submission to the site owner.
 * @param {{name:string,email:string,message:string,goal?:string}} input
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
async function sendContactEmail(input) {
  if (!resend) {
    return { ok: false, error: 'Email is not configured on the server.' };
  }

  const name = String(input.name || '').trim();
  const email = String(input.email || '').trim();
  const goal = String(input.goal || '').trim();
  const message = String(input.message || '').trim();

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#111;">
      <h2 style="margin:0 0 12px;">New consultation request</h2>
      <p style="margin:0 0 4px;"><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p style="margin:0 0 4px;"><strong>Email:</strong> ${escapeHtml(email)}</p>
      ${goal ? `<p style="margin:0 0 4px;"><strong>Goal:</strong> ${escapeHtml(goal)}</p>` : ''}
      <p style="margin:12px 0 4px;"><strong>Message:</strong></p>
      <p style="white-space:pre-wrap;margin:0;">${escapeHtml(message)}</p>
    </div>`;

  const text =
    `New consultation request\n\n` +
    `Name: ${name}\nEmail: ${email}\n` +
    (goal ? `Goal: ${goal}\n` : '') +
    `\nMessage:\n${message}\n`;

  // The Resend SDK returns { data, error } and does NOT throw on API errors.
  // A unique idempotency key prevents duplicate sends on client/network retries.
  const idempotencyKey = `contact/${email}/${Date.now()}`.slice(0, 256);

  const { data, error } = await resend.emails.send(
    {
      from: FROM,
      to: [TO],
      replyTo: email, // owner can reply straight to the enquirer
      subject: `New consultation request — ${name || email}`,
      html,
      text,
    },
    { idempotencyKey }
  );

  if (error) {
    console.error('[mailer] Resend error:', error.message || error);
    return { ok: false, error: error.message || 'Email provider rejected the request.' };
  }
  return { ok: true, id: data && data.id };
}

module.exports = { sendContactEmail, isConfigured, FROM, TO };
