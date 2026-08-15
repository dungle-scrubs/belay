import type { ArtifactRef } from "@belay/session";

export const ARTIFACT_PANEL_LAYOUTS = ["push", "replace", "overlap"] as const;
export type ArtifactPanelLayout = (typeof ARTIFACT_PANEL_LAYOUTS)[number];

export const ARTIFACT_PANEL_WIDTH = {
  default: 520,
  max: 860,
  min: 360,
} as const;

export interface ArtifactPanelLayoutPreference {
  readonly layout: ArtifactPanelLayout;
  readonly width: number;
}

export interface ArtifactPanelState {
  readonly selectedArtifactId: string | null;
  readonly open: boolean;
  readonly preference: ArtifactPanelLayoutPreference;
}

export interface ArtifactPanelOpenInput {
  readonly artifact: ArtifactRef;
  readonly layout?: ArtifactPanelLayout;
  readonly width?: number;
}

export function artifactId(artifact: ArtifactRef): string {
  return `${artifact.kind}:${artifact.hash}`;
}

export function clampArtifactPanelWidth(width: number): number {
  return Math.min(ARTIFACT_PANEL_WIDTH.max, Math.max(ARTIFACT_PANEL_WIDTH.min, Math.round(width)));
}

export function createArtifactPanelState(
  preference: Partial<ArtifactPanelLayoutPreference> = {},
): ArtifactPanelState {
  return {
    selectedArtifactId: null,
    open: false,
    preference: {
      layout: preference.layout ?? "push",
      width: clampArtifactPanelWidth(preference.width ?? ARTIFACT_PANEL_WIDTH.default),
    },
  };
}

export function openArtifactPanel(
  state: ArtifactPanelState,
  input: ArtifactPanelOpenInput,
): ArtifactPanelState {
  return {
    selectedArtifactId: artifactId(input.artifact),
    open: true,
    preference: {
      layout: input.layout ?? state.preference.layout,
      width: clampArtifactPanelWidth(input.width ?? state.preference.width),
    },
  };
}

export function closeArtifactPanel(state: ArtifactPanelState): ArtifactPanelState {
  return { ...state, open: false };
}

export function resetArtifactPanelPreference(state: ArtifactPanelState): ArtifactPanelState {
  return {
    ...state,
    preference: {
      layout: "push",
      width: ARTIFACT_PANEL_WIDTH.default,
    },
  };
}

export function resizeArtifactPanel(state: ArtifactPanelState, width: number): ArtifactPanelState {
  const nextWidth = clampArtifactPanelWidth(width);
  if (nextWidth === state.preference.width) {
    return state;
  }
  return {
    ...state,
    preference: {
      ...state.preference,
      width: nextWidth,
    },
  };
}

export function setArtifactPanelLayout(
  state: ArtifactPanelState,
  layout: ArtifactPanelLayout,
): ArtifactPanelState {
  return {
    ...state,
    preference: {
      ...state.preference,
      layout,
    },
  };
}

export function selectedArtifact(
  artifacts: readonly ArtifactRef[],
  state: ArtifactPanelState,
): ArtifactRef | null {
  if (!state.open || state.selectedArtifactId === null) {
    return null;
  }
  return artifacts.find((artifact) => artifactId(artifact) === state.selectedArtifactId) ?? null;
}
