import { TEACHERS } from './data.js';

const DAYS = ['월','화','수','목','금'];

function findFreePeriod(table, day, start){
  for(let p=start;p<=7;p++){ if(!table?.[day]?.[p]) return {day, period:p}; }
  for(let p=start;p>=1;p--){ if(!table?.[day]?.[p]) return {day, period:p}; }
  return null;
}
function findAdjacentDay(table, day, period){
  const idx=DAYS.indexOf(day);
  const dirs=[-1,1];
  for(let d of dirs){ const nd=DAYS[idx+d]; if(nd && !table?.[nd]?.[period]) return {day:nd, period}; }
  return null;
}

export function interpret(message, state){
  const teacher = TEACHERS.find(t=>message.includes(t));
  if(!teacher) return {text:'어느 선생님인지 알려주세요.', plan:null};
  const table = state.timetables[teacher];

  if(/옮겨|이동/.test(message)){
    const m = message.match(/(월|화|수|목|금).*?([1-7])교시.*?(월|화|수|목|금).*?([1-7])교시/);
    if(!m) return {text:'어디에서 어디로 옮길까요?', plan:null};
    const day=m[1], period=parseInt(m[2]), toDay=m[3], toPeriod=parseInt(m[4]);
    if(day===toDay && period===toPeriod) return {text:'같은 시간으로는 옮길 수 없어요.', plan:null};
    if(!table?.[day]?.[period]) return {text:`${day} ${period}교시에 수업이 없어요.`, plan:null};
    if(table?.[toDay]?.[toPeriod]){
      const alt1=findFreePeriod(table,toDay,toPeriod);
      const alt2=findAdjacentDay(table,toDay,toPeriod);
      const actions=[]; if(alt1) actions.push({label:`${toDay} ${alt1.period}교시`, text:`${teacher} ${day} ${period}교시를 ${toDay} ${alt1.period}교시로 옮겨줘`}); if(alt2) actions.push({label:`${alt2.day} ${toPeriod}교시`, text:`${teacher} ${day} ${period}교시를 ${alt2.day} ${toPeriod}교시로 옮겨줘`});
      return {text:`이미 ${toDay} ${toPeriod}교시에 수업이 있어요.`, plan:null, actions};
    }
    return {text:'이동했습니다.', plan:{action:'move',teacher,day,period,toDay,toPeriod}};
  }
  if(/비워|삭제|없애/.test(message)){
    const m = message.match(/(월|화|수|목|금).*?([1-7])교시/);
    if(!m) return {text:'어느 시간을 비울까요?', plan:null};
    const day=m[1], period=parseInt(m[2]);
    if(!table?.[day]?.[period]) return {text:`${day} ${period}교시에 비울 수업이 없어요.`, plan:null};
    return {text:'삭제했습니다.', plan:{action:'remove',teacher,day,period}};
  }
  if(/추가|넣/.test(message)){
    const m = message.match(/(월|화|수|목|금).*?([1-7])교시.*?([가-힣A-Za-z]+).*?(추가|넣)/);
    if(!m) return {text:'어느 시간에 어떤 과목을 추가할까요?', plan:null};
    const day=m[1], period=parseInt(m[2]);
    const subject=m[3];
    if(table?.[day]?.[period]){
      const alt1=findFreePeriod(table,day,period);
      const alt2=findAdjacentDay(table,day,period);
      const actions=[]; if(alt1) actions.push({label:`${day} ${alt1.period}교시`, text:`${teacher} ${day} ${alt1.period}교시에 ${subject} 추가`}); if(alt2) actions.push({label:`${alt2.day} ${period}교시`, text:`${teacher} ${alt2.day} ${period}교시에 ${subject} 추가`});
      return {text:`${day} ${period}교시에 이미 수업이 있어요.`, plan:null, actions};
    }
    return {text:'추가했습니다.', plan:{action:'add',teacher,day,period,subject}};
  }
  return {text:'무슨 요청인지 이해하지 못했어요.', plan:null};
}
