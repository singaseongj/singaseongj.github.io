#!/usr/bin/env python3
"""Collect Korean economy/business keywords using KR-WordRank.

This helper queries the Naver news open API for the provided queries, filters
articles published today, and extracts weighted keywords via KR-WordRank after
removing domain-specific stopwords. The resulting list is printed as JSON so
that Node.js callers can enrich `tags.json` with fresh Korean keywords.
"""

import argparse
import json
import os
from collections import defaultdict
from datetime import datetime
from itertools import combinations
from typing import Iterable, List, Dict, Tuple

import requests
from dotenv import load_dotenv
from krwordrank.word import summarize_with_keywords

try:
    from kiwipiepy import Kiwi  # type: ignore
except Exception as exc:  # pragma: no cover - optional dependency
    raise SystemExit(f"kiwipiepy is required for KR-WordRank keyword extraction: {exc}")

load_dotenv()

NAVER_CLIENT_ID = os.environ.get('NAVER_CLIENT_ID')
NAVER_CLIENT_SECRET = os.environ.get('NAVER_CLIENT_SECRET')

if not NAVER_CLIENT_ID or not NAVER_CLIENT_SECRET:
    raise SystemExit("NAVER_CLIENT_ID and NAVER_CLIENT_SECRET must be provided")

HEADERS = {
    'X-Naver-Client-Id': NAVER_CLIENT_ID,
    'X-Naver-Client-Secret': NAVER_CLIENT_SECRET
}


def extend_stopwords(topic: str, filepath: str) -> Iterable[str]:
    """Return stopwords extended with topic-specific tokens."""
    stopwords: List[str] = []
    if os.path.exists(filepath):
        with open(filepath, 'r', encoding='utf-8') as file:
            stopwords = [line.strip() for line in file if line.strip()]
    domain_stopwords = {"뉴스", "발표", "보도", "증권사", "경제", "산업", "시장"}
    topic_parts = topic.split()
    for i in range(1, len(topic_parts) + 1):
        for combo in combinations(topic_parts, i):
            domain_stopwords.add(''.join(combo))
    domain_stopwords.add(topic)
    return set(stopwords).union(domain_stopwords)


def fetch_news(topic: str, display: int = 100) -> List[str]:
    """Fetch today's Naver news snippets for a topic."""
    query = topic
    url = f"https://openapi.naver.com/v1/search/news.json?query={query}&display={display}&sort=date"
    response = requests.get(url, headers=HEADERS, timeout=10)
    if response.status_code != 200:
        raise RuntimeError(f"Naver news API error {response.status_code}: {response.text}")
    articles = response.json().get('items', [])
    content_list: List[str] = []
    today = datetime.now().strftime("%Y-%m-%d")
    for article in articles:
        pub_date = article.get('pubDate', '')
        if not pub_date:
            continue
        pub_date_obj = datetime.strptime(pub_date, "%a, %d %b %Y %H:%M:%S %z")
        pub_date_str = pub_date_obj.strftime("%Y-%m-%d")
        if today != pub_date_str:
            continue
        title = article.get('title', '').replace('<b>', '').replace('</b>', '')
        description = article.get('description', '').replace('<b>', '').replace('</b>', '')
        combined = f"{title} {description}".strip()
        if combined:
            content_list.append(combined)
    return content_list


def extract_keywords_with_krwordrank(content_list: Iterable[str], stopwords: Iterable[str]) -> Dict[str, float]:
    kiwi = Kiwi()
    filtered_texts: List[str] = []
    for content in content_list:
        tokens = kiwi.analyze(content)
        filtered_tokens: List[str] = []
        for tokenized_text, _ in tokens:
            for word, pos, *_ in tokenized_text:
                if pos in {'NNG', 'NNP', 'VA'} and word not in stopwords:
                    filtered_tokens.append(word)
        if filtered_tokens:
            filtered_texts.append(' '.join(filtered_tokens))

    if not filtered_texts:
        return {}

    texts = "\n".join(filtered_texts)
    if len(texts.split()) < 2:
        return {}

    keywords = summarize_with_keywords(
        texts=texts.split("\n"),
        min_count=2,
        max_length=10,
        beta=0.85,
        max_iter=10,
        stopwords=set(stopwords)
    )
    return keywords


def collect_keywords(topics: Iterable[str], stopword_path: str, limit: int) -> List[Tuple[str, float]]:
    aggregated: Dict[str, float] = defaultdict(float)
    for topic in topics:
        stopwords = extend_stopwords(topic, stopword_path)
        content = fetch_news(topic)
        if not content:
            continue
        keywords = extract_keywords_with_krwordrank(content, stopwords)
        for word, weight in keywords.items():
            aggregated[word] = max(aggregated[word], float(weight))
    sorted_items = sorted(aggregated.items(), key=lambda item: item[1], reverse=True)
    return sorted_items[:limit]


def main() -> None:
    parser = argparse.ArgumentParser(description='Collect KR-WordRank keywords for economy/business topics.')
    parser.add_argument('--query', dest='queries', action='append', help='Query to send to Naver news API.')
    parser.add_argument('--limit', type=int, default=30, help='Number of keywords to emit.')
    parser.add_argument('--stopwords', default=os.path.join(os.path.dirname(__file__), 'stopwords-ko.txt'))
    args = parser.parse_args()

    queries = args.queries or ['경제', '증시', '산업 동향', '비즈니스 뉴스', '금융 시장']
    keywords = collect_keywords(queries, args.stopwords, args.limit)
    payload = {
        'generated_at': datetime.utcnow().isoformat() + 'Z',
        'queries': queries,
        'keywords': [
            {
                'term_ko': term,
                'score': weight
            }
            for term, weight in keywords
        ]
    }
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == '__main__':
    main()
