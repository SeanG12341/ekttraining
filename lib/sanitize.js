'use strict';

/**
 * HTML sanitization for admin-supplied content. Even though only an
 * authenticated admin can write, we sanitize on the server so stored markup
 * can never inject scripts or dangerous attributes into the public page.
 */

const sanitizeHtml = require('sanitize-html');

/** Rich body text: paragraphs, lists, basic inline emphasis and links. */
function cleanBodyHtml(dirty) {
  return sanitizeHtml(String(dirty ?? ''), {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'blockquote', 'ul', 'ol', 'li', 'a', 'h3', 'h4'],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    transformTags: {
      // Force safe link behaviour on any anchors.
      a: (tagName, attribs) => ({
        tagName: 'a',
        attribs: {
          ...attribs,
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
        },
      }),
    },
  }).trim();
}

/** Headline: allow only line breaks and the accent <em> used by .sec__title. */
function cleanTitleHtml(dirty) {
  return sanitizeHtml(String(dirty ?? ''), {
    allowedTags: ['br', 'em'],
    allowedAttributes: {},
  }).trim();
}

/** Plain text — strip all markup entirely. */
function cleanText(dirty) {
  return sanitizeHtml(String(dirty ?? ''), { allowedTags: [], allowedAttributes: {} }).trim();
}

module.exports = { cleanBodyHtml, cleanTitleHtml, cleanText };
