// Sample teachers and timetable data
export const TEACHERS = ["김선생", "박선생", "이선생"];

// initial timetable structure: day -> period -> lesson
export const initialTimetables = {
  "김선생": {
    "월": {1:{subject:"수학", className:"1-1", room:"101"},2:{subject:"영어", className:"1-2", room:"102"}},
    "화": {3:{subject:"과학", className:"2-1", room:"201"},4:{subject:"수학", className:"2-2", room:"202"}},
    "수": {1:{subject:"영어", className:"1-3"},2:{subject:"과학", className:"1-2"}},
    "목": {3:{subject:"수학", className:"2-3"},4:{subject:"영어", className:"2-1"}},
    "금": {1:{subject:"과학", className:"1-1"},2:{subject:"수학", className:"1-2"}}
  },
  "박선생": {
    "월": {1:{subject:"과학", className:"1-4"},2:{subject:"수학", className:"1-1"}},
    "화": {3:{subject:"영어", className:"2-3"},4:{subject:"과학", className:"2-2"}},
    "수": {1:{subject:"수학", className:"1-3"},2:{subject:"영어", className:"1-2"}},
    "목": {3:{subject:"과학", className:"2-4"},4:{subject:"수학", className:"2-1"}},
    "금": {1:{subject:"영어", className:"1-1"},2:{subject:"과학", className:"1-2"}}
  },
  "이선생": {
    "월": {1:{subject:"영어", className:"3-1"},2:{subject:"과학", className:"3-2"}},
    "화": {3:{subject:"수학", className:"3-1"},4:{subject:"영어", className:"3-3"}},
    "수": {1:{subject:"과학", className:"3-2"},2:{subject:"수학", className:"3-3"}},
    "목": {3:{subject:"영어", className:"3-1"},4:{subject:"과학", className:"3-3"}},
    "금": {1:{subject:"수학", className:"3-2"},2:{subject:"영어", className:"3-1"}}
  }
};

// history stack for undo
const history = [];

function clone(obj){return JSON.parse(JSON.stringify(obj));}

export function loadState(){
  const raw = typeof localStorage !== 'undefined' && localStorage.getItem('seongsigan-state');
  if(raw){
    try { return JSON.parse(raw); } catch(e) {}
  }
  return {timetables: clone(initialTimetables)};
}

export function saveState(state){
  if(typeof localStorage !== 'undefined'){
    localStorage.setItem('seongsigan-state', JSON.stringify(state));
  }
}

export function pushHistory(state){
  history.push(JSON.stringify(state));
  if(history.length > 20) history.shift();
}

export function popHistory(){
  const raw = history.pop();
  return raw ? JSON.parse(raw) : null;
}
