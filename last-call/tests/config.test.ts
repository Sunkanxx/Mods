import { test, expect } from "claude-code/testing";
import { configFrom, DEFAULTS } from "../hooks/lib/config.mjs";

test("no options gives the defaults", () => {
  expect(configFrom()).toEqual(DEFAULTS);
});

test("picker values arrive as strings and become numbers", () => {
  const cfg = configFrom({
    wrapAtPercent: "80",
    stopAtPercent: "90",
    sevenDayWrapAtPercent: "85",
    sevenDayStopPercent: "98",
    wrapLeadMinutes: "0",
    keepAliveMinutes: "30",
    coldResumeTimeoutMinutes: "60",
  });
  expect(cfg).toMatchObject({
    wrapAtPercent: 80,
    stopAtPercent: 90,
    sevenDayWrapAtPercent: 85,
    sevenDayStopPercent: 98,
    wrapLeadMinutes: 0,
    keepAliveMinutes: 30,
    coldResumeTimeoutMinutes: 60,
  });
});

test("a number stored before the pickers still counts", () => {
  expect(configFrom({ stopAtPercent: 90, keepAliveMinutes: 45 })).toMatchObject({ stopAtPercent: 90, keepAliveMinutes: 45 });
});

test("an empty or non-numeric string falls back to the default", () => {
  expect(configFrom({ stopAtPercent: "", keepAliveMinutes: "soon" })).toMatchObject({
    stopAtPercent: DEFAULTS.stopAtPercent,
    keepAliveMinutes: DEFAULTS.keepAliveMinutes,
  });
});

test("a wrap-up picked above the stop is held to the stop", () => {
  expect(configFrom({ wrapAtPercent: "95", stopAtPercent: "85" })).toMatchObject({ wrapAtPercent: 85, stopAtPercent: 85 });
});
