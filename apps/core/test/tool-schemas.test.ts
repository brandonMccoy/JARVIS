import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_TOOLS, CONNECTED_TOOLS } from "../src/brain/tools.js";

/**
 * The Messages API rejects a handful of JSON Schema keywords, and does it at
 * request time for the *whole* tools array — so one bad property takes down
 * every tool call, including ones that never touch it. That failure looks like
 * a 400 mentioning a tool index, far from the schema that caused it:
 *
 *   tools.5.custom: For 'integer' type, properties maximum, minimum are not supported
 *
 * Ranges belong in the description, and the handlers clamp.
 */
const REJECTED_ON_INTEGER = ["minimum", "maximum"];

const allTools = [...BUILTIN_TOOLS, ...CONNECTED_TOOLS];

test("no integer property carries keywords the Messages API rejects", () => {
  const offenders: string[] = [];

  for (const tool of allTools) {
    const props = (tool.input_schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
    for (const [prop, schema] of Object.entries(props)) {
      if (schema.type !== "integer") continue;
      for (const keyword of REJECTED_ON_INTEGER) {
        if (keyword in schema) offenders.push(`${tool.name}.${prop} has '${keyword}'`);
      }
    }
  }

  assert.deepEqual(offenders, [], `unsupported schema keywords:\n  ${offenders.join("\n  ")}`);
});

test("every bounded integer states its range in the description instead", () => {
  const bounded = ["honesty", "humor", "days", "limit"];

  for (const tool of allTools) {
    const props = (tool.input_schema as { properties?: Record<string, { type?: string; description?: string }> }).properties ?? {};
    for (const [prop, schema] of Object.entries(props)) {
      if (!bounded.includes(prop) || schema.type !== "integer") continue;
      assert.match(
        schema.description ?? "",
        /\d+\s*-\s*\d+/,
        `${tool.name}.${prop} should name its range in the description, since the schema cannot`,
      );
    }
  }
});

test("tool names are unique across both sets", () => {
  const names = allTools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, `duplicate tool name in ${names.join(", ")}`);
});
