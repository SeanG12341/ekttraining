'use strict';

/**
 * Pure booking / availability logic.
 *
 * Slots are identified by a local "wall-clock" key in the business timezone,
 * formatted as `YYYY-MM-DDTHH:mm` (e.g. "2026-07-21T09:00"). We deliberately
 * avoid UTC/offset math so there are no daylight-saving edge cases: the trainer
 * publishes availability in local time, clients see it in local time, and the
 * timezone is shown as a label. The database's UNIQUE index on the slot key is
 * what guarantees a slot can never be double-booked.
 */

// Session length in minutes (display only — the slot key is the source of truth).
const SESSION_MINUTES = 60;

/**
 * Weekly availability template. Keys are JS day numbers (0 = Sunday … 6 = Saturday).
 * Each value is the list of session start times (local, 24h "HH:mm") offered that day.
 * An empty/absent day means the trainer is closed.
 *
 * These are sensible defaults for a single trainer; they can be overridden at
 * runtime with the AVAILABILITY_JSON environment variable (same shape).
 */
const DEFAULT_AVAILABILITY = {
  0: [],                                                        // Sunday — closed
  1: ['06:00', '07:00', '08:00', '12:00', '17:00', '18:00', '19:00'], // Monday
  2: ['06:00', '07:00', '08:00', '12:00', '17:00', '18:00', '19:00'], // Tuesday
  3: ['06:00', '07:00', '08:00', '12:00', '17:00', '18:00', '19:00'], // Wednesday
  4: ['06:00', '07:00', '08:00', '12:00', '17:00', '18:00', '19:00'], // Thursday
  5: ['06:00', '07:00', '08:00', '12:00', '16:00', '17:00'],          // Friday
  6: ['08:00', '09:00', '10:00', '11:00'],                            // Saturday
};

function loadAvailability() {
  const raw = process.env.AVAILABILITY_JSON;
  if (!raw) return DEFAULT_AVAILABILITY;
  try {
    const parsed = JSON.parse(raw);
    const out = {};
    for (let d = 0; d <= 6; d++) {
      const list = Array.isArray(parsed[d]) ? parsed[d] : [];
      out[d] = list.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
    }
    return out;
  } catch {
    return DEFAULT_AVAILABILITY;
  }
}

const BUSINESS_TZ = process.env.BUSINESS_TZ || 'America/New_York';

const pad2 = (n) => String(n).padStart(2, '0');

/** True if `str` is a valid slot key AND matches the published availability template. */
function isValidSlotKey(str, availability = loadAvailability()) {
  if (typeof str !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(str);
  if (!m) return false;
  const [, y, mo, d, hh, mm] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm));
  // Reject impossible dates (e.g. Feb 31 rolls over).
  if (
    date.getFullYear() !== Number(y) ||
    date.getMonth() !== Number(mo) - 1 ||
    date.getDate() !== Number(d)
  ) return false;
  const times = availability[date.getDay()] || [];
  return times.includes(`${hh}:${mm}`);
}

/** Parse a slot key into a Date in the server's local time (used only for ordering/comparison). */
function slotKeyToDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(key);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm));
}

/**
 * Build the slot grid for a given month.
 * @param {number} year  e.g. 2026
 * @param {number} month 1-12
 * @param {Set<string>} bookedKeys  slot keys already booked
 * @param {Date} now  current time (for hiding past slots); defaults to new Date()
 * @returns {{date:string, weekday:number, slots:{key:string,time:string,booked:boolean,past:boolean}[]}[]}
 */
function buildMonth(year, month, bookedKeys = new Set(), now = new Date()) {
  const availability = loadAvailability();
  const daysInMonth = new Date(year, month, 0).getDate();
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(year, month - 1, d);
    const weekday = dateObj.getDay();
    const times = availability[weekday] || [];
    const dateStr = `${year}-${pad2(month)}-${pad2(d)}`;
    const slots = times.map((time) => {
      const key = `${dateStr}T${time}`;
      const start = new Date(year, month - 1, d, Number(time.slice(0, 2)), Number(time.slice(3, 5)));
      return {
        key,
        time,
        booked: bookedKeys.has(key),
        past: start.getTime() < now.getTime(),
      };
    });
    days.push({ date: dateStr, weekday, slots });
  }
  return days;
}

module.exports = {
  SESSION_MINUTES,
  BUSINESS_TZ,
  DEFAULT_AVAILABILITY,
  loadAvailability,
  isValidSlotKey,
  slotKeyToDate,
  buildMonth,
};
