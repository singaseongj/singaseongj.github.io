// public-api.js
// These functions delegate to app.js internals without changing behavior.
export function highlightKeysPublic(keys){
  // app.js should attach a global or export a function; support both:
  if (window?.VoiceKeys?.highlightKeys) return window.VoiceKeys.highlightKeys(keys);
  if (typeof window.highlightKeys === 'function') return window.highlightKeys(keys);
  // If app.js exports it (ESM), it will be re-exported there; see app.js change below.
  console.warn('highlightKeys not found');
}

export function getCurrentOS(){
  // Prefer an existing OS selector with id 'os-select' or 'os' if present.
  const sel = document.getElementById('os-select') || document.getElementById('os');
  if (sel && sel.value) return sel.value;
  // Fallback to 'windows'
  return 'windows';
}
