import { useEffect, useRef, useState } from "react";

export interface MentionItem {
  label: string;
  value: string;
  sublabel?: string;
}

interface Props {
  open: boolean;
  items: MentionItem[];
  onSelect: (item: MentionItem) => void;
  onClose: () => void;
}

export function MentionPopup({ open, items, onSelect, onClose }: Props) {
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCursor(0);
  }, [items]);

  useEffect(() => {
    if (!open) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (items[cursor]) onSelect(items[cursor]!);
      } else if (e.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, items, cursor, onSelect, onClose]);

  if (!open || items.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 mb-2 w-64 rounded-lg border border-border bg-popover shadow-lg z-50 overflow-hidden"
    >
      {items.map((item, i) => (
        <button
          key={item.value}
          type="button"
          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-accent transition-colors ${
            i === cursor ? "bg-accent" : ""
          }`}
          onClick={() => onSelect(item)}
          onMouseEnter={() => setCursor(i)}
        >
          <span className="font-medium truncate">{item.label}</span>
          {item.sublabel && (
            <span className="text-xs text-muted-foreground truncate">{item.sublabel}</span>
          )}
        </button>
      ))}
    </div>
  );
}
