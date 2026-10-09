import { mock } from "claude-code/testing";

// world(on, opts): stubs the engine beneath the mod and records what the mod did.
//
// Options (all optional):
//   files      Record<path, text>  starting file system (in memory; writes update it)
//   env        Record<name, text>  environment (default { USERPROFILE: "C:\\Users\\u" })
//   repo       { root } | null     $.session.repo() (default null: not in a git repo)
//   surfaces   string[]            $.session.surfaces() (default ["terminal"]; [] is a -p run)
//   asks       (string | { reject: true })[]  scripted $.ui.ask answers, used in order;
//                                  an empty queue rejects, as a dismissed dialog does
//   model      (string | { text, delay?, reject? })[]  scripted $.model.complete replies,
//                                  in order. A string or { text } answers at once; delay is
//                                  held on the mocked clock for that many ms; { reject: true }
//                                  fails. The reply resolves to { isAnswered, text, usage }
//   messages   SessionMessage[]    $.session.messages()
//   sessionId  string              $.session.id() (default "s1")
//   turns      number              $.session.turns() (default 1)
//   store      Record<key, value>  starting $.store contents
//   now        number              the mocked clock's start, ms (default 2026-10-09 12:00 UTC)
//   writeFails boolean | (path) => boolean   $.fs.write rejects (for matching paths)
//   readFails  boolean | (path) => boolean   $.fs.read rejects (for matching paths)
//
// Returns the recorders and handles:
//   files      Map<path, text>     the current file system
//   writes     { path, text }[]    every $.fs.write, in order
//   asks       { question, options }[]   every $.ui.ask made
//   logs       { text, to }[]      every $.ui.log
//   modelCalls ModelCompleteRequest[]    every $.model.complete request
//   store      Map<key, value>     the current $.store (a plain stub: mock.store cannot be read back)
//   clock      the mock clock (advance, settle, now)
//   queueAsk(...answers) / queueModel(...replies)   add scripted answers later
//   $          a stand-in `$` over the same state, to call the mod's exported functions
//              directly (a test's own `$` only has what the test file itself uses)
//
// Paths: the engine normalises a POSIX path on Windows (/home/u becomes C:\home\u), so give
// the world Windows-style paths, or compare normalised ones.

type Reject = { reject: true };
type ModelReply = string | { text?: string; delay?: number; reject?: boolean };
type Matcher = boolean | ((path: string) => boolean);

export type WorldOptions = {
  files?: Record<string, string>;
  env?: Record<string, string>;
  repo?: { root: string } | null;
  surfaces?: string[];
  asks?: (string | Reject)[];
  model?: ModelReply[];
  messages?: any[];
  sessionId?: string;
  turns?: number;
  store?: Record<string, unknown>;
  now?: number;
  writeFails?: Matcher;
  readFails?: Matcher;
};

const matches = (m: Matcher | undefined, path: string) => (typeof m === "function" ? m(path) : !!m);

export function world(on: any, opts: WorldOptions = {}) {
  const asks = [...(opts.asks ?? [])];
  const model = [...(opts.model ?? [])];
  const env = opts.env ?? { USERPROFILE: "C:\\Users\\u" };
  const seen = {
    files: new Map<string, string>(Object.entries(opts.files ?? {})),
    writes: [] as { path: string; text: string }[],
    asks: [] as { question: string; options: string[] }[],
    logs: [] as { text: string; to: string }[],
    modelCalls: [] as any[],
    store: new Map<string, unknown>(Object.entries(opts.store ?? {})),
    clock: undefined as any,
    $: undefined as any,
    queueAsk: (...answers: (string | Reject)[]) => void asks.push(...answers),
    queueModel: (...replies: ModelReply[]) => void model.push(...replies),
  };
  seen.clock = mock.clock(on, { now: opts.now ?? Date.UTC(2026, 9, 9, 12, 0) });
  mock.env(on, env);

  const exists = (path: string) => seen.files.has(path);
  const read = (path: string) => {
    if (matches(opts.readFails, path) || !seen.files.has(path)) throw new Error(`cannot read ${path}`);
    return seen.files.get(path);
  };
  const write = (path: string, text: string) => {
    if (matches(opts.writeFails, path)) throw new Error(`cannot write ${path}`);
    seen.files.set(path, text);
    seen.writes.push({ path, text });
  };
  const log = (text: string, to: string) => void seen.logs.push({ text, to });
  // Records the ask and answers it; a dismissal (or an empty queue) rejects.
  const ask = (question: string, options: string[]) => {
    seen.asks.push({ question, options });
    const answer = asks.shift();
    if (typeof answer !== "string") throw new Error("dismissed");
    return answer;
  };
  const complete = async (request: any) => {
    seen.modelCalls.push(request);
    const next = model.shift();
    const reply = typeof next === "string" ? { text: next } : next;
    if (!reply) throw new Error("no scripted model reply");
    if (reply.delay) await seen.clock.sleep(reply.delay);
    if (reply.reject) throw new Error("model failed");
    return { isAnswered: true, text: reply.text ?? "", usage: {} };
  };
  const session = {
    repo: () => opts.repo ?? null,
    surfaces: () => opts.surfaces ?? ["terminal"],
    messages: () => opts.messages ?? [],
    id: () => opts.sessionId ?? "s1",
    turns: () => opts.turns ?? 1,
  };
  const store = {
    get: (key: string) => seen.store.get(key),
    set: (key: string, value: unknown) => void seen.store.set(key, value),
    delete: (key: string) => void seen.store.delete(key),
  };

  on("session.start", (_$: any, e: any) => ({ cwd: e.cwd }));
  on("fs.exists", (_$: any, e: any) => ({ value: exists(e.path) }));
  on("fs.read", (_$: any, e: any) => ({ value: read(e.path) }));
  on("fs.write", (_$: any, e: any) => ({ value: write(e.path, e.text) }));
  on("session.repo", () => ({ value: session.repo() }));
  on("session.surfaces", () => ({ value: session.surfaces() }));
  on("session.messages", () => ({ value: session.messages() }));
  on("session.id", () => ({ value: session.id() }));
  on("session.turns", () => ({ value: session.turns() }));
  on("store.get", (_$: any, e: any) => ({ value: store.get(e.key) }));
  on("store.set", (_$: any, e: any) => ({ value: store.set(e.key, e.value) }));
  on("store.delete", (_$: any, e: any) => ({ value: store.delete(e.key) }));
  on("ui.log", (_$: any, e: any) => ({ value: log(e.text, e.to) }));
  // $.ui.ask is a tool.call of AskUserQuestion.
  on("tool.call", (_$: any, e: any) => {
    if (e.tool !== "AskUserQuestion") return { result: undefined, text: "" };
    const q = e.questions[0];
    const answer = ask(q.question, q.options.map((o: any) => o.label));
    return { result: { answers: { [q.question]: answer } }, text: answer };
  });
  on("model.complete", async (_$: any, e: any) => ({ value: await complete(e) }));

  const asyncOf = (fns: Record<string, (...a: any[]) => any>) =>
    Object.fromEntries(Object.entries(fns).map(([k, f]) => [k, async (...a: any[]) => f(...a)]));
  seen.$ = {
    fs: asyncOf({ exists, read, write }),
    env: asyncOf({ get: (name: string) => env[name] }),
    clock: asyncOf({ now: () => seen.clock.now() }),
    session: asyncOf(session),
    store: asyncOf(store),
    ui: { log: (text: string, o?: any) => log(text, o?.to ?? "transcript"), ask: async (q: string, o: string[]) => ask(q, o) },
    model: asyncOf({ complete }),
  };
  return seen;
}
