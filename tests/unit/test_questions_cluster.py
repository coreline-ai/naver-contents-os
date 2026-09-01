from intelligence.cluster import cluster_keywords, similarity
from intelligence.questions import extract_candidates
from providers.models import KeywordMetric, SearchItem, SearchLandscape


def make_landscape():
    return SearchLandscape(
        keyword="애드포스트",
        kin_items=[
            SearchItem(title="<b>애드포스트</b> 승인 조건이 뭔가요?"),
            SearchItem(title="애드포스트 승인 조건이 뭔가요?"),  # dup after tag strip
            SearchItem(title="방문자 몇 명이면 승인되나요"),
            SearchItem(title="그냥 일반 제목"),
        ],
        cafe_items=[
            SearchItem(title="애드포스트 승인 후기 공유합니다"),
            SearchItem(title="일상 이야기"),
        ],
    )


def test_extracts_questions_and_reviews_with_dedupe():
    out = extract_candidates(make_landscape())
    texts = [c["text"] for c in out]
    assert "애드포스트 승인 조건이 뭔가요?" in texts
    assert texts.count("애드포스트 승인 조건이 뭔가요?") == 1  # deduped
    assert {"text": "방문자 몇 명이면 승인되나요", "kind": "question", "channel": "kin"} in out
    review = next(c for c in out if c["kind"] == "review")
    assert review["channel"] == "cafe"
    assert all("일반 제목" not in t and "일상 이야기" not in t for t in texts)


def test_none_landscape_gives_empty():
    assert extract_candidates(None) == []


def metric(kw, vol):
    return KeywordMetric(keyword=kw, monthly_pc_searches=vol, monthly_mobile_searches=0)


def test_bigram_similarity_groups_korean_compounds():
    assert similarity("애드포스트승인", "애드포스트승인조건") > 0.4
    assert similarity("애드포스트승인", "다이슨에어랩") < 0.2


def test_clustering_is_deterministic_and_volume_ordered():
    metrics = [
        metric("애드포스트승인조건", 500),
        metric("애드포스트", 30000),
        metric("다이슨에어랩", 20000),
        metric("애드포스트승인", 8000),
    ]
    a = cluster_keywords(metrics)
    b = cluster_keywords(list(reversed(metrics)))
    assert a == b  # input order must not matter
    labels = [c["label"] for c in a]
    assert labels[0] == "애드포스트"  # highest volume seeds first cluster
    adpost = next(c for c in a if c["label"] == "애드포스트")
    assert "애드포스트승인" in adpost["keywords"]
    assert all("다이슨에어랩" not in c["keywords"] for c in a if c["label"] != "다이슨에어랩")
