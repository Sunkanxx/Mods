import { test, expect } from "claude-code/testing";
import { DETECTOR_SYSTEM, buildDetectorPrompt } from "../hooks/lib/detector.mjs";
import { world } from "./world";

// The tests cannot read the shipped eval/cases.json (no real fs), so they use a set of the same shape:
// 15 corrections C01..C15 and 15 look-alikes N01..N15.
const pad = (n: number) => String(n).padStart(2, "0");
const cases = [
  ...Array.from({ length: 15 }, (_, i) => ({ id: `C${pad(i + 1)}`, previousReply: `reply ${i}`, userMessage: `fix ${i}`, expect: "correction" })),
  ...Array.from({ length: 15 }, (_, i) => ({ id: `N${pad(i + 1)}`, previousReply: `reply ${i}`, userMessage: `ok ${i}`, expect: "none" })),
];
const ofKind = (kind: string) => cases.filter((c) => c.expect === kind).map((c) => c.id);
const YES = '{"correction": true, "title": "T", "body": "B", "tags": ["x", "y"], "scope": "global", "repeatOf": null}';
const NO = '{"correction": false}';
const replies = (text: string): any[] => cases.map(() => text);

const setUp = (on: any, model: any[]) => world(on, { pluginFiles: { "eval/cases.json": JSON.stringify(cases) }, model });
const run = async ($: any) => ((await $.command.run({ command: "lessons", args: "eval" } as any)) as any).text as string;

test("eval reports false positives", async ($: any, on: any) => {
  const seen = setUp(on, replies(YES));
  const text = await run($);
  expect(text).toContain("Detected: 15/15 · False positives: 15/15");
  expect(text).toContain(`False positives: ${ofKind("none").join(", ")}`);
  expect(text).not.toContain("Missed:");
  expect(text).not.toContain("Errors:");
  expect(seen.modelCalls).toHaveLength(30);
  expect(seen.modelCalls[0]).toMatchObject({
    system: DETECTOR_SYSTEM,
    prompt: buildDetectorPrompt({ previousReply: "reply 0", userMessage: "fix 0", existing: [], projectSetUp: false }),
  });
});

test("eval with an all-false model detects nothing", async ($: any, on: any) => {
  setUp(on, replies(NO));
  const text = await run($);
  expect(text).toContain("Detected: 0/15 · False positives: 0/15");
  expect(text).toContain(`Missed: ${ofKind("correction").join(", ")}`);
  expect(text).not.toContain("False positives: N");
  expect(text).not.toContain("Errors:");
});

test("a failed call is an error, listed apart", async ($: any, on: any) => {
  const model = replies(NO);
  model[0] = { reject: true };
  model[15] = { reject: true };
  setUp(on, model);
  const text = await run($);
  expect(text).toContain("Errors: C01, N01");
  expect(text).toContain("Missed: C02");
  expect(text).not.toContain("Missed: C01");
});

test("a missing cases file says so", async ($: any, on: any) => {
  world(on, {});
  expect(await run($)).toBe("The eval cases could not be read.");
});
