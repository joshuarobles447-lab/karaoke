const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');

const prompt = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
prompt.question('Admin email: ', email => {
  prompt.question('Admin password: ', password => {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !password) {
      console.error('Email and password are required.');
      process.exit(1);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');
    const dataDir = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'admin.json'), `${JSON.stringify({ email: normalizedEmail, salt, passwordHash }, null, 2)}\n`);
    console.log('Admin account created.');
    prompt.close();
  });
});
