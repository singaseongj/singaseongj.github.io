// eye.js — scaffold only; no external libs required
export function isEyeTrackingAvailable(){
  // Always return false for now; later, return true when a provider is loaded.
  return !!window.__eyeProviderLoaded__;
}

export function configureEyeTracking({ onGaze, onFixation, regionResolver }){
  // Store callbacks. regionResolver(x,y) => keyId|null
  window.__eyeCfg = { onGaze, onFixation, regionResolver };
}

export function startEyeTracking(){
  // If a provider script sets window.__eyeStart(fn), call it.
  if(typeof window.__eyeStart === 'function'){
    window.__eyeStart((x,y)=>{
      const { onGaze, regionResolver } = window.__eyeCfg || {};
      if(!onGaze || !regionResolver) return;
      onGaze({ x, y });
      const keyId = regionResolver(x,y);
      if(keyId) window.__eyeLastKey = keyId;
      // TODO: dwell detection here or provider side
    });
    return true;
  }
  return false;
}

export function stopEyeTracking(){
  if(typeof window.__eyeStop === 'function') window.__eyeStop();
}
