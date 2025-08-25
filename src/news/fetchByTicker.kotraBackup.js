import { fetchKotraOverseasRecent, filterByKeyword } from "./kotraOverseas.js";
import { getCompanyNameByYahooSymbol } from "../data/krxDirectory.js";

// When the primary fetch returns nothing for a ticker,
// grab recent KOTRA items and keyword-match by company name.
export async function getTickerArticlesBackup(ticker) {
  const name = await getCompanyNameByYahooSymbol(ticker);
  if (!name) return [];
  const recent = await fetchKotraOverseasRecent(3, 50); // ~150 latest
  // very light heuristic: title OR summary contains company name
  const filtered = filterByKeyword(recent, name);
  return filtered.slice(0, 20); // cap for speed
}

