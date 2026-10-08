const UA = 'TQ-webapp/1.0 (contact: avgas-web.github.io)';
const q = process.argv[2];
const url = process.argv[3] || 'https://overpass-api.de/api/interpreter';
const r = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
  body: 'data=' + encodeURIComponent(q),
});
console.log('status:', r.status);
if (r.ok) {
  const j = await r.json();
  console.log('elements:', j.elements.length);
  for (const e of j.elements.slice(0, 4)) {
    console.log(JSON.stringify({ type: e.type, id: e.id, lat: e.lat, center: e.center, name: e.tags?.name, ref: e.tags?.ref }));
  }
} else {
  const t = await r.text();
  const i = t.indexOf('parse error');
  console.log(i >= 0 ? t.slice(i, i + 300) : t.slice(0, 200));
}
