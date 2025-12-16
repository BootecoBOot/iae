const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Get all migration files
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
  .filter(file => file.endsWith('.js'))
  .sort(); // Ensure migrations run in order

if (migrationFiles.length === 0) {
  console.log('No migration files found.');
  process.exit(0);
}

console.log(`Found ${migrationFiles.length} migration(s) to run.`);

// Run each migration
migrationFiles.forEach((file, index) => {
  try {
    console.log(`\nRunning migration ${index + 1}/${migrationFiles.length}: ${file}`);
    const migrationPath = path.join(MIGRATIONS_DIR, file);
    
    // Execute the migration file
    execSync(`node "${migrationPath}"`, { stdio: 'inherit' });
    
    console.log(`✅ Migration ${file} completed successfully.`);
  } catch (error) {
    console.error(`❌ Error running migration ${file}:`, error.message);
    process.exit(1);
  }
});

console.log('\nAll migrations completed successfully!');
