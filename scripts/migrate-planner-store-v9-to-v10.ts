import { isAbsolute } from "node:path";

import { migratePlannerStoreV9ToV10 } from "../server/store/sqlite-store.ts";

type MigrationCommand = Readonly<{ database: string; backup: string }>;

function parseMigrationCommand(arguments_: readonly string[]): MigrationCommand {
  if (arguments_.length !== 4) {
    throw new TypeError("Usage: --database /absolute/planner.sqlite --backup /absolute/planner.pre-v10.sqlite");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if ((flag !== "--database" && flag !== "--backup") || !value || values.has(flag)) {
      throw new TypeError("Usage: --database /absolute/planner.sqlite --backup /absolute/planner.pre-v10.sqlite");
    }
    values.set(flag, value);
  }
  const database = values.get("--database");
  const backup = values.get("--backup");
  if (!database || !backup || !isAbsolute(database) || !isAbsolute(backup) || database === backup) {
    throw new TypeError("The database and backup must be distinct absolute paths.");
  }
  return Object.freeze({ database, backup });
}

function runMigrationCommand(arguments_: readonly string[]): string {
  const command = parseMigrationCommand(arguments_);
  return JSON.stringify(migratePlannerStoreV9ToV10({
    filename: command.database,
    backupFilename: command.backup,
  }));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    process.stdout.write(`${runMigrationCommand(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
