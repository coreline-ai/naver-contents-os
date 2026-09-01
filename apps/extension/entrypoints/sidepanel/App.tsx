import type {
  AnalyzeResponse,
  DraftCreateResponse,
  DraftGenerationMode,
  PlanItem,
  SerpObservation,
} from '@ncos/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { CoreClient, CoreError } from '~/lib/core';
import { MSG_GET_BLOG, MSG_GET_SERP, requestActiveTab } from '~/lib/messages';
import type { BlogParse } from '~/lib/parsers/blog';
import type { SerpParse } from '~/lib/parsers/serp';
import { useSettings } from '~/lib/settings';

const STATUS_LABEL: Record<string, string> = {
  ok: '정상',
  unconfigured: '미설정',
  auth: '인증 오류',
  quota: '한도 도달',
  rate_limit: '요청 제한',
  request: '요청 오류',
  schema: '스키마 오류',
};

export default function App() {
  const settings = useSettings();
  const [keyword, setKeyword] = useState('');
  const [serp, setSerp] = useState<SerpObservation | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [draft, setDraft] = useState<DraftCreateResponse | null>(null);
  const [blogInspection, setBlogInspection] = useState<BlogParse | null>(null);

  useEffect(() => {
    void settings.load();
  }, []);
  useEffect(() => {
    setTokenDraft(settings.token);
  }, [settings.token]);

  const client = useMemo(
    () => new CoreClient(settings.coreUrl, settings.token),
    [settings.coreUrl, settings.token],
  );

  const handshake = useQuery({
    queryKey: ['handshake', settings.coreUrl, settings.token],
    queryFn: () => client.handshake(),
    enabled: settings.loaded && !!settings.token,
    refetchInterval: 30_000,
  });

  const analyze = useMutation<AnalyzeResponse, CoreError, { keyword: string; force?: boolean }>({
    mutationFn: ({ keyword: kw, force }) => client.analyze(kw, serp, force ?? false),
    onSuccess: () => setDraft(null),
  });

  const createDraft = useMutation<
    DraftCreateResponse,
    CoreError,
    { planItem: PlanItem; mode: DraftGenerationMode }
  >({
    mutationFn: ({ planItem, mode }) => {
      if (!analyze.data) throw new CoreError(0, 'missing_analysis', '분석 결과가 없습니다');
      return client.createDraft({
        keyword: analyze.data.keyword,
        snapshot_id: analyze.data.snapshot_id,
        plan_item: planItem,
        questions: analyze.data.questions.filter((q) => q.kind === 'question').map((q) => q.text),
        generation_mode: mode,
      });
    },
    onSuccess: setDraft,
  });

  async function pullCurrentSearch() {
    const parsed = await requestActiveTab<SerpParse>({ type: MSG_GET_SERP });
    if (!parsed) {
      analyze.reset();
      setSerp(null);
      return;
    }
    if (parsed.query) setKeyword(parsed.query);
    if (parsed.ok && parsed.results.length > 0) {
      setSerp({
        source: 'BROWSER_DOM',
        collected_at: new Date().toISOString(),
        query: parsed.query,
        results: parsed.results,
      });
    } else {
      setSerp(null);
    }
  }

  async function inspectCurrentBlog() {
    const parsed = await requestActiveTab<BlogParse>({ type: MSG_GET_BLOG });
    setBlogInspection(parsed?.found ? parsed : null);
  }

  const connected = handshake.isSuccess;
  const result = analyze.data;

  return (
    <div className="min-h-screen bg-slate-50 p-3 text-sm text-slate-900">
      <header className="flex items-center justify-between">
        <h1 className="text-base font-bold">Naver Content OS</h1>
        <button
          className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-200"
          onClick={() => setShowSettings((v) => !v)}
        >
          설정
        </button>
      </header>

      <div className="mt-1 flex items-center gap-1.5 text-xs">
        <span className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-rose-500'}`} />
        {connected
          ? 'Local Core 연결됨'
          : !settings.token
            ? '토큰을 설정하세요'
            : handshake.isFetching
              ? '연결 확인 중…'
              : 'Local Core 연결 안 됨 (서버 실행·토큰 확인)'}
      </div>

      {showSettings && (
        <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
          <label className="block text-xs font-medium text-slate-600">Local Core 토큰</label>
          <input
            type="password"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder="data/local_core_token.txt 값"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
          <button
            className="mt-2 rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white"
            onClick={() => void settings.save({ token: tokenDraft }).then(() => setShowSettings(false))}
          >
            저장
          </button>
        </section>
      )}

      <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex gap-2">
          <input
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setSerp(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && keyword && analyze.mutate({ keyword })}
            placeholder="키워드 입력"
            className="w-full rounded border border-slate-300 px-2 py-1.5"
          />
          <button
            className="whitespace-nowrap rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            disabled={!keyword || !connected || analyze.isPending}
            onClick={() => analyze.mutate({ keyword })}
          >
            {analyze.isPending ? '분석 중…' : '분석'}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" onClick={() => void pullCurrentSearch()}>
            현재 검색어 가져오기
          </button>
          <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100" onClick={() => void inspectCurrentBlog()}>
            현재 블로그 분석
          </button>
          {serp && <span className="text-emerald-700">SERP {serp.results.length}건 첨부됨</span>}
          {result && (
            <button
              className="ml-auto rounded border border-slate-300 px-2 py-1 hover:bg-slate-100"
              onClick={() => analyze.mutate({ keyword, force: true })}
            >
              강제 새로고침
            </button>
          )}
        </div>
        {analyze.isError && (
          <p className="mt-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">
            오류({analyze.error.code}): {analyze.error.message}
          </p>
        )}
      </section>

      {result && (
        <>
          <ScoreCard result={result} />
          <LandscapeCard result={result} />
          <PlanCard
            plan={result.plan}
            creating={createDraft.isPending}
            onCreate={(planItem, mode) => createDraft.mutate({ planItem, mode })}
          />
          <QuestionsCard result={result} />
          {createDraft.isError && (
            <p className="mt-3 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">
              초안 오류({createDraft.error.code}): {createDraft.error.message}
            </p>
          )}
          {draft && <DraftCard draft={draft} />}
        </>
      )}
      {blogInspection && <BlogInspectionCard inspection={blogInspection} />}
    </div>
  );
}

function ScoreCard({ result }: { result: AnalyzeResponse }) {
  const score = result.score;
  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Opportunity Score</h2>
        <span className="text-2xl font-bold text-emerald-700">
          {score.value ?? '—'}
          <span className="ml-1 text-xs font-normal text-slate-400">/100 · {score.score_version}</span>
        </span>
      </div>
      <table className="mt-2 w-full text-xs">
        <tbody>
          {score.contributions.map((c) => (
            <tr key={c.component} className="border-t border-slate-100">
              <td className="py-1 text-slate-600">{c.component}</td>
              <td className="py-1 text-right tabular-nums">
                {c.status === 'ok' ? `+${c.points}` : '결측'}
              </td>
              <td className="py-1 pl-2 text-slate-400">{c.raw}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-[11px] text-slate-400">
        수집: {new Date(result.collected_at).toLocaleString()} · 출처:{' '}
        {Object.entries(result.data_status)
          .map(([k, v]) => `${k} ${STATUS_LABEL[v] ?? v}`)
          .join(' · ')}
      </div>
    </section>
  );
}

function LandscapeCard({ result }: { result: AnalyzeResponse }) {
  const l = result.landscape;
  const m = result.metric;
  if (!l && !m) return null;
  const chips: [string, number | null][] = [
    ['월간 검색량', m?.monthly_pc_searches != null || m?.monthly_mobile_searches != null
      ? (m?.monthly_pc_searches ?? 0) + (m?.monthly_mobile_searches ?? 0)
      : null],
    ['블로그', l?.blog_total ?? null],
    ['카페', l?.cafe_total ?? null],
    ['지식iN', l?.kin_total ?? null],
    ['웹문서', l?.web_total ?? null],
    ['뉴스', l?.news_total ?? null],
  ];
  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <h2 className="font-semibold">검색 환경</h2>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {chips.map(([label, value]) => (
          <span key={label} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
            {label} <b className="tabular-nums">{value == null ? '결측' : value.toLocaleString()}</b>
          </span>
        ))}
        {m?.volume_masked && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs">검색량 마스킹(&lt;10)</span>}
      </div>
    </section>
  );
}

export function PlanCard({
  plan,
  creating,
  onCreate,
}: {
  plan: PlanItem[];
  creating: boolean;
  onCreate: (item: PlanItem, mode: DraftGenerationMode) => void;
}) {
  if (plan.length === 0) return null;
  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <h2 className="font-semibold">15편 콘텐츠 플랜</h2>
      <ol className="mt-2 space-y-1.5">
        {plan.map((p) => (
          <li key={p.order} className="rounded border border-slate-100 p-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs tabular-nums text-slate-400">{p.order}.</span>
              <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">
                {p.blog_type}
              </span>
              <span className="truncate text-xs font-medium">{p.title}</span>
            </div>
            <p className="mt-0.5 pl-5 text-[11px] text-slate-500">{p.reason}</p>
            <div className="mt-1 flex justify-end gap-1">
              <button
                className="rounded border border-slate-300 px-2 py-0.5 text-[10px] disabled:opacity-40"
                disabled={creating}
                onClick={() => onCreate(p, 'skeleton')}
              >
                구조 초안
              </button>
              <button
                className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] text-white disabled:opacity-40"
                disabled={creating || p.generation_status !== 'ready'}
                title={p.generation_status === 'ready' ? 'Ollama로 초안 생성' : '현재 LLM 생성 미지원 유형'}
                onClick={() => onCreate(p, 'llm')}
              >
                AI 초안
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function DraftCard({ draft }: { draft: DraftCreateResponse }) {
  return (
    <section className="mt-3 rounded-lg border border-emerald-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">생성된 초안 v{draft.version}</h2>
        <span className="text-[10px] text-slate-400">
          {draft.provider}{draft.model ? ` · ${draft.model}` : ''}
        </span>
      </div>
      <h3 className="mt-2 text-sm font-medium">{draft.title}</h3>
      <p className="mt-1 text-[11px] text-slate-400">본문 {draft.body.length.toLocaleString()}자 · draft #{draft.draft_id}</p>
      <div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs leading-5">
        {draft.body}
      </div>
    </section>
  );
}

export function BlogInspectionCard({ inspection }: { inspection: BlogParse }) {
  return (
    <section className="mt-3 rounded-lg border border-sky-200 bg-white p-3">
      <h2 className="font-semibold">현재 블로그 분석</h2>
      <p className="mt-1 truncate text-xs font-medium">{inspection.title || '제목 없음'}</p>
      <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-slate-600">
        <span>본문 {inspection.body_chars.toLocaleString()}자</span>
        <span>· 이미지 {inspection.image_count}</span>
        <span>· 영상 {inspection.video_count}</span>
        <span>· 링크 {inspection.link_count}</span>
        <span>· 공감 {inspection.likes ?? '결측'}</span>
        <span>· 댓글 {inspection.comments ?? '결측'}</span>
      </div>
    </section>
  );
}

function QuestionsCard({ result }: { result: AnalyzeResponse }) {
  if (result.questions.length === 0) return null;
  return (
    <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <h2 className="font-semibold">실제 질문·후기 ({result.questions.length})</h2>
      <ul className="mt-2 space-y-1 text-xs">
        {result.questions.map((q) => (
          <li key={q.text} className="flex gap-1.5">
            <span className={`shrink-0 rounded px-1 text-[10px] ${q.kind === 'question' ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-700'}`}>
              {q.kind === 'question' ? '질문' : '후기'}
            </span>
            <span className="truncate">{q.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
