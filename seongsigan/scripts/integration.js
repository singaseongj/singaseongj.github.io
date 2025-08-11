const API_BASE = "https://solitary-base-9458.seongj1589.workers.dev";

export async function sendToLLM(userMessage){
  try{
    const res = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ message: userMessage })
    });
    if(!res.ok) throw new Error(`status ${res.status}`);
    return await res.json();
  }catch(err){
    console.error('LLM request failed', err);
    return null; // fallback to mock
  }
}

export async function checkHealth(){
  try{
    const res = await fetch(`${API_BASE}/health`);
    return res.ok;
  }catch(_){
    return false;
  }
}
