import React, { useLayoutEffect, useRef } from "react";
import { fitFontSize } from "../../lib/fitText";

type Props = Omit<React.HTMLAttributes<HTMLDivElement>, "style"> & {
  /** Smallest font size, in px, before the text falls back to an ellipsis. */
  minFontSize?: number;
};

function textWidth(element: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  const width = range.getBoundingClientRect().width;
  range.detach?.();
  return width;
}

function contentWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return element.getBoundingClientRect().width - padding;
}

/**
 * Keeps one line of text inside its box by shrinking the font size instead of
 * clipping it. The base size always comes from the stylesheet, so custom widget
 * sizes and layout changes are measured fresh.
 */
export function FitText({ children, className, minFontSize = 14, ...rest }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let observedWidth = -1;

    const fit = () => {
      element.style.fontSize = "";
      const available = contentWidth(element);
      if (available <= 0) return;
      observedWidth = available;
      const base = parseFloat(getComputedStyle(element).fontSize);
      if (!Number.isFinite(base) || base <= 0) return;

      const apply = (size: number) => {
        element.style.fontSize = size < base ? `${size}px` : "";
      };

      let size = fitFontSize({ textWidth: textWidth(element), availableWidth: available, fontSize: base, minFontSize });
      apply(size);
      let measured = textWidth(element);
      // Width scales linearly with the font size, but rounded glyph metrics can leave a sliver of overflow.
      for (let attempt = 0; attempt < 3 && measured > available && size > minFontSize; attempt += 1) {
        size = fitFontSize({ textWidth: measured, availableWidth: available * 0.998, fontSize: size, minFontSize });
        apply(size);
        measured = textWidth(element);
      }
      if (measured > available) element.title = element.textContent ?? "";
      else element.removeAttribute("title");
    };

    fit();
    const observer = new ResizeObserver(() => {
      if (Math.abs(contentWidth(element) - observedWidth) > 0.5) fit();
    });
    observer.observe(element);
    void document.fonts?.ready.then(fit).catch(() => {});
    return () => observer.disconnect();
  }, [children, minFontSize]);

  return <div ref={ref} className={className} {...rest}>{children}</div>;
}
