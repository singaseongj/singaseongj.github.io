import { fetchKotraRecent } from "./kotraOverseas.js";
import { getCompanyNameByYahooSymbol } from "../data/krxDirectory.js";

// When the primary fetch returns nothing for a ticker,
// grab recent KOTRA items and keyword-match by company name.
export async function getTickerArticlesBackup(ticker) {
  const name = await getCompanyNameByYahooSymbol(ticker);
  if (!name) return [];
  const recent = await fetchKotraRecent({ pages: 3, pageSize: 50, keyword: name });
  return recent.slice(0, 20); // cap for speed
}

