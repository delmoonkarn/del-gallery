import { useState } from "react";
import { api } from "../api";

type Props = {
  folderId: number;
  rating: number;
  favorite: boolean;
  /** Called with the saved values so the parent can update its row. */
  onChange?: (v: { rating: number; favorite: boolean }) => void;
  size?: "sm" | "md";
};

/**
 * ★★★☆☆ + ♥ for one folder. Clicking the current star count clears it.
 * Saved straight away (into the cover's XMP when possible, see meta.ts).
 */
export default function RatingControl({ folderId, rating, favorite, onChange, size = "md" }: Props) {
  const [hover, setHover] = useState(0);
  const [busy, setBusy] = useState(false);
  const shown = hover || rating;
  const text = size === "sm" ? "text-sm" : "text-base";

  const save = async (patch: { rating?: number; favorite?: boolean }) => {
    setBusy(true);
    try {
      await api.setMeta(folderId, patch);
      onChange?.({ rating: patch.rating ?? rating, favorite: patch.favorite ?? favorite });
    } catch (e) {
      alert(`Could not save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`flex items-center gap-1.5 ${busy ? "opacity-50 pointer-events-none" : ""}`}>
      <div className={`flex leading-none ${text}`} onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onMouseEnter={() => setHover(n)}
            onClick={(e) => {
              e.stopPropagation();
              save({ rating: n === rating ? 0 : n });
            }}
            className={`px-px transition ${n <= shown ? "text-amber-400" : "text-neutral-600 hover:text-neutral-400"}`}
            title={n === rating ? "Clear rating" : `${n} star${n === 1 ? "" : "s"}`}
          >
            ★
          </button>
        ))}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          save({ favorite: !favorite });
        }}
        className={`${text} leading-none transition ${favorite ? "text-rose-500" : "text-neutral-600 hover:text-rose-400"}`}
        title={favorite ? "Remove from favourites" : "Add to favourites"}
      >
        {favorite ? "♥" : "♡"}
      </button>
    </div>
  );
}
