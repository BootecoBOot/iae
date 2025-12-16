const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

// Ensure migrations directory exists
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
if (!fs.existsSync(MIGRATIONS_DIR)) {
  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
}

// Database path
const DB_PATH = path.join(__dirname, '..', 'data', 'data.db');

// Create a new database connection
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    process.exit(1);
  }
  console.log('Connected to the SQLite database for migration.');
});

// Create place_feedback table
db.serialize(() => {
  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Create place_feedback table
  db.run(`
    CREATE TABLE IF NOT EXISTS place_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      place_id TEXT NOT NULL,
      feature TEXT NOT NULL,
      is_accurate INTEGER NOT NULL, -- 0 for false, 1 for true
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(wa_jid) ON DELETE CASCADE
    )
  `);

  // Create index for faster lookups
  db.run('CREATE INDEX IF NOT EXISTS idx_place_feedback_place_feature ON place_feedback(place_id, feature)');
  db.run('CREATE INDEX IF NOT EXISTS idx_place_feedback_user ON place_feedback(user_id)');
  
  console.log('Migration 001 completed: Created place_feedback table');
});

// Close the database connection
db.close((err) => {
  if (err) {
    console.error('Error closing database:', err.message);
    return;
  }
  console.log('Closed the database connection.');
});
