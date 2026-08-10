/**
 * @overview Engine and linked-detector identity. ~30 lines, 3 public constants.
 *
 *   READING GUIDE
 *   -------------
 *   1. Read VERSION and detector constants  <- complete module
 *
 *   MAIN FLOW
 *   package manifest + linked dependency -> compile-time identity constants
 *
 *   PUBLIC API
 *   VERSION, DETECTOR_NAME, DETECTOR_VERSION
 *
 *   INTERNALS
 *   (none)
 *
 * @exports VERSION, DETECTOR_NAME, DETECTOR_VERSION
 * @deps package.json contract asserted by test/version.test.ts
 */

// -- 1/1 CORE · identity constants -- <- START HERE

/** slopslint's own version. */
export const VERSION = "0.2.0";

/** Detector name recorded in every canonical report. */
export const DETECTOR_NAME = "jscpd";

/** Version of the linked `@jscpd/*` detector libraries. */
export const DETECTOR_VERSION = "4.2.5";

// -/ 1/1
