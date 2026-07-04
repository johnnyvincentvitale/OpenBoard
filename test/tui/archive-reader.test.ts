import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GlobalArchiveStore } from "../../src/db/global-archive-store";
import type { Task } from "../../src/shared";
import { readGlobalArchiveWithoutBoard } from "../../src/tui/index";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openboard-archive-reader-"));
  roots.push(root);
  return root;
}

function task(id: string): Task {
  return {
    id,
    title: "Archived task",
    description: "Check no-instance archive",
    directory: "/repo",
    column: "done",
    position: 0,
    runState: "idle",
    createdAt: 1,
    updatedAt: 2,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("TUI local archive reader", () => {
  it("reads global archive records without a running board", async () => {
    const root = tempRoot();
    const archivePath = join(root, "archive.sqlite");
    const store = new GlobalArchiveStore(archivePath);
    try {
      store.mirrorTask(task("task-1"), {
        name: "old-instance",
        port: 4099,
        workspace: "/repo",
        dbPath: "/data/old.sqlite",
      }, 3);
    } finally {
      store.close();
    }

    const records = await readGlobalArchiveWithoutBoard({
      env: { ...process.env, OPENBOARD_ARCHIVE_DB: archivePath },
      nodeExec: process.execPath,
      cwd: process.cwd(),
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.task_id).toBe("task-1");
    expect(records[0]?.source_instance_name).toBe("old-instance");
  });

  it("returns an empty archive when the global archive DB does not exist", async () => {
    const root = tempRoot();
    const records = await readGlobalArchiveWithoutBoard({
      env: { ...process.env, OPENBOARD_ARCHIVE_DB: join(root, "missing.sqlite") },
      nodeExec: process.execPath,
      cwd: process.cwd(),
    });

    expect(records).toEqual([]);
  });
});
