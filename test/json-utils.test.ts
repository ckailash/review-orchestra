import { describe, it, expect } from "vitest";
import { extractJson, unwrapCliEnvelope } from "../src/json-utils";

describe("extractJson", () => {
  it("parses valid JSON directly", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses JSON array directly", () => {
    expect(extractJson("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("extracts JSON from markdown code block", () => {
    const raw = "Here is the result:\n```json\n{\"a\": 1}\n```\nDone.";
    expect(extractJson(raw)).toEqual({ a: 1 });
  });

  it("extracts JSON from code block without language tag", () => {
    const raw = "```\n{\"a\": 1}\n```";
    expect(extractJson(raw)).toEqual({ a: 1 });
  });

  it("extracts object from mixed text (first { heuristic)", () => {
    const raw = 'Some preamble text {"a": 1}';
    expect(extractJson(raw)).toEqual({ a: 1 });
  });

  it("extracts array from mixed text (first [ heuristic)", () => {
    const raw = "Some text [1, 2, 3]";
    expect(extractJson(raw)).toEqual([1, 2, 3]);
  });

  it("extracts object from text with trailing content (brace walker)", () => {
    const raw = '{"a": 1} some trailing text';
    expect(extractJson(raw)).toEqual({ a: 1 });
  });

  it("extracts object embedded in prose (brace walker)", () => {
    const raw = 'Here is the fix: {"fixed":["f-001"]} hope that helps!';
    expect(extractJson(raw)).toEqual({ fixed: ["f-001"] });
  });

  it("returns null for non-JSON text", () => {
    expect(extractJson("just plain text")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractJson("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractJson("{not: valid}")).toBeNull();
  });
});

describe("unwrapCliEnvelope", () => {
  it("unwraps claude CLI envelope with stringified JSON result", () => {
    const inner = { fixed: ["f-001"], skipped: [], escalated: [] };
    const envelope = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(inner),
    };
    expect(unwrapCliEnvelope(envelope)).toEqual(inner);
  });

  it("unwraps envelope with code-block-wrapped result", () => {
    const inner = { findings: [{ id: "f-001" }] };
    const envelope = {
      type: "result",
      result: "```json\n" + JSON.stringify(inner) + "\n```",
    };
    expect(unwrapCliEnvelope(envelope)).toEqual(inner);
  });

  it("passes through non-envelope objects unchanged", () => {
    const obj = { fixed: ["f-001"], skipped: [] };
    expect(unwrapCliEnvelope(obj)).toBe(obj);
  });

  it("passes through arrays unchanged", () => {
    const arr = [1, 2, 3];
    expect(unwrapCliEnvelope(arr)).toBe(arr);
  });

  it("passes through primitives unchanged", () => {
    expect(unwrapCliEnvelope("hello")).toBe("hello");
    expect(unwrapCliEnvelope(42)).toBe(42);
    expect(unwrapCliEnvelope(null)).toBe(null);
  });

  it("unwraps envelope when result is a directly embedded object", () => {
    const inner = { directly: "embedded" };
    const envelope = { type: "result", result: inner };
    expect(unwrapCliEnvelope(envelope)).toEqual(inner);
  });

  it("passes through envelope if inner string is not parseable JSON", () => {
    const envelope = { type: "result", result: "not json at all" };
    expect(unwrapCliEnvelope(envelope)).toBe(envelope);
  });
});
