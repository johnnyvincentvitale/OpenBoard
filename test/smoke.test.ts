import { describe, it, expect } from "vitest";
import { APP_NAME, COLUMNS, OPENCODE_DEFAULTS, health } from "../src/index";

describe("scaffold smoke test", () => {
  it("entry point is wired up", () => {
    expect(APP_NAME).toBe("openboard");
    expect(health()).toEqual({ ok: true, name: "openboard" });
  });

  it("defines the four workflow columns", () => {
    expect(COLUMNS).toEqual(["todo", "in_progress", "review", "done"]);
  });

  it("knows the opencode server defaults", () => {
    expect(OPENCODE_DEFAULTS.port).toBe(4096);
    expect(OPENCODE_DEFAULTS.hostname).toBe("127.0.0.1");
  });
});
