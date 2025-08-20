export function clamp01(x){ return Math.max(0, Math.min(1, x)); }

export function rank01(arr){
  const v = arr.filter(n => Number.isFinite(n));
  const min = Math.min(...v);
  const max = Math.max(...v);
  return x => (max === min ? 0.5 : (x - min) / (max - min));
}
