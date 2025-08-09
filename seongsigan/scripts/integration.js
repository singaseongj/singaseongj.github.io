// Placeholder for future LLM integration
export async function sendToLLM(userMessage){
  // TODO: integrate a real API call here (e.g., OpenAI)
  // Example:
  // const response = await fetch('https://api.openai.com/v1/chat/completions', {
  //   method:'POST',
  //   headers:{'Content-Type':'application/json','Authorization':'Bearer YOUR_KEY'},
  //   body:JSON.stringify({model:'gpt-4o-mini',messages:[{role:'user',content:userMessage}]})
  // });
  // const data = await response.json();
  // return data; // expected to be { text:"...", plan:{...} }
  return null; // return null to fallback to mock parser
}
