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
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useHost } from "open-mcp-app/react";
import {
  AppLayout,
  Heading,
  Text,
  Button,
  Input,
} from "open-mcp-app-ui";
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
  const { hostContext } = useHost();
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
    <AppLayout displayMode={hostContext?.displayMode} noPadding className="h-full">
      <div className="flex flex-col h-full overflow-hidden">
        <header className="p-4 border-b border-bdr-secondary shrink-0">
          <Heading level={2} size="sm" className="mb-3">Notes</Heading>
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <MagnifyingGlass
                size={12}
                weight="regular"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-txt-tertiary z-[1]"
              />
              <Input
                type="text"
                className="pl-8"
                placeholder="Search notes..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                size="md"
              />
            </div>
            <Button variant="primary" size="md" onClick={createNote}>
              New Note
            </Button>
          </div>
        </header>

        {filteredNotes.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-txt-secondary p-8 text-center">
            {notes.length === 0 ? (
              <>
                <Text variant="secondary" className="mb-4">No notes yet</Text>
                <Button variant="primary" size="lg" onClick={createNote}>
                  Create your first note
                </Button>
              </>
            ) : (
              <Text variant="secondary">No notes match &ldquo;{search}&rdquo;</Text>
            )}
          </div>
        ) : (
          <ul className="flex-1 overflow-y-auto list-none m-0 p-0">
            {filteredNotes.map((note) => (
              <li
                key={note.id}
                className="flex justify-between items-center py-3 px-4 border-b border-bdr-secondary cursor-pointer hover:bg-bg-secondary"
                onClick={() => openNote(note.id)}
              >
                <Text as="span" size="sm" className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {note.title || "Untitled"}
                </Text>
                <Text as="span" size="sm" variant="tertiary" className="shrink-0 ml-3">
                  {formatRelativeTime(note.updatedAt)}
                </Text>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppLayout>
  );
}
