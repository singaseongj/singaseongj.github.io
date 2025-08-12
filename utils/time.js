export function nowKSTISO() {
  const dtf = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = dtf.formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  const stamp = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+09:00`;
  return stamp;
}
