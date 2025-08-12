import { inferShortcut } from './llm.js';
import { KEYS } from './keymap.js';
import { isWebSpeechAvailable, startWebSpeech } from './stt.js';

const EXAMPLES = ['ctrl w', '탭 닫아', 'close the tab', '새 탭', 'new tab', 'refresh the page', '새로 고침'];
let controller = null;

function highlightKeys(labels) {
  labels.forEach(label => {
    const item = KEYS.find(k => k.label === label);
    if (!item) return;
    const el = document.getElementById(item.svgId);
    if (el) {
      el.classList.add('pressed');
      setTimeout(() => el.classList.remove('pressed'), 1500);
    }
  });
}

async function processText(text) {
  const transcriptEl = document.getElementById('transcript');
  const resultEl = document.getElementById('result');
  transcriptEl.textContent = text;
  resultEl.textContent = 'Processing...';
  const os = document.getElementById('os').value;
  const { keys, action, confidence } = await inferShortcut(text, { os });
  if (keys.length) {
    highlightKeys(keys);
    resultEl.textContent = `Heard: "${text}" → Keys: ${keys.join(' + ')} (action: ${action}, conf: ${confidence.toFixed(2)})`;
  } else {
    resultEl.textContent = 'No shortcut found';
  }
}

function toggleMic() {
  const micImg = document.getElementById('micImg');
  const resultEl = document.getElementById('result');
  if (controller) {
    controller.stop();
    controller = null;
    micImg.src = 'assets/icons/mic.svg';
    resultEl.textContent = 'Ready';
    return;
  }
  if (!isWebSpeechAvailable()) {
    resultEl.textContent = 'Web Speech API not supported';
    return;
  }
  micImg.src = 'assets/icons/stop.svg';
  resultEl.textContent = 'Listening...';
  controller = startWebSpeech(document.getElementById('lang').value, (text, e) => {
    document.getElementById('transcript').textContent = text;
    const final = e.results[e.results.length - 1].isFinal;
    if (final) {
      controller.stop();
      controller = null;
      micImg.src = 'assets/icons/mic.svg';
      processText(text);
    }
  }, err => {
    console.error(err);
    resultEl.textContent = 'STT error';
    micImg.src = 'assets/icons/mic.svg';
    controller = null;
  });
}

function loadEnv() {
  try {
    window.ENV = JSON.parse(localStorage.getItem('voiceKeysEnv') || '{}');
    document.getElementById('baseUrl').value = window.ENV.LLM_BASE_URL || '';
    document.getElementById('model').value = window.ENV.LLM_MODEL || '';
    document.getElementById('apiKey').value = window.ENV.LLM_API_KEY || '';
  } catch {}
}

function saveEnv() {
  const env = {
    LLM_BASE_URL: document.getElementById('baseUrl').value.trim(),
    LLM_MODEL: document.getElementById('model').value.trim(),
    LLM_API_KEY: document.getElementById('apiKey').value.trim()
  };
  localStorage.setItem('voiceKeysEnv', JSON.stringify(env));
  window.ENV = env;
}

document.addEventListener('DOMContentLoaded', () => {
  const examplesSel = document.getElementById('examples');
  EXAMPLES.forEach(ex => {
    const opt = document.createElement('option');
    opt.value = ex;
    opt.textContent = ex;
    examplesSel.appendChild(opt);
  });
  document.getElementById('micBtn').addEventListener('click', toggleMic);
  examplesSel.addEventListener('change', e => {
    if (e.target.value) processText(e.target.value);
  });
  document.getElementById('clearBtn').addEventListener('click', () => {
    document.getElementById('transcript').textContent = '';
    document.getElementById('result').textContent = '';
  });
  document.getElementById('settingsBtn').addEventListener('click', () => {
    document.getElementById('settingsModal').showModal();
  });
  document.getElementById('closeSettings').addEventListener('click', () => {
    document.getElementById('settingsModal').close();
  });
  document.getElementById('saveSettings').addEventListener('click', () => {
    saveEnv();
    document.getElementById('settingsModal').close();
  });
  loadEnv();
});
