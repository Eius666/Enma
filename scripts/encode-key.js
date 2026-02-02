const fs = require('fs');
const path = require('path');

const keyPath = process.argv[2];

if (!keyPath) {
  console.error('Usage: node scripts/encode-key.js <path-to-service-account.json>');
  process.exit(1);
}

try {
  const content = fs.readFileSync(keyPath, 'utf8');
  // Parse to ensure valid JSON and minify
  const json = JSON.parse(content);
  // Ensure newlines in private key are literal \n chars for correct JSON parsing later
  if (json.private_key) {
    json.private_key = json.private_key.replace(/\\n/g, '\n');
  }
  
  const base64 = Buffer.from(JSON.stringify(json)).toString('base64');
  console.log('\n✅ Your Base64 Encoded Key (copy below):\n');
  console.log(base64);
  console.log('\n');
} catch (e) {
  console.error('❌ Error reading or parsing file:', e.message);
}
