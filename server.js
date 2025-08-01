import http from 'http';
import fs from 'fs';
import { URL } from 'url';

const PORT = process.env.PORT || 3000;
const DATA_FILE = 'visits.json';

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return { index: { total: 0, daily: 0, date: '' }, stocks: { total: 0, daily: 0, date: '' } };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function handleVisit(page) {
  const data = loadData();
  const entry = data[page] || { total: 0, daily: 0, date: '' };
  const today = new Date().toISOString().split('T')[0];
  if (entry.date !== today) {
    entry.date = today;
    entry.daily = 1;
  } else {
    entry.daily += 1;
  }
  entry.total += 1;
  data[page] = entry;
  saveData(data);
  return entry;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/visit') {
    const page = url.searchParams.get('page');
    if (!page) {
      res.statusCode = 400;
      res.end('page parameter required');
      return;
    }
    const counts = handleVisit(page);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(counts));
  } else {
    res.statusCode = 404;
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Visit count server running on port ${PORT}`);
});
