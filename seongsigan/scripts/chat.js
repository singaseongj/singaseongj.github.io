let logEl, onSendFn;

function appendMessage(role, text, actions){
  const msg = document.createElement('div');
  msg.className = 'message '+role;
  const bubble = document.createElement('div');
  bubble.className='bubble';
  bubble.textContent=text;
  msg.appendChild(bubble);
  const time = document.createElement('span');
  time.className='time';
  time.textContent = new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
  msg.appendChild(time);
  if(actions && actions.length){
    const wrap = document.createElement('div');
    actions.forEach(a=>{
      const btn=document.createElement('button');
      btn.className='chip';
      btn.textContent=a.label;
      btn.addEventListener('click',()=>{onSendFn(a.text||a.label);});
      wrap.appendChild(btn);
    });
    msg.appendChild(wrap);
  }
  logEl.appendChild(msg);
  logEl.scrollTop = logEl.scrollHeight;
}

export function initChat(onSend){
  onSendFn = onSend;
  logEl = document.getElementById('chatLog');
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');
  const chips = document.querySelectorAll('.chip');
  const send = () => {
    const msg = input.value.trim();
    if(!msg) return;
    appendMessage('user', msg);
    onSend(msg);
    input.value='';
  };
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); }
  });
  chips.forEach(c=>c.addEventListener('click',()=>{input.value=c.textContent; input.focus();}));
}

export function assistantMessage(text, actions){
  appendMessage('assistant', text, actions);
}
