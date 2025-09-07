// Lightweight runtime diagnostics & UX helpers (purely additive).
// Safe to include on stocks.html; no external deps.
(() => {
  const perf = (name, fn) => {
    const t0 = performance.now();
    try { return fn(); }
    finally {
      const t1 = performance.now();
      console.debug(`[stocks.runtime] ${name} ${Math.round(t1 - t0)}ms`);
    }
  };

  function ensureDebugToggle() {
    const id = 'debugToggle';
    if (document.getElementById(id)) return;
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.textContent = '디버그 모드 토글';
    btn.style.margin = '0.5rem';
    btn.addEventListener('click', () => {
      document.documentElement.classList.toggle('debug-on');
      const on = document.documentElement.classList.contains('debug-on');
      localStorage.setItem('stocks.debug', on ? '1' : '');
      console.log('[stocks.runtime] debug:', on);
    });
    const h1 = document.querySelector('h1,h2');
    (h1?.parentNode || document.body).insertBefore(btn, h1?.nextSibling || null);
  }

  function restoreDebugState() {
    if (localStorage.getItem('stocks.debug')) {
      document.documentElement.classList.add('debug-on');
    }
  }

  perf('init', () => {
    restoreDebugState();
    ensureDebugToggle();
    document.dispatchEvent(new CustomEvent('stocks:ready'));
  });
})();
