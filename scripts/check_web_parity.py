"""Structural preservation baseline, not a substitute for feature acceptance."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'docs/web-feature-parity.json').read_text())
features = manifest['features']
assert [f['id'] for f in features] == [f'F{i:02}' for i in range(1, 31)]
client = (ROOT / 'packages/core-client/src/index.ts').read_text()
for feature in features:
    for key in ('existing_ui', 'baseline_test'):
        assert (ROOT / feature[key]).is_file(), f"{feature['id']}: missing {key}"
    acceptance = feature['web_acceptance']
    assert acceptance.startswith(('implemented', 'partial', 'pending')), f"{feature['id']}: invalid acceptance"
    if not acceptance.startswith('pending'):
        for key in ('web_ui', 'web_test'):
            assert feature.get(key) and (ROOT / feature[key]).is_file(), f"{feature['id']}: missing {key}"
        for path in feature.get('additional_web_tests', []):
            assert (ROOT / path).is_file(), f"{feature['id']}: missing additional web test"
    for method in feature['client_methods']:
        assert re.search(r'^  ' + re.escape(method) + r'\(', client, re.M), f"{feature['id']}: missing client {method}"
    assert feature['preserve'] and feature['target']
assert "export * from '@ncos/core-client'" in (ROOT / 'apps/extension/lib/core.ts').read_text()
for root in ['apps/web/src', 'packages/core-client/src', 'packages/workbench/src']:
    for path in (ROOT / root).rglob('*'):
        if path.suffix in ('.ts', '.tsx'):
            assert not re.search(r"wxt/browser|chrome\.|browser\.(runtime|storage|tabs)", path.read_text()), path
print('PASS: 30 feature groups / preserved client methods / existing + implemented web test/UI paths / Chrome-free web sources')
print('Scope: structural baseline only; pending web/live acceptance is not claimed complete.')
print('Implementation declarations:', ', '.join(f"{state}={sum(f['web_acceptance'].startswith(state) for f in features)}" for state in ['implemented', 'partial', 'pending']))
