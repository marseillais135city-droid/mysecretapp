const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, 'Mysecretserver', 'ghost.db');
const db = new Database(dbPath);

const users = db.prepare('SELECT * FROM users').all();
console.log('Users in DB:', JSON.stringify(users, null, 2));

const messages = db.prepare('SELECT count(*) as count FROM messages').get();
console.log('Message count:', messages.count);

db.close();
