/* The venue registry, shared by the CLI and the browser extension.
 *
 * These modules live under extension/ so they ship inside the packaged
 * extension and can be dynamically imported by the content script; the CLI
 * imports the very same files from disk. One source of truth, no duplication:
 * a conversion behaves identically whether you ran it from a terminal or
 * clicked it in Overleaf. */

import * as acmart from './acmart.js';
import * as elsarticle from './elsarticle.js';
import * as ieeetran from './ieeetran.js';

export { Report } from './ir.js';
export { documentClass } from './latex.js';

export const VENUES = [acmart, elsarticle, ieeetran];

/** Which venue does this document use, by its \documentclass? */
export function detectVenue(className) {
  return VENUES.find((v) => v.detect(className)) || null;
}

export function venueById(id) {
  return VENUES.find((v) => v.id === id) || null;
}
