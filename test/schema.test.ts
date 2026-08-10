// Normative check-output JSON Schema contract test.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const schema = JSON.parse(
  readFileSync(new URL("../docs/check-output.schema.json", import.meta.url), "utf8"),
) as any;


test("exported-symbol orphan findings require their symbol", () => {
  expect(schema.$defs.orphan.allOf).toContainEqual({
    if: { properties: { kind: { const: "exported_symbol" } } },
    then: { required: ["symbol"] },
  });
});
