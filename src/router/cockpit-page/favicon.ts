/** Favicon: a router fanning one request out to three tiers. Inline data URI —
 *  no extra file, no extra route; encodeURIComponent keeps it safe in Safari,
 *  Chrome and Firefox. */
export const COCKPIT_FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#3b6fe0"/><g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"><path d="M8 32h16"/><path d="M24 32 46 14"/><path d="M24 32h22"/><path d="M24 32 46 50"/></g><g fill="#fff"><circle cx="50" cy="14" r="4"/><circle cx="50" cy="32" r="4"/><circle cx="50" cy="50" r="4"/></g></svg>';
export const COCKPIT_FAVICON_DATA_URI = "data:image/svg+xml," + encodeURIComponent(COCKPIT_FAVICON_SVG);
