from __future__ import annotations

import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient


@pytest.fixture
def web_api(tmp_path, monkeypatch):
    monkeypatch.setenv('DB_PATH', str(tmp_path / 'content.db'))
    monkeypatch.setenv('LOCAL_CORE_TOKEN', 'web-test-extension-token')
    monkeypatch.setenv('LOCAL_CORE_PORT', '3719')
    build = tmp_path / 'web'
    build.mkdir()
    (build / 'index.html').write_text('<html>WORKBENCH</html>')
    (build / 'assets').mkdir()
    (build / 'assets' / 'main-hash.js').write_text('console.log("web")')
    monkeypatch.setenv('WEB_BUILD_DIR', str(build))
    from app import deps
    deps.reset_caches()
    from app.main import create_app
    from app.web_session import sessions
    client = TestClient(create_app(), base_url='http://127.0.0.1:3719')
    yield client, sessions(), tmp_path
    client.close()
    deps.reset_caches()


def connect(client, store):
    return client.post('/web/session/connect', json={'code': store.issue_code()}, headers={'Origin': store.origin, 'X-NCOS-Web': '1'})


def test_pairing_does_not_expose_long_token_and_session_works_without_extension(web_api):
    client, store, _ = web_api
    assert client.get('/web/session').json() == {'connected': False, 'mode': 'live'}
    assert client.get('/v1/drafts').status_code == 401
    response = connect(client, store)
    assert response.status_code == 200
    assert 'HttpOnly' in response.headers['set-cookie']
    assert 'SameSite=strict' in response.headers['set-cookie']
    assert 'web-test-extension-token' not in response.text + response.headers['set-cookie']
    assert client.get('/v1/handshake').status_code == 200
    assert client.get('/v1/drafts').json()['items'] == []
    assert client.get('/web/session').json()['connected'] is True
    assert os.stat(store.path).st_mode & 0o777 == 0o600


def test_old_extension_token_still_works_and_invalid_explicit_token_does_not_fallback(web_api):
    client, store, _ = web_api
    assert client.get('/v1/handshake', headers={'X-Local-Token': 'web-test-extension-token'}).status_code == 200
    connect(client, store)
    assert client.get('/v1/handshake', headers={'X-Local-Token': 'wrong'}).status_code == 401


@pytest.mark.parametrize('headers', [
    {}, {'Origin': 'http://evil.example', 'X-NCOS-Web': '1'},
    {'Origin': 'null', 'X-NCOS-Web': '1'}, {'Origin': 'http://127.0.0.1:3719'},
    {'Origin': 'http://127.0.0.1:3719', 'X-NCOS-Web': '1', 'Sec-Fetch-Site': 'cross-site'},
    {'Origin': 'http://127.0.0.1:3719', 'X-NCOS-Web': '1', 'Host': 'evil.example:3719'},
])
def test_pairing_rejects_cross_origin_csrf_and_dns_rebinding(web_api, headers):
    client, store, _ = web_api
    code = store.issue_code()
    assert client.post('/web/session/connect', json={'code': code}, headers=headers).status_code == 403
    # Rejected requests must not consume the valid local code.
    assert client.post('/web/session/connect', json={'code': code}, headers={'Origin': store.origin, 'X-NCOS-Web': '1'}).status_code == 200


def test_cookie_writes_require_origin_and_custom_header_and_logout_revokes(web_api):
    client, store, _ = web_api
    connect(client, store)
    old_cookie = client.cookies.get('ncos_web_session')
    payload = {'source': 'creator_advisor', 'display_name': '검수 채널'}
    assert client.post('/v1/performance/channels', json=payload).status_code == 403
    response = client.post('/v1/performance/channels', json=payload, headers={'Origin': store.origin, 'X-NCOS-Web': '1'})
    assert response.status_code == 201
    assert client.delete('/web/session', headers={'Origin': store.origin, 'X-NCOS-Web': '1'}).status_code == 204
    assert not store.valid(old_cookie)
    assert client.get('/v1/drafts').status_code == 401


def test_codes_are_one_use_expire_and_are_rate_limited(web_api):
    client, store, _ = web_api
    code = store.issue_code()
    headers = {'Origin': store.origin, 'X-NCOS-Web': '1'}
    assert client.post('/web/session/connect', json={'code': code}, headers=headers).status_code == 200
    for _ in range(5):
        assert client.post('/web/session/connect', json={'code': code}, headers=headers).status_code == 401
    assert client.post('/web/session/connect', json={'code': store.issue_code()}, headers=headers).status_code == 429


def test_expired_code_session_and_other_environment_are_rejected(web_api):
    _, store, tmp_path = web_api
    from app.web_session import WebSessions
    code = store.issue_code()
    token = store.exchange(code)
    other_port = WebSessions(store.path, 'http://127.0.0.1:3720')
    other_db = WebSessions(tmp_path / 'other.sqlite3', store.origin)
    assert not other_port.valid(token)
    assert not other_db.valid(token)
    code = store.issue_code()
    with sqlite3.connect(store.path) as conn:
        conn.execute('UPDATE credentials SET expires=0')
    assert not store.valid(token)
    with pytest.raises(HTTPException) as exc:
        store.exchange(code)
    assert exc.value.status_code == 401


def test_parallel_code_consumption_has_one_winner(web_api):
    _, store, _ = web_api
    code = store.issue_code()
    def attempt(_):
        try:
            return store.exchange(code)
        except HTTPException:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        tokens = list(pool.map(attempt, [1, 2]))
    assert sum(token is not None for token in tokens) == 1


def test_known_deep_links_only_and_missing_assets_do_not_return_html(web_api):
    client, _, tmp_path = web_api
    for route in ['', 'write', 'drafts', 'keywords', 'performance', 'settings']:
        response = client.get('/app/' + route)
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'no-cache'
        assert "frame-ancestors 'none'" in response.headers['content-security-policy']
    response = client.get('/app/assets/main-hash.js')
    assert 'immutable' in response.headers['cache-control']
    for path in ['/app/assets/missing.js', '/app/.env', '/app/%2e%2e/secret.txt', '/app/not-a-route', '/v1/not-a-route']:
        assert client.get(path).status_code == 404
    assert client.get('/app/', headers={'Host': 'evil.example:3719'}).status_code == 403
    (tmp_path / 'web/index.html').unlink()
    assert client.get('/app/').status_code == 503


def test_secret_symlink_and_cross_origin_read_are_rejected(web_api):
    client, store, tmp_path = web_api
    from app.web_session import WebSessions
    target = tmp_path / 'secret.txt'
    target.write_text('untouched')
    link = tmp_path / 'symlink'
    link.symlink_to(target)
    with pytest.raises(OSError):
        WebSessions(link, store.origin).issue_code()
    assert target.read_text() == 'untouched'
    connect(client, store)
    assert client.get('/v1/drafts', headers={'Origin': 'http://evil.example'}).status_code == 403


def test_spa_index_symlink_cannot_expose_outside_build_directory(web_api):
    client, _, tmp_path = web_api
    secret = tmp_path / 'secret.txt'
    secret.write_text('must not be served')
    index = tmp_path / 'web/index.html'
    index.unlink()
    index.symlink_to(secret)
    assert client.get('/app/write').status_code == 404
    assert client.get('/app/index.html').status_code == 404


def test_theme_bootstrap_revalidates_cache_without_weakening_csp(web_api):
    client, _, tmp_path = web_api
    (tmp_path / 'web' / 'theme-init.js').write_text('/* external theme bootstrap */')
    response = client.get('/app/theme-init.js')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-cache'
    assert "script-src 'self'" in response.headers['content-security-policy']
    assert "style-src 'self'" in response.headers['content-security-policy']
    assert 'unsafe-inline' not in response.headers['content-security-policy']
    assert "img-src 'self' blob:" in response.headers['content-security-policy']
    assert "script-src 'self';" in response.headers['content-security-policy']
    assert 'immutable' in client.get('/app/assets/main-hash.js').headers['cache-control']
