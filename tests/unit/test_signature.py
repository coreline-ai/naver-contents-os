import pytest

from providers.searchad.signature import auth_headers, build_signature

KNOWN_VECTOR = "1RwAMGatDnGPP4I4UprdITR89xQCd+3ypiazQtD/p94="


def test_known_vector_utf8_secret():
    assert build_signature("1000", "GET", "/keywordstool", "secret") == KNOWN_VECTOR


def test_method_is_uppercased():
    assert build_signature("1000", "get", "/keywordstool", "secret") == KNOWN_VECTOR


def test_query_string_in_uri_is_rejected():
    with pytest.raises(ValueError):
        build_signature("1000", "GET", "/keywordstool?hintKeywords=x", "secret")


def test_signature_changes_with_each_component():
    base = build_signature("1000", "GET", "/keywordstool", "secret")
    assert build_signature("1001", "GET", "/keywordstool", "secret") != base
    assert build_signature("1000", "POST", "/keywordstool", "secret") != base
    assert build_signature("1000", "GET", "/other", "secret") != base
    assert build_signature("1000", "GET", "/keywordstool", "secret2") != base


def test_auth_headers_shape():
    headers = auth_headers("GET", "/keywordstool", "api-key", "secret", "12345", timestamp="1000")
    assert headers == {
        "X-Timestamp": "1000",
        "X-API-KEY": "api-key",
        "X-Customer": "12345",
        "X-Signature": KNOWN_VECTOR,
    }
