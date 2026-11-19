/**
 * Units that a number binds to with a non-breaking space (`12 km`).
 * Shared by every locale.
 *
 * @type {readonly string[]}
 */
export const UNITS = Object.freeze([
  'km', 'm', 'cm', 'mm', 'kg', 'g', 'mg', 'l', 'ml', 's', 'ms', 'h', 'min',
  'MB', 'GB', 'KB', 'kHz', 'MHz', '%',
]);

/** Marks that bind to the number after them (`§ 5`). */
export const NUMBER_SIGNS = Object.freeze(['§', '№', '#']);
