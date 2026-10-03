"""Local web launcher. Does not kill other servers or expose long-lived tokens."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime

from app.config import get_settings
from app.web_session import sessions
from app.web_version import runtime_revision


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--pair-only', action='store_true')
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    settings = get_settings()
    if not (settings.web_build_dir / 'index.html').is_file():
        print('웹 빌드가 없습니다. pnpm build:web을 먼저 실행하세요.', file=sys.stderr)
        return 1
    url = settings.web_origin
    expected = runtime_revision()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def current():
        try:
            with opener.open(url + '/web/version', timeout=2) as response:
                body = json.load(response)
            if not isinstance(body, dict):
                raise RuntimeError(f'포트 {settings.local_core_port}의 서버 응답 형식이 올바르지 않습니다. 자동 종료하거나 연결하지 않았습니다.')
            if body.get('protocol') != 1 or body.get('revision') != expected:
                raise RuntimeError('구버전 서버가 실행 중입니다. 해당 프로젝트 서버를 종료한 뒤 다시 실행하세요. 자동 종료하지 않았습니다.')
            return True
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f'포트 {settings.local_core_port}에 호환되지 않는 서버가 실행 중입니다. 자동 종료하지 않았습니다.') from exc
        except urllib.error.URLError:
            return False
    process = None
    try:
        running = current()
        if not running:
            if args.pair_only:
                raise RuntimeError('서버가 실행 중이 아닙니다. pnpm app:start를 실행하세요.')
            if settings.db_path.exists():
                backups = settings.db_path.parent / 'backups'
                backups.mkdir(parents=True, exist_ok=True)
                target = backups / f'ncos-before-web-{datetime.now():%Y%m%d-%H%M%S-%f}.db'
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(fd)
                from contextlib import closing
                with closing(sqlite3.connect(f'file:{settings.db_path}?mode=ro', uri=True)) as source, closing(sqlite3.connect(target)) as destination:
                    source.backup(destination)
                    if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise RuntimeError('DB 백업 무결성 검사에 실패했습니다. 시작을 중단합니다.')
                print(f'DB 백업 완료: {target}')
            # Keep server attached to this terminal. Ctrl-C stops only this child.
            process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app.main:app', '--app-dir', 'apps/local-core', '--host', '127.0.0.1', '--port', str(settings.local_core_port)])
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError('앱 서버를 시작하지 못했습니다. 위 오류를 확인하세요.')
                if current():
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('서버 시작 확인 시간이 초과되었습니다.')
        code = sessions(settings).issue_code()
        print(f'\n작업실: {url}/app/\n일회용 연결 코드 (5분 · 1회): {code}\n코드는 앱의 연결 입력란에만 입력하세요. 긴 API 토큰은 필요하지 않습니다.\n', flush=True)
        if not args.no_open:
            webbrowser.open(url + '/app/')
        if process:
            process.wait()
        return 0
    except KeyboardInterrupt:
        return 0
    except (RuntimeError, OSError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                print('시작한 서버의 종료를 기다리고 있습니다. 강제 종료하지 않았습니다.', file=sys.stderr)


if __name__ == '__main__':
    raise SystemExit(main())
