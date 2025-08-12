import { inferShortcut } from './llm.js';
import { KEYS, ALIASES } from './keymap.js';
import { isWebSpeechAvailable, startWebSpeech } from './stt.js';
import { isEyeTrackingAvailable, configureEyeTracking, startEyeTracking, stopEyeTracking } from './eye.js';

const VIS_DEFAULT = { highlight: true, ping: false, heatmap: false };
function loadVis() {
  try { return Object.assign({}, VIS_DEFAULT, JSON.parse(localStorage.getItem('vk.vis') || '{}')); }
  catch { return { ...VIS_DEFAULT }; }
}
function saveVis(v){ localStorage.setItem('vk.vis', JSON.stringify(v)); }
export const VIS = loadVis();    // { highlight, ping, heatmap }

const EXAMPLES = ['ctrl w', '탭 닫아', 'close the tab', '새 탭', 'new tab', 'refresh the page', '새로 고침'];
let controller = null;

const heat = new Map();
let options = { eye: { enabled: false, dwell: 700, sensitivity: 0.5 } };

function getKeyboardSvgs(){
  const mainHost = document.getElementById('kb-mount');
  const previewHost = document.getElementById('kb-preview');
  return {
    mainHost,
    previewHost,
    mainSvg: mainHost?.querySelector('svg.keyboard') || null,
    previewSvg: previewHost?.querySelector('svg.keyboard') || null,
  };
}

function lerpColorHSL(a,b,t){
  const pa=a.match(/[\d.]+/g).map(Number);
  const pb=b.match(/[\d.]+/g).map(Number);
  const h=pa[0]+(pb[0]-pa[0])*t;
  const s=pa[1]+(pb[1]-pa[1])*t;
  const l=pa[2]+(pb[2]-pa[2])*t;
  return `hsl(${h} ${s}% ${l}%)`;
}

function applyHeatmap(){
  const max=Math.max(...heat.values(),0);
  const cs=getComputedStyle(document.documentElement);
  const cMin=cs.getPropertyValue('--key-heatmap-min').trim();
  const cMax=cs.getPropertyValue('--key-heatmap-max').trim();

  applyHeatmapToBoth(svg=>{
    heat.forEach((count,id)=>{
      const g=svg.querySelector('#'+CSS.escape(id));
      if(!g) return;
      if(VIS.heatmap && max){
        const t=count/max;
        g.classList.add('heatmap');
        g.style.fill=lerpColorHSL(cMin,cMax,t);
      }else{
        g.classList.remove('heatmap');
        g.style.fill='';
      }
    });
  });
}

function saveHeat(){ localStorage.setItem('vkHeat', JSON.stringify(Object.fromEntries(heat))); }
function loadHeat(){
  try{
    const obj=JSON.parse(localStorage.getItem('vkHeat')||'{}');
    Object.entries(obj).forEach(([k,v])=>heat.set(k,Number(v)));
  }catch{}
}

function updateHeatCount(ids){
  ids.forEach(id=>{
    const count=(heat.get(id)||0)+1;
    heat.set(id,count);
  });
  saveHeat();
}

// place a ping overlay centered on <g> within its ownerSVGElement
export function showPressPing(g, { host, scale = 1 } = {}){
  const svg = g.ownerSVGElement;
  if (!svg || !host) return;
  const b = g.getBBox();
  const pt = svg.createSVGPoint();
  pt.x = b.x + b.width/2; pt.y = b.y + b.height/2;
  const screen = pt.matrixTransform(g.getScreenCTM());
  const rect = host.getBoundingClientRect();

  const dot = document.createElement('div');
  dot.className = 'press-ping';
  dot.style.left = (screen.x - rect.left) + 'px';
  dot.style.top  = (screen.y - rect.top)  + 'px';
  dot.style.transform = `translate(-50%,-50%) scale(${scale})`;
  host.appendChild(dot);
  setTimeout(()=> dot.remove(), 550);
}
window.showPressPing = showPressPing;

// existing resolver (use yours if you already have one)
function resolveIdsFromLabels(inputKeys) {
  if (!window.__labelIndex) {
    const m = new Map();
    for (const k of KEYS) {
      const L = k.label.toLowerCase();
      if (!m.has(L)) m.set(L, []);
      m.get(L).push(k.svgId);
    }
    window.__labelIndex = m;
  }
  const idx = window.__labelIndex;
  const out = [];
  for (let raw of inputKeys) {
    if (!raw) continue;
    let norm = String(raw).trim();
    const alias = ALIASES[norm] || ALIASES[norm.toLowerCase()];
    if (alias) norm = alias;
    const L = norm.toLowerCase();
    if (idx.has(L)) out.push(...idx.get(L));
    else out.push(`key-${L}`); // fallback for letters/digits
  }
  return [...new Set(out)];
}

export function highlightKeys(keys, { mirrorPreview = true } = {}){
  const { mainSvg, previewSvg, mainHost, previewHost } = getKeyboardSvgs();
  if (!mainSvg && !previewSvg) return;

  const ids = resolveIdsFromLabels(keys);

  // HIGHLIGHT channel
  if (VIS.highlight){
    const targets = [mainSvg, mirrorPreview ? previewSvg : null].filter(Boolean);
    targets.forEach(svg => {
      ids.forEach(id => {
        const g = svg.querySelector(`#${CSS.escape(id)}.key`);
        if (!g) return;
        g.classList.add('pressed');
        setTimeout(()=> g.classList.remove('pressed'), 900);
      });
    });
  }

  // PING channel
  if (VIS.ping && typeof showPressPing === 'function'){
    const doPing = (svg, host, scale) => {
      ids.forEach(id => {
        const g = svg?.querySelector(`#${CSS.escape(id)}.key`); if (!g) return;
        showPressPing(g, { host, scale });
      });
    };
    doPing(mainSvg, mainHost, 1);
    if (mirrorPreview && previewSvg) doPing(previewSvg, previewHost, 0.8);
  }

  // HEATMAP channel
  if (VIS.heatmap && typeof updateHeatCount === 'function'){
    updateHeatCount(ids);
    if (typeof applyHeatmap === 'function') applyHeatmap();
  }
}
window.VoiceKeys = Object.assign({}, window.VoiceKeys, { highlightKeys });

function applyHeatmapToBoth(updateFnPerKey){
  const { mainSvg, previewSvg } = getKeyboardSvgs();
  [mainSvg, previewSvg].filter(Boolean).forEach(svg => updateFnPerKey(svg));
}

export function validateKeyboardSVG(){
  const { mainSvg } = getKeyboardSvgs();
  if(!mainSvg) return;
  const miss=[];
  for(const k of KEYS){
    if(!mainSvg.querySelector(`#${CSS.escape(k.svgId)}.key`)) miss.push(k.svgId);
  }
  if(miss.length) console.warn('[keyboard.svg] Missing key ids:', miss);
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

function loadOptions(){
  try{
    const opts=JSON.parse(localStorage.getItem('vkOptions')||'{}');
    options.eye = Object.assign(options.eye, opts.eye||{});
  }catch{}
  document.getElementById('eyeToggle').checked = options.eye.enabled;
  document.getElementById('eyeDwell').value = options.eye.dwell;
  document.getElementById('eyeSensitivity').value = options.eye.sensitivity;
}

function saveOptions(){
  localStorage.setItem('vkOptions', JSON.stringify(options));
}

function bindVisToggles(){
  const $ = (s)=>document.querySelector(s);
  const boxH = $('#vis-highlight'); const boxP = $('#vis-ping'); const boxM = $('#vis-heatmap');
  if (boxH){ boxH.checked = !!VIS.highlight; boxH.onchange = ()=> { VIS.highlight = boxH.checked; saveVis(VIS); }; }
  if (boxP){ boxP.checked = !!VIS.ping;      boxP.onchange = ()=> { VIS.ping      = boxP.checked; saveVis(VIS); }; }
  if (boxM){
    boxM.checked = !!VIS.heatmap;
    boxM.onchange = ()=> { VIS.heatmap = boxM.checked; saveVis(VIS); if (typeof applyHeatmap === 'function') applyHeatmap(); };
  }
}
document.addEventListener('DOMContentLoaded', bindVisToggles);

function handleEyeToggle(){
  options.eye.enabled = document.getElementById('eyeToggle').checked;
  if(options.eye.enabled){
    startEye();
  } else {
    stopEyeTracking();
  }
  saveOptions();
}

function startEye(){
  options.eye.dwell = parseInt(document.getElementById('eyeDwell').value,10) || 700;
  options.eye.sensitivity = parseFloat(document.getElementById('eyeSensitivity').value) || 0.5;
  const regionResolver = (x,y)=>{
    const el=document.elementFromPoint(x,y);
    let n=el;
    while(n){
      if(n.classList && n.classList.contains('key') && n.id.startsWith('key-')) return n.id;
      n=n.parentNode;
    }
    return null;
  };
  let current=null, timer=null;
  function maybePress(id){
    const label = KEYS.find(k=>k.svgId===id)?.label;
    if(label) highlightKeys([label]);
  }
  function onGaze({x,y}){
    const id=regionResolver(x,y);
    if(id!==current){
      current=id;
      clearTimeout(timer);
      if(id) timer=setTimeout(()=>maybePress(id), options.eye.dwell);
    }
  }
  configureEyeTracking({ onGaze, onFixation: maybePress, regionResolver });
  if(!startEyeTracking()){
    alert('Eye tracking not available');
    document.getElementById('eyeToggle').checked=false;
    options.eye.enabled=false;
    saveOptions();
  }
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
  document.getElementById('resetHeat').addEventListener('click', ()=>{ heat.clear(); applyHeatmap(); saveHeat(); });
  document.getElementById('eyeToggle').addEventListener('change', handleEyeToggle);
  document.getElementById('eyeDwell').addEventListener('change', ()=>{ options.eye.dwell = parseInt(document.getElementById('eyeDwell').value,10)||700; saveOptions(); });
  document.getElementById('eyeSensitivity').addEventListener('input', ()=>{ options.eye.sensitivity = parseFloat(document.getElementById('eyeSensitivity').value)||0.5; saveOptions(); });
  loadEnv();
  loadOptions();
  loadHeat();
  applyHeatmap();
  if(!isEyeTrackingAvailable()) document.getElementById("eyeToggle").disabled = true;
  if(options.eye.enabled) startEye();
});
