export type VisualPanelHardeningMode = "inGame" | "full";

let mode: VisualPanelHardeningMode = "inGame";

export const getVisualPanelHardeningMode = (): VisualPanelHardeningMode => mode;

export const setVisualPanelHardeningMode = (
  next: VisualPanelHardeningMode
): void => {
  mode = next;
};

export const isRhsFullHardeningEnabled = (): boolean => mode === "full";
