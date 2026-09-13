import { activeSkinName, type SkinName } from "../internal/presentation/skin.ts";

export type Fg = (key: any, text: string) => string;

export interface LandingBlock {
  rows: string[];
  blockWidth: number;
}

export interface ObservatoryLandingView {
  seed: string;
  contextFill?: number;
}

export interface ObservatoryLanding {
  prelude(fg: Fg, width: number, view: ObservatoryLandingView): string[];
  logo(fg: Fg, width: number, active: boolean): LandingBlock;
  invitation(fg: Fg, width: number): string;
}

const landings = new Map<SkinName, ObservatoryLanding>();

export function registerObservatoryLanding(skin: SkinName, landing: ObservatoryLanding): void {
  landings.set(skin, landing);
}

export function observatoryLandingFor(skin: SkinName = activeSkinName()): ObservatoryLanding | undefined {
  return landings.get(skin);
}
