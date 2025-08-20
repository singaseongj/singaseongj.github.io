export function pLimit(limit){
  const queue = [];
  let active = 0;
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    (async () => {
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      } finally {
        active--;
        next();
      }
    })();
  };
  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}
