// kb-map.js
import { COMMON_INTENTS, OS_OVERRIDES } from './keymap.js';
import { highlightKeysPublic, getCurrentOS } from './public-api.js';

const examplesWrap = document.querySelector('#keyboard-map .kb-examples');
const statusEl = document.getElementById('kb-status');

init();

function init(){
  buildExamples();
}

function buildExamples(){
  if (!examplesWrap) return;
  examplesWrap.innerHTML = '';

  const shortlist = ['close tab','new tab','refresh','find','copy','paste','undo','save'];
  const ordered = Object.entries(COMMON_INTENTS)
    .sort((a,b)=> shortlist.indexOf(a[0]) - shortlist.indexOf(b[0]));

  for (const [action, winKeys] of ordered){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = labelFor(action);
    btn.setAttribute('aria-label', `Highlight keys for ${action}`);
    btn.addEventListener('click', ()=>{
      const os = getCurrentOS?.() || 'windows';
      const keys = OS_OVERRIDES[os]?.[action] || winKeys;
      highlightKeysPublic(keys);
      say(`Keys: ${keys.join(' + ')} for ${action}`);
    });
    examplesWrap.appendChild(btn);
  }
}

function labelFor(action){
  const map = {
    'close tab': 'Close tab', 'new tab': 'New tab', refresh: 'Refresh', find: 'Find',
    copy: 'Copy', paste: 'Paste', undo: 'Undo', save: 'Save'
  };
  return map[action] || action;
}

function say(text){ if (statusEl) statusEl.textContent = text; }
