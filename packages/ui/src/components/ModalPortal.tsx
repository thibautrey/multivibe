import type { ReactNode } from "react";
import { createPortal } from "react-dom";

// Keep viewport overlays outside animated or transformed workspace containers.
export default function ModalPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
