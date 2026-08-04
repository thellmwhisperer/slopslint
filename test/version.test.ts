/**
 * Build-time detector identity.
 *
 * The Python predecessor probed a separately installed `jscpd` executable with
 * `--version` and refused to run on a mismatch, because the detector could be
 * swapped underneath the gate. The detector is linked now, so that whole
 * ecosystem-boundary probe collapses into this assertion: the version the
 * engine reports is the version the manifest pins.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import manifest from "../package.json" with { type: "json" };
import { loadConfig } from "../src/config.ts";
import { DETECTOR_NAME, DETECTOR_VERSION, VERSION } from "../src/version.ts";
import { configYaml, tempTree, write } from "./helpers.ts";

describe("detector identity", () => {
  test.each(["@jscpd/core", "@jscpd/tokenizer"])(
    "%s is pinned to the reported detector version",
    (name) => {
      const pinned = (manifest.dependencies as Record<string, string>)[name];
      expect(pinned).toBe(DETECTOR_VERSION);
    },
  );

  test("every detector dependency is pinned exactly, never a range", () => {
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      expect(spec, `${name} must be an exact pin`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test("the engine version matches the manifest", () => {
    expect(manifest.version).toBe(VERSION);
  });

  test("a consumer config must name the linked detector", () => {
    const root = tempTree();
    const path = write(join(root, "config.yml"), configYaml());
    expect(loadConfig(path).detector).toEqual({
      name: DETECTOR_NAME,
      version: DETECTOR_VERSION,
    });
  });

  test("a config pinned to a different detector version fails closed", () => {
    const root = tempTree();
    const path = write(join(root, "config.yml"), configYaml().replace(DETECTOR_VERSION, "9.9.9"));
    expect(() => loadConfig(path)).toThrow(/pinned/);
  });
});
