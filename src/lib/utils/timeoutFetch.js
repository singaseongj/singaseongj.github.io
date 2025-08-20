
export async function fetchWithTimeout(url, opts = {}) {
  const { timeout = 5000, ...rest } = opts;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}
