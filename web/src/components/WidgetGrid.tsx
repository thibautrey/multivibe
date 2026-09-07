import React, { useRef, useState } from "react";
import { normalizeWidgets, moveWidget, type WidgetLayout, type WidgetDefinition } from "../lib/widgetLayout";
import "./WidgetGrid.css";

type WidgetProps = { widgetId: string; title: string; required?: boolean };
type Props = { storageKey: string; label: string; children: React.ReactElement<WidgetProps>[] };

export function WidgetGrid({ storageKey, label, children }: Props) {
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
      setMessage("Widget layout saved for this browser.");
      finish();
    } catch { setMessage("Could not save your layout. Browser storage is unavailable. Try again or cancel."); }
  };
  const move = (id: string, target: string) => {
    setDraft(moveWidget(layout, id, target));
    setMessage(`${widgets.find((widget) => widget.props.widgetId === id)?.props.title} moved.`);
  };

  return (
    <section className={`widget-board ${editing ? "widget-board-editing" : ""}`} aria-label={label} onKeyDown={(event) => {
      if (editing && event.key === "Escape") { event.stopPropagation(); finish(); }
    }}>
      <div className="widget-toolbar">
        <div><span className="eyebrow">{editing ? "MAKE IT YOURS" : label}</span>{editing && <p>Drag to arrange. Pick a size. Keep what matters to you.</p>}</div>
        <div className="widget-toolbar-actions">
          {editing ? <>
            <button type="button" className="btn btn-secondary" onClick={() => setDraft(normalizeWidgets(definitions, null))}>Reset layout</button>
            <button type="button" className="btn btn-secondary" onClick={finish}>Cancel</button>
            <button type="button" className="btn" onClick={save}>Done</button>
          </> : <button ref={editButton} type="button" className="btn widget-customize" onClick={() => { setDraft(layout); setMessage(""); }}><span aria-hidden="true">▦</span> Customize widgets</button>}
        </div>
      </div>
      <div className="widget-grid">
        {visible.map((item, index) => {
          const widget = widgets.find((entry) => entry.props.widgetId === item.id)!;
          return <article key={item.id} className={`widget-tile widget-size-${item.size} ${over === item.id ? "widget-drop-target" : ""} ${dragged === item.id ? "widget-dragging" : ""}`}
            onDragOver={(event) => { if (editing && dragged && dragged !== item.id) { event.preventDefault(); setOver(item.id); } }}
            onDrop={(event) => { event.preventDefault(); if (editing && dragged) move(dragged, item.id); setDragged(null); setOver(null); }}>
            {editing && <div className="widget-edit-header">
              <button type="button" className="widget-grip" draggable aria-label={`Drag ${widget.props.title} to reorder`} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); setDragged(item.id); }} onDragEnd={() => { setDragged(null); setOver(null); }}>⠿</button>
              {widget.props.required ? <span className="widget-required">Required</span> : <button type="button" className="widget-remove" aria-label={`Hide ${widget.props.title}`} onClick={() => update(item.id, { visible: false })}>−</button>}
            </div>}
            {widget}
            {editing && <div className="widget-edit-footer">
              <div className="widget-sizes" role="group" aria-label={`Size of ${widget.props.title}`}>
                {(["small", "medium", "large"] as const).map((size) => <button type="button" key={size} aria-label={`${widget.props.title}: ${size}`} aria-pressed={item.size === size} onClick={() => update(item.id, { size })}><span aria-hidden="true" className={`widget-size-icon widget-size-icon-${size}`} />{size === "small" ? "S" : size === "medium" ? "M" : "L"}</button>)}
              </div>
              <div className="widget-move-actions">
                <button type="button" aria-label={`Move ${widget.props.title} earlier`} disabled={index === 0} onClick={() => move(item.id, visible[index - 1].id)}>←</button>
                <button type="button" aria-label={`Move ${widget.props.title} later`} disabled={index === visible.length - 1} onClick={() => move(item.id, visible[index + 1].id)}>→</button>
              </div>
            </div>}
          </article>;
        })}
      </div>
      {!visible.length && <div className="widget-empty">Your space, your choice. Use Customize widgets to add metrics.</div>}
      {editing && <aside className="widget-gallery" aria-label="Widget gallery">
        <div><span className="eyebrow">WIDGET GALLERY</span><h3>A little more insight.</h3><p className="muted">Add a metric to your space. Required widgets always stay visible.</p></div>
        <div className="widget-gallery-grid">{layout.map((item) => {
          const widget = widgets.find((entry) => entry.props.widgetId === item.id)!;
          return <button type="button" key={item.id} className={`widget-gallery-item ${item.visible ? "widget-gallery-added" : ""}`} disabled={item.visible} onClick={() => update(item.id, { visible: true })} aria-label={`Add ${widget.props.title}`}>
            <div className="widget-gallery-preview" aria-hidden="true">{widget}</div>
            <span className="widget-gallery-caption"><strong>{widget.props.title}</strong><span>{widget.props.required ? "Required" : item.visible ? "✓ Added" : "+ Add widget"}</span></span>
          </button>;
        })}</div>
      </aside>}
      <span className="widget-message" role="status">{message}</span>
    </section>
  );
}
