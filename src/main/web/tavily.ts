// =====================================================================
// Client Tavily.
//
// Due endpoint soli: /search per cercare, /extract per leggere una
// pagina. Passare anche il fetch da Tavily evita che l'agente faccia
// richieste HTTP arbitrarie dal processo principale e restituisce
// markdown gia' ripulito invece di HTML da districare.
// =====================================================================

const DEFAULT_BASE = 'https://api.tavily.com';

export class WebError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WebError';
  }
}

export interface SearchHit {
  title: string;
  url: string;
  content: string;
  score?: number;
}

export interface SearchOutcome {
  answer?: string;
  hits: SearchHit[];
}

export interface SearchOptions {
  maxResults?: number;
  topic?: 'general' | 'news' | 'finance';
  timeRange?: 'day' | 'week' | 'month' | 'year';
  includeDomains?: string[];
}

export interface ExtractOutcome {
  url: string;
  content: string;
}

/** Iniettabile nei test: la stessa firma di fetch, niente di piu'. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class TavilyClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = DEFAULT_BASE,
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
  ) {}

  async search(query: string, opts: SearchOptions = {}, signal?: AbortSignal): Promise<SearchOutcome> {
    const body: Record<string, unknown> = {
      query,
      search_depth: 'basic',
      max_results: clamp(opts.maxResults ?? 5, 1, 20),
      topic: opts.topic ?? 'general',
      include_answer: true,
      include_raw_content: false,
    };
    if (opts.timeRange) body.time_range = opts.timeRange;
    if (opts.includeDomains?.length) body.include_domains = opts.includeDomains.slice(0, 20);

    const json = await this.post('/search', body, signal);
    const hits: SearchHit[] = (json.results ?? []).map((r: any) => ({
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      content: String(r.content ?? ''),
      score: typeof r.score === 'number' ? r.score : undefined,
    }));
    return { answer: typeof json.answer === 'string' ? json.answer : undefined, hits };
  }

  async extract(url: string, query?: string, signal?: AbortSignal): Promise<ExtractOutcome> {
    const body: Record<string, unknown> = {
      urls: [url],
      extract_depth: 'basic',
      format: 'markdown',
    };
    if (query) body.query = query;

    const json = await this.post('/extract', body, signal);
    const first = (json.results ?? [])[0];
    if (!first) {
      const failure = (json.failed_results ?? [])[0];
      throw new WebError(
        failure?.error ? `Estrazione fallita: ${failure.error}` : `Nessun contenuto estratto da ${url}.`,
      );
    }
    return { url: String(first.url ?? url), content: String(first.raw_content ?? '') };
  }

  /** Chiamata minima per verificare che la chiave sia valida. */
  async ping(signal?: AbortSignal): Promise<string> {
    const res = await this.search('orcrist state machine', { maxResults: 1 }, signal);
    return res.hits[0]?.url ?? '(nessun risultato, ma la chiave e\' valida)';
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new WebError(`Tavily non raggiungibile: ${(err as Error).message}`);
    }

    const raw = await res.text();
    if (!res.ok) {
      let detail = raw.slice(0, 400);
      try {
        detail = JSON.parse(raw)?.detail?.error ?? detail;
      } catch {
        /* corpo non JSON */
      }
      // I codici fuori standard sono di Tavily: vale la pena tradurli.
      const hint =
        res.status === 401
          ? 'chiave assente o non valida'
          : res.status === 429
            ? 'troppe richieste'
            : res.status === 432 || res.status === 433
              ? 'crediti esauriti o limite di piano raggiunto'
              : undefined;
      throw new WebError(`Tavily ${res.status}${hint ? ` (${hint})` : ''}: ${detail}`, res.status);
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new WebError(`Risposta Tavily non JSON: ${raw.slice(0, 200)}`);
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
