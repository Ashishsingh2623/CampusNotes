
require("dotenv").config();

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL .env file mein nahi mila.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
  max: 5
});

pool.on("error", (error) => {
  console.error("PostgreSQL pool error:", error.message);
});

async function initDB() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        course TEXT,
        branch TEXT,
        semester INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS quizzes (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS quiz_results (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);

    console.log("PostgreSQL tables are ready.");
  } finally {
    client.release();
  }
}

async function closeDB() {
  await pool.end();
}

if (require.main === module) {
  initDB()
    .then(async () => {
      console.log("PostgreSQL connection successful!");
      await closeDB();
    })
    .catch(async (error) => {
      console.error("PostgreSQL connection failed:", error.message);
      await closeDB();
      process.exitCode = 1;
    });
}

module.exports = {
  pool,
  initDB,
  closeDB
};
