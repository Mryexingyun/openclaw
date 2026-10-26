import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { backupCreateCommand } from "../commands/backup.js";
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

async function openDatabase(dbPath: string) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  return new (requireNodeSqlite().DatabaseSync)(dbPath);
}

function writeWal(db: import("node:sqlite").DatabaseSync, schema: string, insert: string) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    ${schema};
    PRAGMA wal_checkpoint(TRUNCATE);
    BEGIN IMMEDIATE;
    ${insert};
    COMMIT;
  `);
}

describe("createBackupArchive SQLite alternative filenames", () => {
  it.each(["cron-log.db", "cache.sqlite3", "extensionless-cache"])(
    "snapshots plugin SQLite databases named %s instead of raw WAL families",
    async (databaseName) => {
      await withState(async (state) => {
        await declarePluginSqliteResources(state);
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const extractDir = state.path("extract");
        const dbPath = state.statePath("plugins", "dedicated", databaseName);
        await fs.mkdir(extractDir, { recursive: true });
        using db = await openDatabase(dbPath);
        writeWal(
          db,
          "CREATE TABLE plugin_witness_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
          "INSERT INTO plugin_witness_rows (id, value) VALUES (1, 'committed-in-wal')",
        );

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
    },
  );

  it("warns when an unmanaged SQLite database named .db is archived as opaque bytes", async () => {
    await withState(async (state) => {
      const dbPath = state.statePath("browser", "foreign-cron-log.db");
      using db = await openDatabase(dbPath);
      writeWal(
        db,
        "CREATE TABLE foreign_rows (id INTEGER PRIMARY KEY)",
        "INSERT INTO foreign_rows (id) VALUES (7)",
      );
      const runtime = createTestRuntime();
      const result = await backupCreateCommand(runtime, {
        output: state.path("foreign.tar.gz"),
        includeWorkspace: false,
      });
      expect(
        result.warnings?.filter(
          (warning) => warning.endsWith("foreign-cron-log.db") && warning.includes("opaque"),
        ),
      ).toHaveLength(1);
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

  it.each(["custom.db"])(
    "fails closed when a plugin SQLite schema named %s cannot be compacted safely",
    async (filename) => {
      await withState(async (state) => {
        await declarePluginSqliteResources(state);
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const dbPath = state.statePath("plugins", "dedicated", filename);
        const db = await openDatabase(dbPath);
        db.function("plugin_double", { deterministic: true }, (value) => Number(value) * 2);
        db.exec(`
            CREATE TABLE records (value INTEGER NOT NULL);
            INSERT INTO records (value) VALUES (1), (2);
            CREATE INDEX records_double ON records(plugin_double(value));
          `);
        db.close();

        await expect(archive(outputDir)).rejects.toThrow(
          new RegExp(`cannot be compacted safely.*${filename}`, "iu"),
        );
      });
    },
  );
});
