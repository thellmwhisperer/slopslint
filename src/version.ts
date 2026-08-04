/**
 * Engine identity and the detector library it links against.
 *
 * The Python predecessor probed a pinned `jscpd` executable with `--version`
 * and refused to run on a mismatch, because the detector lived on the other
 * side of a process boundary and could be swapped underneath the gate. The
 * detector is now a linked library, so its identity is fixed at build time:
 * `DETECTOR_VERSION` is asserted against the manifest's pinned dependency by
 * `test/version.test.ts` instead of by a runtime subprocess probe.
 */

/** slopslint's own version. */
export const VERSION = "0.1.0";

/** Detector name recorded in every canonical report. */
export const DETECTOR_NAME = "jscpd";

/** Version of the linked `@jscpd/*` detector libraries. */
export const DETECTOR_VERSION = "4.2.5";
