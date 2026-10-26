import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import {
  declarePluginSqliteResources,
  inspectDatabase,
  withBackupFixture,
} from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries } from "./backup-create.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";

// Alternative SQLite filename discovery regression (#148796).
const withState = (run: Parameters<typeof withBackupFixture>[1]) =>
  withBackupFixture({ prefix: "backup-alt-" }, run);
const archive = (output: string) =>
  createBackupArchive({ output, includeWorkspace: false, nowMs: Date.UTC(2026, 8, 15, 4) });

describe("createBackupArchive SQLite alternative filenames", () => {
  it("snapshots extensionless plugin SQLite instead of raw WAL families", async () => {
    const databaseName = "extensionless-cache";
    await withState(async (state) => {
      await declarePluginSqliteResources(state);
      const outputDir = state.path("backups");
      await fs.mkdir(outputDir, { recursive: true });
      const extractDir = state.path("extract");
      const dbPath = state.statePath("plugins", "dedicated", databaseName);
      await fs.mkdir(extractDir, { recursive: true });
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      using db = new (requireNodeSqlite().DatabaseSync)(dbPath);
      db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA wal_autocheckpoint = 0;
          CREATE TABLE plugin_witness_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
          PRAGMA wal_checkpoint(TRUNCATE);
          BEGIN IMMEDIATE;
          INSERT INTO plugin_witness_rows (id, value) VALUES (1, 'committed-in-wal');
          COMMIT;
        `);

      await fs.access(`${dbPath}-wal`);
      await fs.access(`${dbPath}-shm`);
      const result = await archive(outputDir);
      expect(result.warnings ?? []).toEqual([]);
      const entries = await listArchiveEntries(result.archivePath);
      const archivedDbEntries = entries.filter((entry) =>
        entry.endsWith(`/state/plugins/dedicated/${databaseName}`),
      );
      expect(archivedDbEntries).toHaveLength(1);
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        expect(
          entries.some((entry) =>
            entry.endsWith(`/state/plugins/dedicated/${databaseName}${suffix}`),
          ),
          suffix,
        ).toBe(false);
      }

      await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
      inspectDatabase(
        path.join(
          extractDir,
          expectDefined(archivedDbEntries[0], "archivedDbEntries[0] test invariant"),
        ),
        (archivedDb) => {
          expect(archivedDb.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
          expect(
            archivedDb.prepare("SELECT value FROM plugin_witness_rows WHERE id = 1").get(),
          ).toEqual({ value: "committed-in-wal" });
        },
      );
    });
  });

  it("keeps ordinary non-SQLite .db files as plain archive entries without warnings", async () => {
    await withState(async (state) => {
      const plainPath = state.statePath("notes", "ordinary.db");
      const plainBytes = Buffer.from("definitely not a sqlite database\n", "utf8");
      await fs.mkdir(path.dirname(plainPath), { recursive: true });
      await fs.writeFile(plainPath, plainBytes);

      const result = await archive(state.path("ordinary.tar.gz"));
      expect(result.warnings ?? []).toEqual([]);
      const entries = await listArchiveEntries(result.archivePath);
      const plainEntry = expectDefined(
        entries.find((entry) => entry.endsWith("/state/notes/ordinary.db")),
        "ordinary.db archive entry",
      );
      const restored = await backupRestoreCommand(createTestRuntime(), {
        archive: result.archivePath,
        target: state.path("restored"),
      });
      expect(await fs.readFile(path.join(restored.targetPath, plainEntry))).toEqual(plainBytes);
    });
  });
});
