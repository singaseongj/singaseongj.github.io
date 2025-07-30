import fs from 'fs/promises';

const API_KEY = 'VQ7n0DBO8ssJTC6%2BKhDQujhh%2FU0sft03wYA7N81rQmCd7gnLWhJBVXL8oYSJqqIfEgFllrUsTJJ0NNVhKMoNzQ%3D%3D';
const BASE_URL = 'https://apis.data.go.kr/1160100/service/GetKrxListedInfoService/getItemInfo';

async function fetchInfo(name) {
  const url = `${BASE_URL}?serviceKey=${API_KEY}&itmsNm=${encodeURIComponent(name)}&resultType=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const item = data?.response?.body?.items?.item?.[0];
  if (!item) throw new Error('No data');
  return {
    sector: item.sector || item.industClsNm || null,
    prevClose: item.clpr || item.mkp || null,
  };
}

async function updateRecommendations() {
  const json = JSON.parse(await fs.readFile('recommendations.json', 'utf-8'));
  for (const market of Object.keys(json)) {
    for (const group of ['safe', 'aggressive']) {
      json[market][group] = await Promise.all(
        json[market][group].map(async entry => {
          const name = typeof entry === 'string' ? entry : entry.name;
          try {
            const info = await fetchInfo(name);
            return { name, sector: info.sector, prevClose: info.prevClose };
          } catch (err) {
            console.error('Failed to fetch', name, err.message);
            return { name, sector: null, prevClose: null };
          }
        })
      );
    }
  }
  await fs.writeFile('recommendations.json', JSON.stringify(json, null, 2));
  console.log('recommendations.json updated');
}

updateRecommendations().catch(err => {
  console.error('Update failed', err);
});
