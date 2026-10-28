// The browser build's pure game modules, shared unchanged with the node tests
// and typed for this client: the rules (js/rules.js), the practice AI
// (js/ai.js), the session state machine (js/session.js: series, clocks,
// undo, lessons, progression and achievements), the content (js/content.js:
// five themes, five lessons, 40 Journey stages, six challenges, the Daily),
// the progress document (js/storage.js) and the strings (js/i18n.js).
import * as rules from "../js/rules.js";
import * as ai from "../js/ai.js";
import * as session from "../js/session.js";
import * as content from "../js/content.js";
import * as storage from "../js/storage.js";
import * as i18n from "../js/i18n.js";

export interface Config {
  boardSize: number; winLength: number; moveLimit: number; timeLimitMs: number; disabledCells: number[];
  startMarks: { cell: number; player: number }[]; firstPlayer: number; misere: boolean;
}
export interface State {
  version: number; config: Config; seed: number; board: number[]; currentPlayer: number; turnNumber: number;
  status: "active" | "terminal"; terminalReason: string | null; winner: number; winLine: number[] | null;
  invalidActions: Record<number, number>; playerTimeMs: Record<number, number>; marksPlaced: Record<number, number>;
}
export interface Theme {
  id: string; name: string; bg: number; fog: number; board: number; boardEdge: number; grid: number; frame: number; ground: number;
  markA: number; markB: number; ghost: number; accent: number; danger: number; key: number; fill: number; ambience: string; desc: string;
}
export interface Difficulty { id: string; name: string; depth: number; noise: number; blunderPct: number; difficultyPct: number }
export interface Stage {
  id: string; index: number; chapter: number; name: string; blurb: string; seed: number; config: Config;
  opponent: { difficulty: string; name: string }; series: number; humanPlayer: number; par: { marks: number; timeMs: number };
  goals: string[]; theme: string; mastery: boolean;
}
export interface LessonStep { text: string; require: { kind: string; cell?: number }; highlightCells?: number[]; config: Partial<Config>; ai?: string }
export interface Lesson { id: string; index: number; name: string; intro: string; steps: LessonStep[] }
export interface Challenge { id: string; name: string; blurb: string; config: Config; ai: string; series: number; goalText: string; seed: number; theme: string }
export interface Daily { id: string; date: string; name: string; rulesetName: string; seed: number; config: Config; ai: string; series: number; theme: string }
export interface Component { key: string; label: string; value: number }
export interface RoundResult { round: number; winner: number; reason: string; humanWon: boolean; draw: boolean; breakdown: { components: Component[]; total: number } }
export interface MatchResult {
  matchId: string; mode: string; contentId: string | null; contentName: string; outcome: "win" | "loss" | "draw";
  rounds: RoundResult[]; seriesScore: Record<number, number>; breakdown: { components: Component[]; total: number };
  theme: string; ranked: boolean; assistsUsed: boolean; stars: number; achievementsUnlocked: string[];
}
export interface MatchOptions {
  mode: string; contentId: string | null; contentName: string; config: Partial<Config>; seed: number; ai?: string; humanPlayer?: number;
  series: number; theme: string; par: { marks: number; timeMs: number }; goals?: string[]; ranked: boolean; assists: Record<string, boolean>;
}
export interface Match {
  id: string; initialOptions?: MatchOptions; mode: string; contentId: string | null; contentName: string; config: Config; seed: number;
  aiDifficulty: Difficulty | null; humanPlayer: number; seriesLength: number; roundIndex: number; rounds: RoundResult[];
  seriesScore: Record<number, number>; theme: string; ranked: boolean; assists: Record<string, boolean>; par: { marks: number; timeMs: number };
}
export interface Rng { state: number; next(): number }
export interface AI { diff: Difficulty; rng: Rng; nodes: number; chooseCell(s: State, p: number): number }
export interface Timers {
  setTimeout(fn: () => void, ms: number): number; clearTimeout(id: number | null | undefined): void;
  setInterval(fn: () => void, ms: number): number; clearInterval(id: number | null | undefined): void;
}
export interface Progression {
  version: number; journey: Record<string, { stars: number; bestScore: number; completedAt: number }>; lessons: Record<string, { completedAt: number }>;
  challenges: Record<string, { bestScore: number; completedAt: number }>; dailies: Record<string, { score: number; won: boolean; completedAt: number; excludedFromRanking: boolean }>;
  achievements: Record<string, { unlockedAt: number }>;
  stats: { roundsPlayed: number; roundsWon: number; roundsDrawn: number; byMode: Record<string, { played: number; won: number }>; totalScore: number };
  updatedAt: number; generation: number; checksum?: string;
}
export interface StoreLike {
  loadProgression(): Progression; saveProgression(p: Progression): Progression;
  saveSnapshot(name: string, s: unknown): unknown; loadSnapshot(name: string): unknown; clearSnapshot(name: string): void;
}
export interface LessonInfo { lesson: Lesson; step: LessonStep; stepIndex: number; totalSteps: number; highlightCells: number[]; isLast: boolean }
export interface Session {
  phase: string; phaseReason: string; match: Match | null; state: State | null; lesson: { def: Lesson; stepIndex: number; id?: string } | null;
  ai: AI | null; thinking: boolean; turnStartedAt: number; pausedAt: number;
  on(ev: string, fn: (payload: never) => void): () => void; emit(ev: string, payload?: unknown): void;
  startMatch(o: MatchOptions): void; placeCell(cell: number): { ok: boolean; reason?: string }; canUndo(): boolean;
  undo(): { ok: boolean }; isPausable(): boolean; pause(reason?: string): boolean; resume(): void; saveLocalSnapshot(): void;
  loadLocalSnapshot(): boolean; hasLocalSnapshot(): boolean; discardLocalSnapshot(): void; abandonMatch(): void; setPhase(p: string, o: string, r: string): void;
  startLesson(l: Lesson): void; lessonStepInfo(): LessonInfo; lessonPlace(cell: number): { ok: boolean; reason?: string }; clearTimers(): void;
}
export type Think = (ai: AI, state: State, player: number, done: (cell: number, rngState?: number) => void) => void;
interface SessionCtor {
  new (o: { platform: { serverNow(): number }; store: StoreLike; audio: unknown; timers: Timers; think: Think }): Session;
}
export const GameSession = (session as unknown as { GameSession: SessionCtor }).GameSession;
export const PHASE = (session as unknown as { PHASE: Record<string, string> }).PHASE;

interface RulesApi {
  legalCells(s: State, p: number): number[]; defaultConfig(c?: Partial<Config>): Config;
}
export const R = rules as unknown as RulesApi;
interface AiApi {
  PracticeAI: new (id: string, seed: number) => AI; DIFFICULTIES: Difficulty[]; difficultyById(id: string): Difficulty;
}
export const A = ai as unknown as AiApi;
interface ContentApi {
  THEMES: Theme[]; LESSONS: Lesson[]; CHAPTERS: { name: string; theme: string }[]; JOURNEY_STAGES: Stage[]; CHALLENGES: Challenge[];
  themeById(id: string): Theme; dailyFor(d: Date): Daily; validateContent(): string[];
}
export const C = content as unknown as ContentApi;
interface StorageApi {
  ACHIEVEMENTS: { key: string; name: string; desc: string }[];
  defaultProgression(): Progression; migrateProgression(d: unknown): Progression; mergeProgression(a: unknown, b: unknown): Progression;
  sameProgress(a: unknown, b: unknown): boolean;
}
export const St = storage as unknown as StorageApi;
type Vars = Record<string, string | number>;
interface I18nApi {
  t(key: string, vars?: Vars): string; tn(group: string, id: string | number, fallback?: unknown): unknown; setLocale(tag: string): string; locale(): string;
  stageName(s: Stage): string; stageBlurb(s: Stage): string; chapterName(i: number, fb: string): string;
  lessonText(l: { id?: string }, field: string, fb: unknown): string; challengeText(c: Challenge, i: number, fb: string): string;
  themeName(t: Theme): string; rulesetName(n: string): string; achievementText(a: { key: string; name: string; desc: string }, i: number): string;
  aiName(id: string): string; playerName(n: string): string; scoreLabel(l: string): string;
}
export const L = i18n as unknown as I18nApi;
