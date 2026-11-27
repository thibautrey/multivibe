export type FitTextMetrics = {
  /** Rendered width of the text, in px, at the current font size. */
  textWidth: number;
  /** Horizontal space available inside the box, in px. */
  availableWidth: number;
  /** Font size currently applied by the stylesheet, in px. */
  fontSize: number;
  /** Smallest accepted font size, in px. */
  minFontSize: number;
};

/** Largest font size, no bigger than the stylesheet one, that lets the text fit on one line. */
export function fitFontSize({ textWidth, availableWidth, fontSize, minFontSize }: FitTextMetrics): number {
  if (!(textWidth > 0) || !(availableWidth > 0) || !(fontSize > 0)) return fontSize;
  if (textWidth <= availableWidth) return fontSize;
  const scaled = (fontSize * availableWidth) / textWidth;
  return Math.max(Math.min(minFontSize, fontSize), Math.min(fontSize, scaled));
}
