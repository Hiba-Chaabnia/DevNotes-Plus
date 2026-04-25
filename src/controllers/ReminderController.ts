import * as vscode from 'vscode';
import { NoteStorage } from '../services/NoteStorage';

/**
 * Checks notes with a remindAt timestamp every minute and fires VS Code
 * notifications when they come due.
 *
 * Notification actions:
 *   Open          — opens the note in the rich editor; reminder stays set
 *   Snooze 1h     — pushes remindAt forward by one hour
 *   Snooze tomorrow — pushes remindAt to 9 AM the following day
 *   Dismiss       — clears remindAt entirely
 *
 * If the user closes the notification popup without clicking any action,
 * the reminder is automatically snoozed by one hour to prevent it from
 * re-firing on the very next tick.
 *
 * The inFlight set prevents the same note from spawning duplicate
 * notification dialogs while the user is still deciding on a previous one.
 */
export class ReminderController implements vscode.Disposable {
  private readonly timer: NodeJS.Timeout;
  private readonly inFlight = new Set<string>(); // note IDs with an open notification

  constructor(
    private readonly storage: NoteStorage,
    private readonly onUpdate: () => void,
  ) {
    this.check();
    this.timer = setInterval(() => this.check(), 60_000);
  }

  /** Called by extension when notes change externally so we re-evaluate. */
  refresh(): void { this.check(); }

  private check(): void {
    const now = Date.now();
    const due = this.storage.getNotes().filter(
      n => n.remindAt !== undefined && n.remindAt <= now && !this.inFlight.has(n.id)
    );
    for (const note of due) {
      this.inFlight.add(note.id);
      this.fire(note.id, note.title).finally(() => this.inFlight.delete(note.id));
    }
  }

  private async fire(noteId: string, title: string): Promise<void> {
    const action = await vscode.window.showInformationMessage(
      `DevNote: "${title}"`,
      'Open', 'Snooze 1h', 'Snooze tomorrow', 'Dismiss'
    );

    const now = Date.now();

    if (action === 'Open') {
      vscode.commands.executeCommand('devnotes.focusNote', noteId);
      // Keep the reminder set so the user doesn't lose it
      return;
    }

    if (action === 'Snooze 1h') {
      await this.storage.updateNote(noteId, { remindAt: now + 60 * 60 * 1_000 });
    } else if (action === 'Snooze tomorrow') {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      await this.storage.updateNote(noteId, { remindAt: tomorrow.getTime() });
    } else if (action === 'Dismiss') {
      await this.storage.updateNote(noteId, { remindAt: undefined });
    } else {
      // User dismissed the popup without clicking — snooze 1h to avoid spam
      await this.storage.updateNote(noteId, { remindAt: now + 60 * 60 * 1_000 });
    }

    this.onUpdate();
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
