import { useQuery } from '@tanstack/react-query';
import type { CoreClient } from '@ncos/core-client';
import { browserConnection } from './browser-connection';

export function usePublisherConnection(client: CoreClient) {
  return useQuery({ queryKey: ['workbench-publisher-readiness'], queryFn: async () => {
    const connection = await browserConnection();
    const state = await client.publisherReadiness(connection.worker_id);
    if (!state.current_chrome_extension.ready || state.current_chrome_extension.extension_id !== connection.worker_id || state.current_chrome_extension.build_id !== connection.build_id) throw new Error('이 브라우저의 확장과 서버 연결이 일치하지 않습니다. 연결을 다시 확인하세요.');
    return { ...state, connection };
  }, retry: false, refetchInterval: 10_000 });
}
