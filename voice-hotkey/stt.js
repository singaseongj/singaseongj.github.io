export function isWebSpeechAvailable() {
  return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
}

export function startWebSpeech(locale, onResult, onError) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    onError(new Error('Web Speech API not available'));
    return { stop() {} };
  }
  const rec = new SR();
  rec.lang = locale;
  rec.interimResults = true;
  rec.continuous = true;
  rec.onresult = (e) => {
    let text = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      text += e.results[i][0].transcript;
    }
    onResult(text, e);
  };
  rec.onerror = onError;
  rec.start();
  return {
    stop() { rec.stop(); }
  };
}

export async function transcribeAudio(file) {
  // TODO: integrate Whisper or another STT API
  return { text: '' };
}
