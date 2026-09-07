import type { ThemePreference, ThemeState } from './theme';
const choices: { value: ThemePreference; title: string; detail: string }[] = [
  { value: 'system', title: '시스템', detail: '기기의 화면 모드를 따라갑니다' },
  { value: 'light', title: '라이트', detail: '밝은 바탕 · 짙은 글자' },
  { value: 'dark', title: '다크', detail: '차콜 바탕 · 부드러운 밝은 글자' },
];
export function AppearancePanel({ theme }: { theme: ThemeState }) {
  return <section className="panel appearance-panel" aria-labelledby="appearance-title">
    <h2 id="appearance-title">화면 테마</h2>
    <p>선택하면 바로 적용됩니다. 작성 중인 글과 분석 결과는 그대로 유지됩니다.</p>
    <fieldset className="theme-options" aria-label="화면 테마 선택">
      {choices.map(choice => <label className="theme-option" key={choice.value}>
        <input type="radio" name="appearance" value={choice.value} checked={theme.preference === choice.value} onChange={() => theme.select(choice.value)} aria-label={choice.title}/>
        <span><strong>{choice.title}</strong><small>{choice.detail}</small></span>
      </label>)}
    </fieldset>
    <p role="status">현재 {theme.resolved === 'dark' ? '다크' : '라이트'} 화면 적용 중{theme.preference === 'system' ? ' · 기기 설정에 맞춰 자동 전환' : ''}</p>
    {!theme.saved && <div className="notice error"><p role="alert">테마를 브라우저에 저장하지 못했습니다. 지금 화면에는 적용되지만 새로고침하면 유지되지 않을 수 있습니다. 브라우저 저장 권한을 확인한 뒤 다시 저장하세요.</p><button onClick={() => theme.select(theme.preference)}>테마 저장 다시 시도</button></div>}
    <p>이 브라우저의 웹 작업실에만 저장됩니다. Chrome 자체·네이버 편집기·기존 확장의 색상이나 사진은 변경하지 않습니다.</p>
  </section>;
}
