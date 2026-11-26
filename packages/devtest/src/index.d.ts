// Device scenarios (design D12 of life-droid's add-habit-tracking). Written in
// JavaScript with these declarations, because Node does not strip TypeScript
// types from files under node_modules, where apps install this package.

/** What a driver can do. A scenario that needs one its driver lacks is skipped, and the skip is reported. */
export type Capability =
  /** Input through the system, as a person would give it (Android: touch through `adb shell input`). */
  | 'realInput'
  /** Wait for and tap system notifications. */
  | 'notifications'
  /** Set the device's clock and time zone. */
  | 'clock'
  /** Install a new build over the running one, keeping the app's data. */
  | 'reinstall';

export type Direction = 'up' | 'down' | 'left' | 'right';

/** How a notification is found: by the reminder's id, by its title, or both. */
export interface NotificationMatch {
  id?: string;
  title?: string;
}

export interface WaitOptions {
  /** Default 10 000 ms. */
  timeoutMs?: number;
}

/** One target: what a scenario can do on it. Selectors are CSS selectors in the app's page. */
export interface Driver {
  /** `android-phone`, `android-emulator`, `linux-desktop`, … */
  readonly target: string;
  readonly capabilities: ReadonlySet<Capability>;
  /** How input reaches the app, written into the results, e.g. "real touch (adb shell input)". */
  readonly inputLabel: string;

  /** Navigate the running app to a route, e.g. `/week?sheet=new-habit`. */
  open(route: string): Promise<void>;
  /** Tap the centre of the first element matching the selector. */
  tap(selector: string): Promise<void>;
  /** Swipe starting on the element, e.g. `down` on a sheet's handle. */
  swipe(selector: string, direction: Direction): Promise<void>;
  /** Focus the element by a tap and type the text. */
  type(selector: string, text: string): Promise<void>;
  /** The system back action (Android) or the app's own back (elsewhere). */
  back(): Promise<void>;
  /** Evaluate a JavaScript expression in the page; the result must be JSON. */
  eval<T = unknown>(expression: string): Promise<T>;
  /** Wait until the expression is truthy in the page. */
  waitFor(expression: string, options?: WaitOptions): Promise<void>;
  /** Save a screenshot of the app only (never other windows); returns its path. */
  screenshot(name: string): Promise<string>;
  /** Stop the app's process. */
  forceStop(): Promise<void>;
  /** Start the app again (after `forceStop`, or stop and start), and wait for its first screen. */
  restart(): Promise<void>;
  /** Install a new build over the running one, keeping data, and start it. Needs `reinstall`. */
  reinstall(): Promise<void>;
  /** Wait until a notification is shown. Needs `notifications`. */
  waitForNotification(match: NotificationMatch, options?: WaitOptions): Promise<void>;
  /** Tap a shown notification. Needs `notifications`. */
  tapNotification(match: NotificationMatch): Promise<void>;
  /**
   * Called before each scenario runs: Android wakes the phone, lifts the keyguard and closes the notification
   * shade, because a sleeping screen or an open shade swallows taps.
   */
  beforeScenario?(name: string): Promise<void>;
  /** Set the device's clock (epoch milliseconds). Present with the `clock` capability; `close()` restores automatic time. */
  setClock?(epochMs: number): Promise<void>;
  /** Set the device's time zone (an IANA name). Present with the `clock` capability; `close()` restores the zone. */
  setZone?(zone: string): Promise<void>;
  /** Release whatever the driver holds (sockets, forwards), and put back what a scenario changed (the clock). */
  close(): Promise<void>;
}

/** What a scenario's body receives. */
export interface ScenarioContext {
  /** The driver for this run. */
  readonly d: Driver;
  /** A named step: its time and result go into the results, and a failure screenshot is taken there. */
  step<T>(name: string, run: () => Promise<T>): Promise<T>;
  /** A named check: fails the scenario (inside the current step) unless `actual` equals `expected` (JSON equality). */
  expect(name: string, actual: unknown, expected: unknown): void;
  /** A free-text line in the results. */
  note(text: string): void;
}

export interface Scenario {
  readonly name: string;
  readonly needs: readonly Capability[];
  readonly run: (t: ScenarioContext) => Promise<void>;
}

/** Declare a scenario. A file under `tests/device/` default-exports one scenario or an array of them. */
export function scenario(name: string, run: (t: ScenarioContext) => Promise<void>): Scenario;
export function scenario(name: string, options: { needs?: Capability[] }, run: (t: ScenarioContext) => Promise<void>): Scenario;

export type Outcome = 'pass' | 'fail' | 'skip';

export interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  screenshot?: string;
}

export interface ScenarioResult {
  name: string;
  file: string;
  outcome: Outcome;
  /** For a skip: the capabilities the driver lacks. For a failure: the failed step and message. */
  reason?: string;
  steps: StepResult[];
  notes: string[];
  ms: number;
}

export interface RunInfo {
  target: string;
  inputLabel: string;
  app: string;
  startedAt: string;
}

/**
 * What `dk test` hands the runner (as JSON in `DK_TEST_CONTEXT`), and what a
 * driver module's `createDriver(context)` receives. Driver modules live in
 * `src/drivers/<platform>.js`: `android.js` for both Android targets, `linux.js`.
 */
export interface TestContext {
  target: 'android-phone' | 'android-emulator' | 'linux-desktop' | 'ios';
  /** The app's directory. */
  appDir: string;
  /** The application identifier, e.g. com.ortusnova.lifedroid. */
  identifier: string;
  /** The Android package (the identifier as Android uses it). */
  androidPackage: string;
  /** The Linux binary's name. */
  binary: string;
  /** The app's `artifacts/` directory. */
  artifacts: string;
  /** This run's directory under `artifacts/devtest/`: screenshots and RESULTS.md go here. */
  runDir: string;
  /** The `dk` executable that started the run (for `dk run`, e.g. to reinstall). */
  dk: string;
  android: { adb: string; host: string; hostRoot: string; phone?: string };
  linux: { image: string };
}

/** What a driver module exports. */
export type CreateDriver = (context: TestContext) => Promise<Driver>;

/** Run scenarios on a driver. Never throws for a scenario's failure; it is in the result. */
export function runScenarios(driver: Driver, list: { file: string; scenario: Scenario }[], options?: { only?: string }): Promise<ScenarioResult[]>;

/** The results as Markdown: a summary table, then each scenario's steps. */
export function resultsMarkdown(info: RunInfo, results: ScenarioResult[]): string;
