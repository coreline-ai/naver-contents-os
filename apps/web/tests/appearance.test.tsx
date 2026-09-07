import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AppearancePanel } from '../src/AppearancePanel';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('names all choices, reflects selection, and explains persistence failure without hiding retry', async () => {
  const host=document.createElement('div'),root=createRoot(host),select=vi.fn();document.body.append(host);
  try{
    await act(async()=>root.render(<AppearancePanel theme={{preference:'dark',resolved:'dark',saved:false,select}}/>));
    expect(host.querySelectorAll('input[type=radio]')).toHaveLength(3);
    expect(host.querySelector<HTMLInputElement>('[aria-label="다크"]')!.checked).toBe(true);
    expect(host.querySelector('[role=alert]')!.textContent).toContain('새로고침하면 유지되지 않을 수');
    expect(host.querySelector('[role=status]')!.textContent).toContain('다크 화면 적용 중');
    await act(async()=>host.querySelector<HTMLInputElement>('[aria-label="라이트"]')!.click());expect(select).toHaveBeenCalledWith('light');
    // Retry remains available even when the failed selection is already checked.
    await act(async()=>host.querySelector<HTMLButtonElement>('button')!.click());expect(select).toHaveBeenLastCalledWith('dark');
  }finally{await act(async()=>root.unmount());host.remove();}
});
