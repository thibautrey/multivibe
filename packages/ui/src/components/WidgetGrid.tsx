import React, { useRef, useState } from "react";
import { normalizeWidgets, moveWidget, type WidgetLayout, type WidgetDefinition } from "../lib/widgetLayout";
import { useT } from "../i18n";
import "./WidgetGrid.css";

type WidgetProps = { widgetId: string; title: string; required?: boolean; action?: { href: string; label: string } };
type Props = { storageKey: string; label: string; children: React.ReactNode };

export function WidgetGrid({ storageKey, label, children }: Props) {
  const t = useT();
  const widgets = React.Children.toArray(children) as React.ReactElement<WidgetProps>[];
  const definitions: WidgetDefinition[] = widgets.map(({ props }) => ({ id: props.widgetId, required: props.required }));
  const key = `multivibe.widgets.v1.${storageKey}`;
  const [saved, setSaved] = useState<WidgetLayout[]>(() => {
    try { return normalizeWidgets(definitions, JSON.parse(localStorage.getItem(key) ?? "null")); }
    catch { return normalizeWidgets(definitions, null); }
  });
  const [draft, setDraft] = useState<WidgetLayout[] | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const editButton = useRef<HTMLButtonElement>(null);
  const layout = normalizeWidgets(definitions, draft ?? saved);
  const visible = layout.filter((item) => item.visible);
  const editing = draft !== null;
  const update = (id: string, patch: Partial<WidgetLayout>) => setDraft(layout.map((item) => item.id === id ? { ...item, ...patch } : item));
  const finish = () => { setDraft(null); setDragged(null); setOver(null); editButton.current?.focus(); };
  const save = () => {
    try {
      localStorage.setItem(key, JSON.stringify(layout));
      setSaved(layout);
      setMessage(t("Widget layout saved for this browser."));
      finish();
    } catch { setMessage(t("Could not save your layout. Browser storage is unavailable. Try again or cancel.")); }
  };
  const move = (id: string, target: string) => {
    setDraft(moveWidget(layout, id, target));
    setMessage(t("{title} moved.", { title: widgets.find((widget) => widget.props.widgetId === id)?.props.title ?? "" }));
  };

  return (
    <section className={`widget-board ${editing ? "widget-board-editing" : ""}`} aria-label={label} onKeyDown={(event) => {
      if (editing && event.key === "Escape") { event.stopPropagation(); finish(); }
    }}>
      <div className="widget-toolbar">
        <div><span className="eyebrow">{editing ? t("Edit widgets") : label}</span>{editing && <p>{t("Reorder, resize, or hide widgets.")}</p>}</div>
        <div className="widget-toolbar-actions">
          {editing ? <>
            <button type="button" className="btn secondary" onClick={() => setDraft(normalizeWidgets(definitions, null))}>{t("Reset")}</button>
            <button type="button" className="btn secondary" onClick={finish}>{t("Cancel")}</button>
            <button type="button" className="btn" onClick={save}>{t("Save changes")}</button>
          </> : <button ref={editButton} type="button" className="btn widget-customize" onClick={() => { setDraft(layout); setMessage(""); }}><span aria-hidden="true">▦</span> {t("Customize widgets")}</button>}
        </div>
      </div>
      <div className="widget-grid">
        {visible.map((item, index) => {
          const widget = widgets.find((entry) => entry.props.widgetId === item.id)!;
          return <article key={item.id} className={`widget-tile widget-size-${item.size} ${over === item.id ? "widget-drop-target" : ""} ${dragged === item.id ? "widget-dragging" : ""}`}
            onDragOver={(event) => { if (editing && dragged && dragged !== item.id) { event.preventDefault(); setOver(item.id); } }}
            onDrop={(event) => { event.preventDefault(); if (editing && dragged) move(dragged, item.id); setDragged(null); setOver(null); }}>
            {editing && <div className="widget-edit-header">
              <button type="button" className="widget-grip" draggable aria-label={t("Drag {title} to reorder", { title: widget.props.title })} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); setDragged(item.id); }} onDragEnd={() => { setDragged(null); setOver(null); }}>⠿</button>
              <strong className="widget-edit-title">{widget.props.title}</strong>
              {widget.props.required ? <span className="widget-required">{t("Required")}</span> : <button type="button" className="widget-remove" aria-label={t("Hide {title}", { title: widget.props.title })} onClick={() => update(item.id, { visible: false })}>{t("Hide")}</button>}
            </div>}
            {!editing && widget}
            {editing && <div className="widget-edit-footer">
              <label className="widget-size-select">{t("Size")}<select aria-label={t("Size of {title}", { title: widget.props.title })} value={item.size} onChange={event => update(item.id, { size: event.target.value as WidgetLayout["size"] })}><option value="small">{t("Small")}</option><option value="medium">{t("Medium")}</option><option value="large">{t("Large")}</option></select></label>
              <div className="widget-move-actions">
                <button type="button" aria-label={t("Move {title} earlier", { title: widget.props.title })} disabled={index === 0} onClick={() => move(item.id, visible[index - 1].id)}>←</button>
                <button type="button" aria-label={t("Move {title} later", { title: widget.props.title })} disabled={index === visible.length - 1} onClick={() => move(item.id, visible[index + 1].id)}>→</button>
              </div>
            </div>}
          </article>;
        })}
      </div>
      {!visible.length && <div className="widget-empty">{t("Your space, your choice. Use Customize widgets to add metrics.")}</div>}
      {editing && layout.some(item => !item.visible) && <aside className="widget-gallery" aria-label={t("Widget gallery")}>
        <h3>{t("Hidden widgets")}</h3>
        <div className="widget-gallery-grid">{layout.filter(item => !item.visible).map((item) => {
          const widget = widgets.find((entry) => entry.props.widgetId === item.id)!;
          return <button type="button" key={item.id} className={`widget-gallery-item ${item.visible ? "widget-gallery-added" : ""}`} disabled={item.visible} onClick={() => update(item.id, { visible: true })} aria-label={t("Add {title}", { title: widget.props.title })}>
            <span className="widget-gallery-caption"><strong>{widget.props.title}</strong><span>{widget.props.required ? t("Required") : item.visible ? t("✓ Added") : t("+ Add widget")}</span></span>
          </button>;
        })}</div>
      </aside>}
      <span className="widget-message" role="status">{message}</span>
    </section>
  );
}
