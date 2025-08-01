import fs from 'fs';
import assert from 'assert';

let data;
try {
  data = fs.readFileSync('apple-app-site-association', 'utf8');
} catch (err) {
  assert.fail('Could not read apple-app-site-association file');
}

let json;
try {
  json = JSON.parse(data);
} catch (err) {
  assert.fail('apple-app-site-association contains invalid JSON');
}

assert.ok(json.applinks, 'applinks field missing');
assert.ok(Array.isArray(json.applinks.details), 'applinks.details should be an array');
assert.ok(json.applinks.details[0], 'applinks.details[0] missing');
assert.ok(json.applinks.details[0].appID, 'applinks.details[0].appID missing');

console.log('All tests passed');
