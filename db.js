const fs = require("fs/promises");
const path = require("path");
const { open } = require("sqlite");
const sqlite3 = require("sqlite3");
const config = require("./config");

let dbPromise = null;

async function ensureDirectory(targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      await ensureDirectory(config.storage.sqlitePath);
      const db = await open({
        filename: config.storage.sqlitePath,
        driver: sqlite3.Database
      });

      await db.exec(`
        CREATE TABLE IF NOT EXISTS app_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      return db;
    })();
  }

  return dbPromise;
}

async function migrateLegacyState(defaultState) {
  const legacyPath = config.storage.legacyJsonPath;
  if (!(await fileExists(legacyPath))) {
    return defaultState;
  }

  try {
    const raw = await fs.readFile(legacyPath, "utf8");
    if (!raw.trim()) {
      return defaultState;
    }

    return {
      ...defaultState,
      ...JSON.parse(raw)
    };
  } catch (error) {
    return defaultState;
  }
}

async function readState(defaultState) {
  const db = await getDb();
  const row = await db.get("SELECT value FROM app_state WHERE key = ?", "bot_state");

  if (!row) {
    const migrated = await migrateLegacyState(defaultState);
    await writeState(migrated);
    return migrated;
  }

  try {
    return {
      ...defaultState,
      ...JSON.parse(row.value)
    };
  } catch (error) {
    await writeState(defaultState);
    return defaultState;
  }
}

async function writeState(state) {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.run(
    `
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
    "bot_state",
    JSON.stringify(state),
    now
  );

  return state;
}

async function closeDb() {
  if (!dbPromise) {
    return;
  }

  const db = await dbPromise;
  dbPromise = null;
  await db.close();
}

module.exports = {
  readState,
  writeState,
  closeDb
};
