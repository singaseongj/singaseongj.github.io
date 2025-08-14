async function loadFx() {
  try {
    const res = await fetch('data/fx_rates.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  } catch {
    return null;
  }
}
function fmt(n, digits=2) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 }); }
function fmtDec(n, d=2) { return Number(n).toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

async function renderFxTicker() {
  const el = document.getElementById('fxTicker');
  if (!el) return;
  const data = await loadFx();
  if (!data || !data.rates) { el.style.display = 'none'; return; }

  const { rates } = data;
  const KRW = rates.KRW || 0;
  const JPY = rates.JPY || 0;
  const EUR = rates.EUR || 0;
  const CNY = rates.CNY || 0;
  const GBP = rates.GBP || 0;

  if (!KRW || !JPY) { el.style.display = 'none'; return; }

  const usdToKrw = fmt(Math.round(KRW));
  const jpy100ToKrw = fmt(Math.round((KRW / JPY) * 100));
  const eurUsd = EUR ? fmtDec(EUR, 2) : '—';
  const cnyUsd = CNY ? fmtDec(CNY, 3) : '—';
  const gbpUsd = GBP ? fmtDec(GBP, 2) : '—';

  const updated = new Date(data.timestamp).toLocaleString('ko-KR');
  const line = [
    `1 USD = ${usdToKrw} KRW`,
    `100 JPY = ${jpy100ToKrw} KRW`,
    `1 EUR = ${eurUsd} USD`,
    `1 CNY = ${cnyUsd} USD`,
    `1 GBP = ${gbpUsd} USD`,
    `Updated: ${updated}`
  ].join(' • ');

  // Duplicate for seamless scroll
  el.innerHTML = `<div class="fx-ticker__inner"><span>${line}</span><span>${line}</span></div>`;
}

document.addEventListener('DOMContentLoaded', renderFxTicker);
