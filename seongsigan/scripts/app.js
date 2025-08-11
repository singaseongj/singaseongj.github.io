import { TEACHERS, loadState, saveState, pushHistory, popHistory, initialTimetables } from './data.js';
import { renderTimetable, renderOverview, applyChange } from './timetable.js';
import { initChat, assistantMessage } from './chat.js';
import { interpret } from './mock-gpt.js';
import { sendToLLM, checkHealth } from './integration.js';

export let appState = loadState();
window.appState = appState; // for modal access
let currentTeacher = TEACHERS[0];
let overview = false;

function refresh(){
  renderTimetable(appState, currentTeacher);
  if(overview) renderOverview(appState);
}

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),1500);
}

async function handleSend(message){
  window.handleSend = handleSend; // expose for action buttons
  let reply = await sendToLLM(message);
  if(!reply) reply = interpret(message, appState);
  assistantMessage(reply.text, reply.actions);
  if(reply.plan){
    pushHistory(appState);
    const res = applyChange(appState, reply.plan);
    if(res.error){ showToast('변경 불가'); }
    else { saveState(appState); refresh(); showToast('저장했습니다'); }
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  const select = document.getElementById('teacherSelect');
  TEACHERS.forEach(t=>{ const o=document.createElement('option'); o.value=t; o.textContent=t; select.appendChild(o); });
  select.addEventListener('change',()=>{ currentTeacher=select.value; refresh(); });
  document.getElementById('overviewToggle').addEventListener('click',()=>{
    overview=!overview;
    document.getElementById('overview').classList.toggle('hidden',!overview);
  });
  document.getElementById('undoBtn').addEventListener('click',()=>{
    const prev = popHistory();
    if(prev){ appState=prev; window.appState=appState; refresh(); showToast('되돌렸습니다'); }
  });
  document.getElementById('resetBtn').addEventListener('click',()=>{
    appState={timetables:JSON.parse(JSON.stringify(initialTimetables))};
    window.appState=appState; saveState(appState); refresh(); showToast('초기화했습니다');
  });
  initChat(handleSend);
  refresh();
  checkHealth().then(ok=>{
    const badge=document.getElementById('backendStatus');
    if(badge){
      badge.classList.add(ok?'ok':'error');
      badge.title= ok? 'Backend reachable':'Backend unreachable';
    }
  });
});
