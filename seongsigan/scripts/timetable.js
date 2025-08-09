import { TEACHERS } from './data.js';

const DAYS = ['월','화','수','목','금'];
const PERIODS = [1,2,3,4,5,6,7];

export function renderTimetable(state, teacher){
  const container = document.getElementById('timetable');
  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.appendChild(document.createElement('div')); // corner
  DAYS.forEach(d=>{
    const h = document.createElement('div');
    h.className='day-header';
    h.textContent=d;
    grid.appendChild(h);
  });
  PERIODS.forEach(p=>{
    const r = document.createElement('div');
    r.className='period';
    r.textContent=p+'교시';
    grid.appendChild(r);
    DAYS.forEach(d=>{
      const cell = document.createElement('div');
      cell.className='cell';
      cell.tabIndex=0;
      cell.dataset.day=d; cell.dataset.period=p;
      const lesson = state.timetables[teacher]?.[d]?.[p];
      if(lesson){
        const subj = document.createElement('div');
        subj.className='subject';
        subj.textContent=lesson.subject+ (lesson.className? ' '+lesson.className:'');
        cell.appendChild(subj);
        cell.title = `${lesson.subject} ${lesson.className||''} ${lesson.room||''} ${lesson.note||''}`.trim();
      }
      cell.addEventListener('click',()=>openEditModal({teacher,day:d,period:p,lesson}));
      grid.appendChild(cell);
    });
  });
  container.appendChild(grid);
}

export function renderOverview(state){
  const el = document.getElementById('overview');
  el.innerHTML='';
  const table = document.createElement('table');
  table.className='overview-table';
  const head = document.createElement('tr');
  head.appendChild(document.createElement('th'));
  DAYS.forEach(d=>{const th=document.createElement('th');th.textContent=d;head.appendChild(th);});
  table.appendChild(head);
  TEACHERS.forEach(t=>{
    const row=document.createElement('tr');
    const name=document.createElement('th');name.textContent=t;row.appendChild(name);
    DAYS.forEach(d=>{
      const cell=document.createElement('td');
      const lessons=state.timetables[t]?.[d];
      let txt='';
      if(lessons){
        txt = Object.keys(lessons).map(p=>p+":"+lessons[p].subject).join(' ');
      }
      cell.textContent=txt;
      row.appendChild(cell);
    });
    table.appendChild(row);
  });
  el.appendChild(table);
}

export function openEditModal({teacher,day,period,lesson}){
  const modal = document.getElementById('modalContainer');
  const dayOptions = DAYS.map(d=>`<option value="${d}" ${d===day?'selected':''}>${d}</option>`).join('');
  const periodOptions = PERIODS.map(p=>`<option value="${p}" ${p===period?'selected':''}>${p}</option>`).join('');
  modal.innerHTML = `<div class="content"><h3>${teacher} ${day} ${period}교시</h3>
    <label>과목<input id="m-subject" value="${lesson?.subject||''}"></label>
    <label>반<input id="m-class" value="${lesson?.className||''}"></label>
    <label>교실<input id="m-room" value="${lesson?.room||''}"></label>
    <label>비고<input id="m-note" value="${lesson?.note||''}"></label>
    <label>요일<select id="m-day">${dayOptions}</select></label>
    <label>교시<select id="m-period">${periodOptions}</select></label>
    <div class="modal-actions">
      <button id="m-save">저장</button>
      <button id="m-remove">삭제</button>
      <button id="m-cancel">취소</button>
    </div></div>`;
  modal.classList.remove('hidden');
  const close=()=>{modal.classList.add('hidden');modal.innerHTML='';document.removeEventListener('keydown',esc);};
  document.getElementById('m-cancel').addEventListener('click',close);
  modal.addEventListener('click',e=>{if(e.target===modal)close();});
  const esc=e=>{if(e.key==='Escape')close();};
  document.addEventListener('keydown',esc);
  document.getElementById('m-save').addEventListener('click',()=>{
    const plan={action:lesson?'edit':'add',teacher,day,period,
      toDay:document.getElementById('m-day').value,
      toPeriod:parseInt(document.getElementById('m-period').value,10),
      subject:document.getElementById('m-subject').value,
      className:document.getElementById('m-class').value,
      room:document.getElementById('m-room').value,
      note:document.getElementById('m-note').value};
    if(plan.toDay!==day||plan.toPeriod!==period) plan.action='move';
    applyChange(window.appState, plan);
    close();
  });
  document.getElementById('m-remove').addEventListener('click',()=>{
    const plan={action:'remove',teacher,day,period};
    applyChange(window.appState, plan);
    close();
  });
}

export function applyChange(state, plan){
  const tt = state.timetables;
  const {teacher,action,day,period,toDay,toPeriod,subject,className,room,note} = plan;
  const table = tt[teacher];
  const lessonAt=(d,p)=> table?.[d]?.[p];
  if(action==='move'){
    if(day===toDay && period===toPeriod) return {error:'same'};
    const lesson = lessonAt(day,period);
    if(!lesson) return {error:'empty'};
    if(lessonAt(toDay,toPeriod)) return {error:'conflict'};
    delete table[day][period];
    table[toDay]=table[toDay]||{};
    table[toDay][toPeriod]=lesson;
  } else if(action==='remove'){
    if(!lessonAt(day,period)) return {error:'empty'};
    delete table[day][period];
  } else if(action==='add' || action==='edit'){
    table[day]=table[day]||{};
    if(action==='add' && lessonAt(day,period)) return {error:'conflict'};
    table[day][period]={subject,className,room,note};
  }
  return {ok:true};
}
