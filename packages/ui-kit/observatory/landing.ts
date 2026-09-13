import { activeSkinName, type SkinName } from "../internal/presentation/skin.ts";
import { uiKitShared } from "../once.ts";

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

function landingsMap(): Map<SkinName, ObservatoryLanding> {
  return uiKitShared().landings as Map<SkinName, ObservatoryLanding>;
}

export function registerObservatoryLanding(skin: SkinName, landing: ObservatoryLanding): void {
  landingsMap().set(skin, landing);
}

export function observatoryLandingFor(skin: SkinName = activeSkinName()): ObservatoryLanding | undefined {
  return landingsMap().get(skin);
}
