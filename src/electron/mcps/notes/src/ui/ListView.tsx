/**
 * ListView Component
 *
 * Displays a searchable list of all notes with polling for updates.
 * Handles empty state with a prompt to create the first note.
 *
 * Uses NotesContext to access state and actions directly,
 * eliminating the need for prop drilling.
 */

import { useEffect, useState, useMemo } from "react";
import { useNotesContext } from "./useNotes";

/**
 * Format a date string as relative time (e.g., "5m ago", "2h ago").
 */
const formatRelativeTime = (dateStr: string): string => {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
};

/**
 * List view showing all notes with search/filter.
 * Polls for updates every 5 seconds.
 */
export function ListView() {
  const { notes, openNote, createNote, refreshList } = useNotesContext();
  const [search, setSearch] = useState("");

  /**
   * Poll for new notes every 5 seconds.
   * Silent - no logging to keep console clean.
   */
  useEffect(() => {
    const interval = setInterval(() => {
      refreshList();
    }, 5000);
    return () => clearInterval(interval);
  }, [refreshList]);

  /**
   * Filter notes by search query (case-insensitive title match).
   */
  const filteredNotes = useMemo(() => {
    if (!search.trim()) return notes;
    const query = search.toLowerCase();
    return notes.filter((n) => n.title.toLowerCase().includes(query));
  }, [notes, search]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-primary text-txt-primary">
      <header className="flex items-center justify-between py-3 px-4 border-b border-bdr-secondary shrink-0">
        <h1 className="text-lg font-medium text-txt-primary m-0">Notes</h1>
        <button
          className="bg-txt-primary text-txt-inverse border-none py-1.5 px-3 rounded-md text-sm font-medium cursor-pointer hover:opacity-90"
          onClick={createNote}
        >
          + New Note
        </button>
      </header>

      <div className="py-3 px-4 border-b border-bdr-secondary shrink-0">
        <div className="relative w-full">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 text-txt-tertiary w-3 h-3 pointer-events-none"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            className="w-full py-2 pl-8 pr-3 bg-bg-secondary border border-bdr-secondary rounded-md text-sm text-txt-primary outline-none placeholder:text-txt-tertiary"
            placeholder="Search notes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {filteredNotes.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-txt-secondary p-8 text-center">
          {notes.length === 0 ? (
            <>
              <p className="mb-4">No notes yet</p>
              <button
                className="bg-txt-primary text-txt-inverse border-none py-3 px-6 rounded-md text-base font-medium cursor-pointer hover:opacity-90"
                onClick={createNote}
              >
                Create your first note
              </button>
            </>
          ) : (
            <p>No notes match "{search}"</p>
          )}
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto list-none m-0 p-0">
          {filteredNotes.map((note) => (
            <li
              key={note.id}
              className="flex justify-between items-center py-3 px-4 border-b border-bdr-tertiary cursor-pointer hover:bg-bg-secondary"
              onClick={() => openNote(note.id)}
            >
              <span className="text-base text-txt-primary flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {note.title || "Untitled"}
              </span>
              <span className="text-xs text-txt-tertiary shrink-0 ml-3">
                {formatRelativeTime(note.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
