export function isDemoMode(search?: string): boolean;
export function initialBroadcastData(search?: string): any | null;
export function callDeadline(calledAt: string | null | undefined): string | null;
export function formatCallCountdown(calledAt: string | null | undefined, now?: number): string;
export function panelSetChanged(previousSignature: string, enabled: string[]): boolean;
export function steppedPanelIndex(index: number, direction: number, panelCount: number): number;
export function mapApiBroadcastData(state?: any, championship?: any, flair?: any): any;
export function createAudioPreferences(storage: Pick<Storage, "getItem" | "setItem"> | null): {
  read(): { volume: number; muted: boolean; quiet: boolean };
  setVolume(value: number | string): void;
  setMuted(value: boolean): void;
  setQuiet(value: boolean): void;
};
export function createAnnouncementController(options: {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  speak(text: string): void;
  sting(kind: "call" | "result"): boolean | Promise<boolean>;
  now?: () => number;
  preferences?: ReturnType<typeof createAudioPreferences> | null;
}): { observe(data: any): Promise<void> };
